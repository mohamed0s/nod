import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { appConfirmation } from '../ports/agent.ts';
import type { Artifact } from '../shared/contracts.ts';
import { fileBytes, fileName } from '../shared/files.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import {
  cvMimeTypes,
  defaultJobProfile,
  jobLimitFields,
  jobPlaceholders,
  jobPortalsSchema,
  jobProfileFields,
  jobProfilePatch,
  jobProfileSchema,
  jobTemplateSchema,
  unknownPlaceholders,
  type JobCv,
  type JobProfile,
  type JobProfileView,
  type JobRevision,
  type JobSetup,
  type JobTemplate,
  type JobTemplatesView,
} from '../shared/jobs.ts';
import type { ArtifactService } from './artifacts.ts';
import { careerOpsFiles } from './jobs-files.ts';
import { lockKey } from './locks.ts';
import { withdrawnSql } from './turn-chain.ts';
import { afterCommit, transaction } from './transaction.ts';

export const jobTables = `
  CREATE TABLE IF NOT EXISTS job_cvs (
    id uuid PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
    artifact_id uuid, pdf_artifact_id uuid, pdf_revision integer,
    markdown text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 0,
    is_main boolean NOT NULL DEFAULT false, conversion_session uuid,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_cvs_one_main ON job_cvs(owner_id) WHERE is_main AND archived_at IS NULL;
  CREATE INDEX IF NOT EXISTS job_cvs_owner ON job_cvs(owner_id,created_at);
  CREATE TABLE IF NOT EXISTS job_profile (
    owner_id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}', portals jsonb NOT NULL DEFAULT '{}',
    revision integer NOT NULL DEFAULT 0, templates_revision integer NOT NULL DEFAULT 0,
    synced jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS job_templates (
    id uuid PRIMARY KEY, owner_id text NOT NULL, language text NOT NULL, body text NOT NULL,
    greetings jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_templates_language ON job_templates(owner_id,language);
  CREATE TABLE IF NOT EXISTS job_revisions (
    id uuid PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('cv','profile')),
    cv_id uuid, revision integer NOT NULL, data jsonb NOT NULL,
    actor text NOT NULL CHECK (actor IN ('owner','nod')), created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS job_revisions_owner ON job_revisions(owner_id,kind,cv_id,created_at DESC);
  ALTER TABLE job_cvs ADD COLUMN IF NOT EXISTS conversion_started_at timestamptz;
`;

export const exampleTemplates: JobTemplate[] = [
  {
    language: 'en',
    body: "{greeting} {first_name},\n\nI'm {my_name}, {my_intro}. I'm applying for the {role} role at {company} through {programme} ({track}), and I'd be grateful for a referral if you're comfortable giving one.\n\nI can send my CV whenever it helps. Thank you for your time.",
    greetings: { default: 'Hi' },
  },
  {
    language: 'ar',
    body: '{greeting} {first_name}،\n\nأنا {my_name}، {my_intro}. أتقدم لوظيفة {role} في {company} ضمن {programme} (مسار {track})، وسيسعدني كثيرًا ترشيحكم لي إن كان ذلك مناسبًا.\n\nيمكنني إرسال سيرتي الذاتية في أي وقت. شكرًا جزيلًا على وقتكم.',
    greetings: { default: 'أهلاً' },
  },
];

export const conversionRequest = 'Convert the CV I just added for job search';

export function cvLabel(value: string) {
  return [
    ...value
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 80)
    .join('')
    .trim();
}

export const jobLimitsInput = z
  .object({
    inviteLimits: jobProfileFields.inviteLimits.partial().optional(),
    noLuck: jobProfileFields.noLuck.partial().optional(),
  })
  .strict()
  .refine((value) => value.inviteLimits !== undefined || value.noLuck !== undefined, {
    message: 'A limits change needs inviteLimits, noLuck or both.',
  });
type JobLimits = z.infer<typeof jobLimitsInput>;
type JobLimitValues = Pick<JobProfile, 'inviteLimits' | 'noLuck'>;

const liveLimits = (profile: JobProfile): JobLimitValues => ({
  inviteLimits: profile.inviteLimits,
  noLuck: profile.noLuck,
});

function limitsKey(value: unknown) {
  const limits = (value ?? {}) as Partial<{
    inviteLimits: Partial<JobLimitValues['inviteLimits']>;
    noLuck: Partial<JobLimitValues['noLuck']>;
  }>;
  return JSON.stringify([
    limits.inviteLimits?.daily,
    limits.inviteLimits?.weekly,
    limits.noLuck?.noAcceptDays,
    limits.noLuck?.noReplyDays,
  ]);
}

const folder = 'shared/career-ops';
const keptRevisions = 20;
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const label = z
  .string()
  .max(1000)
  .transform(cvLabel)
  .pipe(z.string().min(1, 'A CV label needs at least one visible character.'));
const markdown = z.string().trim().min(1).max(200_000);
const workspacePath = z.string().trim().min(1).max(4096);
const attachedId = (path: string) =>
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i
    .exec(posix.basename(path))?.[1]
    ?.toLowerCase();
const pdfPath = (id: string) => `${folder}/output/cv-${id}.pdf`;

const toolInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setup_status') }).strict(),
  z.object({ action: z.literal('sync'), force: z.boolean().optional() }).strict(),
  z
    .object({
      action: z.literal('cv_get'),
      id: z.uuid().optional(),
      workspaceFile: workspacePath.optional(),
    })
    .strict()
    .refine((value) => (value.id === undefined) !== (value.workspaceFile === undefined), {
      message: 'cv_get needs id or workspaceFile.',
    }),
  z.object({ action: z.literal('cv_file'), id: z.uuid().optional() }).strict(),
  z
    .object({
      action: z.literal('cv_save'),
      id: z.uuid(),
      markdown: markdown.optional(),
      pdf: z.literal(true).optional(),
      revision: z.int().min(0),
    })
    .strict()
    .refine((value) => (value.markdown === undefined) !== (value.pdf === undefined), {
      message:
        'cv_save takes markdown with the revision it read, or pdf:true with the revision the PDF was made from.',
    }),
  z
    .object({
      action: z.literal('profile_update'),
      profile: jobProfilePatch.optional(),
      portals: jobPortalsSchema.optional(),
    })
    .strict()
    .refine((value) => value.profile !== undefined || value.portals !== undefined, {
      message: 'profile_update needs profile, portals or both.',
    }),
  z
    .object({ action: z.literal('cv_add'), workspaceFile: workspacePath, label: label.optional() })
    .strict(),
  z
    .object({ action: z.literal('cv_main'), id: z.uuid().optional(), label: label.optional() })
    .strict()
    .refine((value) => (value.id === undefined) !== (value.label === undefined), {
      message: 'cv_main needs id or label.',
    }),
]);
const quietActions = new Set(['setup_status', 'cv_get', 'cv_file', 'sync']);

type Query = Pick<PoolClient, 'query'>;
type TurnRef = { threadId: string; turnId: string };
type Actor = 'owner' | 'nod';
type CvRow = {
  id: string;
  label: string;
  artifact_id: string | null;
  pdf_artifact_id: string | null;
  pdf_revision: number | null;
  markdown: string;
  revision: number;
  is_main: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  file_name: string | null;
  file_mime: string | null;
  pdf_name: string | null;
  converting: boolean;
};
type Synced = { thread?: string; files?: Record<string, string> };

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const path = issue.path.join('.');
  throw failure(`${what}${path ? ` (${path})` : ''}: ${issue.message}`);
}

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merged(base: Record<string, unknown>, patch: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries({ ...base, ...patch }).map(([key, value]) => [
      key,
      plain(base[key]) && plain(patch[key]) ? { ...base[key], ...patch[key] } : value,
    ]),
  );
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cvKind(name: string, mimeType: string) {
  if (Object.hasOwn(cvMimeTypes, mimeType)) return mimeType;
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return docx;
  return undefined;
}

function uploadedPdf(row: CvRow) {
  return Boolean(row.file_name && cvKind(row.file_name, row.file_mime ?? '') === 'application/pdf');
}

function cvView(row: CvRow): JobCv {
  const url = (id: string) => `/api/artifacts/${id}`;
  const original =
    row.artifact_id && row.file_name
      ? {
          id: row.artifact_id,
          name: row.file_name,
          mimeType: row.file_mime ?? '',
          url: url(row.artifact_id),
        }
      : null;
  return {
    id: row.id,
    label: row.label,
    isMain: row.is_main,
    status: row.markdown ? 'ready' : 'converting',
    revision: row.revision,
    markdown: row.markdown,
    file: original,
    pdf:
      original && uploadedPdf(row)
        ? { id: original.id, name: original.name, url: original.url }
        : row.pdf_artifact_id && row.pdf_name && row.pdf_revision === row.revision
          ? { id: row.pdf_artifact_id, name: row.pdf_name, url: url(row.pdf_artifact_id) }
          : null,
    pdfFile: pdfPath(row.id),
    converting: row.converting,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function withoutText(row: CvRow) {
  const { markdown: text, ...view } = cvView(row);
  return { ...view, markdownCharacters: text.length };
}

export function createJobs(options: {
  pool: Pool;
  ownerId: string;
  artifacts: Pick<ArtifactService, 'retainArtifacts' | 'readArtifact' | 'storeArtifact'>;
  workspace?: {
    write(threadId: string, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
    read(threadId: string, path: string, maxBytes: number): Promise<Uint8Array>;
    remove?(threadId: string, path: string, signal?: AbortSignal): Promise<void>;
  };
  startChat?: (text: string, attachments: Artifact[], sessionId: string) => Promise<unknown>;
  withTurnLock?: <T>(turnId: string, operation: (client: PoolClient) => Promise<T>) => Promise<T>;
  changed?: () => void;
}) {
  const { pool, ownerId } = options;
  const changed = options.changed ?? (() => {});
  const lock = (client: Query) => lockKey(client, `jobs:${ownerId}`);
  const owned = <T>(operation: (client: PoolClient) => Promise<T>) =>
    transaction(async (client) => {
      await lock(client);
      const value = await operation(client);
      afterCommit(client, changed);
      return value;
    }, pool);
  const turnWrite = <T>(turn: TurnRef, operation: (client: PoolClient) => Promise<T>) => {
    if (!options.withTurnLock) throw failure('Job records are unavailable in this runtime.', 503);
    return options.withTurnLock(turn.turnId, async (client) => {
      await lock(client);
      return operation(client);
    });
  };

  async function cvs(client: Query, filter: { id?: string; archived?: boolean } = {}) {
    const { rows } = await client.query<CvRow>(
      `SELECT c.*,a.name AS file_name,a.mime_type AS file_mime,p.name AS pdf_name,
         (c.conversion_session IS NOT NULL AND (
           EXISTS(SELECT 1 FROM tasks t WHERE t.owner_id=c.owner_id AND t.id=c.conversion_session AND t.state='open')
           OR (c.conversion_started_at>now()-interval '2 minutes'
             AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.owner_id=c.owner_id AND t.id=c.conversion_session))
         )) AS converting
       FROM job_cvs c
       LEFT JOIN artifacts a ON a.id=c.artifact_id AND a.owner_id=c.owner_id AND a.deleting_at IS NULL
       LEFT JOIN artifacts p ON p.id=c.pdf_artifact_id AND p.owner_id=c.owner_id AND p.deleting_at IS NULL
       WHERE c.owner_id=$1 AND ($2::uuid IS NULL OR c.id=$2) AND ($3 OR c.archived_at IS NULL)
       ORDER BY c.is_main DESC,c.created_at DESC,c.id`,
      [ownerId, filter.id ?? null, filter.archived ?? false],
    );
    return rows;
  }

  async function oneCv(client: Query, id: string, archived = false) {
    const row = (await cvs(client, { id: parse(z.uuid(), id, 'The CV id'), archived }))[0];
    if (!row) throw failure('CV not found.', 404);
    return row;
  }

  async function rootedIn(client: Query, turn: TurnRef) {
    const { rows } = await client.query<{ source: string; message_id: string | null }>(
      `WITH RECURSIVE lineage AS (
         SELECT id,parent_turn_id,source,message_id,0 AS depth FROM turns WHERE id=$1 AND owner_id=$2 AND thread_id=$3
         UNION ALL SELECT p.id,p.parent_turn_id,p.source,p.message_id,c.depth+1 FROM turns p
           JOIN lineage c ON c.parent_turn_id=p.id WHERE p.owner_id=$2 AND c.depth<100
       ) SELECT source,message_id FROM lineage ORDER BY depth DESC LIMIT 1`,
      [turn.turnId, ownerId, turn.threadId],
    );
    const root = rows[0];
    return root?.source === 'user' && root.message_id
      ? 'owner'
      : root?.source === 'schedule'
        ? 'schedule'
        : 'other';
  }

  async function ownerOnly(client: Query, turn: TurnRef, what: string) {
    if ((await rootedIn(client, turn)) !== 'owner')
      throw failure(`Only work started by an owner message can ${what}.`, 403);
  }

  async function expire(client: Query, ids: Array<string | null>, cvId: string) {
    const kept = ids.filter((id): id is string => Boolean(id));
    if (!kept.length) return;
    await client.query(
      `UPDATE artifacts a SET expires_at=clock_timestamp() WHERE a.owner_id=$1 AND a.id=ANY($2::uuid[]) AND a.deleting_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM job_cvs c WHERE c.owner_id=$1 AND c.id<>$3
           AND (c.artifact_id=a.id OR c.pdf_artifact_id=a.id))`,
      [ownerId, kept, cvId],
    );
  }

  async function snapshot(
    client: Query,
    kind: 'cv' | 'profile',
    cvId: string | null,
    revision: number,
    data: unknown,
    actor: Actor,
  ) {
    await client.query(
      'INSERT INTO job_revisions(id,owner_id,kind,cv_id,revision,data,actor) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), ownerId, kind, cvId, revision, JSON.stringify(data), actor],
    );
    await client.query(
      `DELETE FROM job_revisions WHERE owner_id=$1 AND kind=$2 AND cv_id IS NOT DISTINCT FROM $3::uuid
         AND id NOT IN (SELECT id FROM job_revisions WHERE owner_id=$1 AND kind=$2 AND cv_id IS NOT DISTINCT FROM $3::uuid
           ORDER BY created_at DESC,revision DESC LIMIT $4)`,
      [ownerId, kind, cvId, keptRevisions],
    );
  }

  async function revisions<T>(client: Query, kind: 'cv' | 'profile', cvId: string | null) {
    const { rows } = await client.query<{
      id: string;
      revision: number;
      actor: Actor;
      created_at: Date;
      data: T;
    }>(
      `SELECT id,revision,actor,created_at,data FROM job_revisions
       WHERE owner_id=$1 AND kind=$2 AND cv_id IS NOT DISTINCT FROM $3::uuid ORDER BY created_at DESC,revision DESC`,
      [ownerId, kind, cvId],
    );
    return rows.map((row): JobRevision<T> => ({
      id: row.id,
      revision: row.revision,
      actor: row.actor,
      createdAt: row.created_at.toISOString(),
      data: row.data,
    }));
  }

  async function oneRevision<T>(
    client: Query,
    kind: 'cv' | 'profile',
    cvId: string | null,
    id: string,
  ) {
    const found = (await revisions<T>(client, kind, cvId)).find(
      (entry) => entry.id === parse(z.uuid(), id, 'The revision id'),
    );
    if (!found) throw failure('That earlier version is no longer kept.', 404);
    return found;
  }

  async function profileState(client: Query) {
    const row = (
      await client.query<{
        data: Record<string, unknown>;
        portals: Record<string, unknown>;
        revision: number;
        templates_revision: number;
        synced: Synced;
      }>(
        'SELECT data,portals,revision,templates_revision,synced FROM job_profile WHERE owner_id=$1',
        [ownerId],
      )
    ).rows[0];
    const parsed = jobProfileSchema.safeParse(merged(defaultJobProfile, row?.data ?? {}));
    return {
      profile: parsed.success ? parsed.data : defaultJobProfile,
      portals: row?.portals ?? {},
      revision: row?.revision ?? 0,
      templatesRevision: row?.templates_revision ?? 0,
      synced: row?.synced ?? {},
    };
  }

  async function saveProfile(
    client: Query,
    change: { profile?: JobProfile; portals?: Record<string, unknown> },
    actor: Actor,
    expected?: number,
  ) {
    const current = await profileState(client);
    if (expected !== undefined && expected !== current.revision)
      throw failure(
        `The profile changed while you were editing it; it is now at version ${current.revision}. Reload it, then make your change again.`,
        409,
      );
    const profile = change.profile ?? current.profile;
    const portals = change.portals ?? current.portals;
    if (current.revision > 0 && same(profile, current.profile) && same(portals, current.portals))
      return current.revision;
    const { rows } = await client.query<{ revision: number }>(
      `INSERT INTO job_profile(owner_id,data,portals,revision) VALUES($1,$2,$3,1)
       ON CONFLICT (owner_id) DO UPDATE SET data=$2,portals=$3,revision=job_profile.revision+1,updated_at=now()
       RETURNING revision`,
      [ownerId, JSON.stringify(profile), JSON.stringify(portals)],
    );
    const revision = rows[0]!.revision;
    await snapshot(client, 'profile', null, revision, { profile, portals }, actor);
    return revision;
  }

  async function templates(client: Query): Promise<JobTemplatesView> {
    const { rows } = await client.query<JobTemplate & { revision: number }>(
      'SELECT language,body,greetings,revision FROM job_templates WHERE owner_id=$1 ORDER BY language',
      [ownerId],
    );
    const revision = (await profileState(client)).templatesRevision;
    return rows.length
      ? { templates: rows, examples: false, revision }
      : {
          templates: exampleTemplates.map((entry) => ({ ...entry, revision: 0 })),
          examples: true,
          revision,
        };
  }

  async function saveTemplates(client: Query, list: JobTemplate[], expected: number) {
    const languages = new Set<string>();
    for (const entry of list) {
      if (languages.has(entry.language))
        throw failure(`There are two ${entry.language} templates. Keep one per language.`);
      languages.add(entry.language);
      const unknown = unknownPlaceholders(entry.body);
      if (unknown.length)
        throw failure(
          `The ${entry.language} template uses ${unknown.map((name) => `{${name}}`).join(', ')}, which Nod can't fill. Use only ${jobPlaceholders.map((name) => `{${name}}`).join(' ')}.`,
        );
    }
    const current = (await profileState(client)).templatesRevision;
    if (expected !== current)
      throw failure(
        'The templates changed while you were editing them. Reload them, then make your change again.',
        409,
      );
    await client.query('DELETE FROM job_templates WHERE owner_id=$1 AND NOT (language=ANY($2))', [
      ownerId,
      list.map((entry) => entry.language),
    ]);
    for (const entry of list)
      await client.query(
        `INSERT INTO job_templates(id,owner_id,language,body,greetings) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (owner_id,language) DO UPDATE SET body=$4,greetings=$5,
           revision=job_templates.revision+CASE WHEN job_templates.body=$4 AND job_templates.greetings=$5::jsonb THEN 0 ELSE 1 END,
           updated_at=CASE WHEN job_templates.body=$4 AND job_templates.greetings=$5::jsonb THEN job_templates.updated_at ELSE now() END`,
        [randomUUID(), ownerId, entry.language, entry.body, JSON.stringify(entry.greetings)],
      );
    await client.query(
      `INSERT INTO job_profile(owner_id,templates_revision) VALUES($1,1)
       ON CONFLICT (owner_id) DO UPDATE SET templates_revision=job_profile.templates_revision+1`,
      [ownerId],
    );
  }

  async function setup(client: Query): Promise<JobSetup> {
    const main = (await cvs(client)).find((row) => row.is_main);
    const profile = await profileState(client);
    const saved = await client.query('SELECT 1 FROM job_templates WHERE owner_id=$1 LIMIT 1', [
      ownerId,
    ]);
    return {
      items: [
        { key: 'cv', done: Boolean(main?.markdown) },
        { key: 'profile', done: profile.revision > 0 },
        { key: 'templates', done: Boolean(saved.rowCount) },
      ],
      mainCv: main ? { id: main.id, label: main.label, status: cvView(main).status } : null,
    };
  }

  async function addCv(
    client: Query,
    artifact: { id: string; name: string; mime_type: string },
    name?: string,
  ) {
    if (!cvKind(artifact.name, artifact.mime_type))
      throw failure('A CV must be a PDF or a Word (.docx) file.');
    const existing = (
      await client.query<{ id: string }>(
        'SELECT id FROM job_cvs WHERE owner_id=$1 AND artifact_id=$2 AND archived_at IS NULL',
        [ownerId, artifact.id],
      )
    ).rows[0];
    if (existing) return { row: await oneCv(client, existing.id), added: false };
    await options.artifacts.retainArtifacts([artifact.id], client);
    const first = !(
      await client.query('SELECT 1 FROM job_cvs WHERE owner_id=$1 AND archived_at IS NULL', [
        ownerId,
      ])
    ).rowCount;
    const id = randomUUID();
    await client.query(
      'INSERT INTO job_cvs(id,owner_id,label,artifact_id,is_main) VALUES($1,$2,$3,$4,$5)',
      [
        id,
        ownerId,
        cvLabel(name ?? artifact.name.replace(/\.[^.]+$/, '')) || 'CV',
        artifact.id,
        first,
      ],
    );
    return { row: await oneCv(client, id), added: true };
  }

  async function makeMain(client: Query, id: string) {
    const row = await oneCv(client, id);
    if (row.is_main) return row;
    await client.query('UPDATE job_cvs SET is_main=false WHERE owner_id=$1 AND is_main', [ownerId]);
    await client.query(
      'UPDATE job_cvs SET is_main=true,updated_at=now() WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL',
      [row.id, ownerId],
    );
    return oneCv(client, row.id);
  }

  async function promote(client: Query) {
    await client.query(
      `UPDATE job_cvs SET is_main=true WHERE id=(SELECT id FROM job_cvs WHERE owner_id=$1 AND archived_at IS NULL
         ORDER BY updated_at DESC,id LIMIT 1) AND owner_id=$1
         AND NOT EXISTS (SELECT 1 FROM job_cvs WHERE owner_id=$1 AND is_main AND archived_at IS NULL)`,
      [ownerId],
    );
  }

  async function archive(client: Query, id: string) {
    const row = await oneCv(client, id);
    await client.query(
      'UPDATE job_cvs SET archived_at=now(),is_main=false,updated_at=now() WHERE id=$1 AND owner_id=$2',
      [row.id, ownerId],
    );
    if (row.is_main) await promote(client);
  }

  async function remove(client: Query, id: string) {
    const row = await oneCv(client, id, true);
    await expire(client, [row.artifact_id, row.pdf_artifact_id], row.id);
    await client.query('DELETE FROM job_revisions WHERE owner_id=$1 AND cv_id=$2', [
      ownerId,
      row.id,
    ]);
    await client.query('DELETE FROM job_cvs WHERE id=$1 AND owner_id=$2', [row.id, ownerId]);
    if (row.is_main) await promote(client);
  }

  async function editCv(
    client: Query,
    id: string,
    change: { label?: string; markdown?: string; revision?: number },
    actor: Actor,
  ) {
    const row = await oneCv(client, id);
    if (change.revision !== undefined && change.revision !== row.revision)
      throw failure(
        actor === 'owner'
          ? `This CV's text changed while you were editing it; it is now at version ${row.revision}. Load the newer version, then make your change again.`
          : `This CV's text changed after you read it; it is now at version ${row.revision}. Read it again with cv_get, then save your change against that version.`,
        409,
      );
    if (change.label !== undefined && change.label !== row.label)
      await client.query(
        'UPDATE job_cvs SET label=$3,updated_at=now() WHERE id=$1 AND owner_id=$2',
        [row.id, ownerId, change.label],
      );
    if (change.markdown !== undefined && change.markdown !== row.markdown) {
      const revision = row.revision + 1;
      await client.query(
        `UPDATE job_cvs SET markdown=$3,revision=$4,pdf_artifact_id=NULL,updated_at=now()
         WHERE id=$1 AND owner_id=$2`,
        [row.id, ownerId, change.markdown, revision],
      );
      await expire(client, [row.pdf_artifact_id], row.id);
      await snapshot(client, 'cv', row.id, revision, { markdown: change.markdown }, actor);
    }
    return oneCv(client, row.id);
  }

  async function convert(id: string) {
    const start = options.startChat;
    if (!start) throw failure('New chats are unavailable on this server.', 503);
    const sessionId = randomUUID();
    const row = await owned(async (client) => {
      const row = await oneCv(client, id);
      if (!row.artifact_id || !row.file_name) throw failure('This CV has no file to convert.', 409);
      if (row.converting) throw failure('This CV is already being converted in its own chat.', 409);
      await client.query(
        'UPDATE job_cvs SET conversion_session=$3,conversion_started_at=now() WHERE id=$1 AND owner_id=$2',
        [row.id, ownerId, sessionId],
      );
      return row;
    });
    const size = (
      await pool.query<{ size: number }>('SELECT size FROM artifacts WHERE id=$1 AND owner_id=$2', [
        row.artifact_id,
        ownerId,
      ])
    ).rows[0]!.size;
    try {
      await start(
        conversionRequest,
        [
          {
            id: row.artifact_id!,
            name: row.file_name!,
            mimeType: row.file_mime ?? 'application/octet-stream',
            size,
            url: `/api/artifacts/${row.artifact_id}`,
          },
        ],
        sessionId,
      );
    } catch (error) {
      await pool.query(
        `UPDATE job_cvs SET conversion_session=NULL,conversion_started_at=NULL
         WHERE id=$1 AND owner_id=$2 AND conversion_session=$3`,
        [row.id, ownerId, sessionId],
      );
      throw error;
    }
  }

  async function sync(turn: TurnRef, force: boolean, signal?: AbortSignal) {
    const workspace = options.workspace;
    if (!workspace) throw failure('The workspace is unavailable.', 503);
    return turnWrite(turn, async (client) => {
      const state = await profileState(client);
      const { files, skipped } = careerOpsFiles({
        profile: state.profile,
        portals: state.portals,
        main: (await cvs(client)).find((row) => row.is_main),
      });
      const previous = state.synced.thread === turn.threadId ? (state.synced.files ?? {}) : {};
      const next = { ...previous };
      const written: string[] = [];
      const unchanged: string[] = [];
      const removed: string[] = [];
      for (const [path, content] of Object.entries(files)) {
        const digest = hash(content);
        if (!force && previous[path] === digest) {
          unchanged.push(path);
          continue;
        }
        await workspace.write(turn.threadId, `${folder}/${path}`, Buffer.from(content), signal);
        next[path] = digest;
        written.push(path);
      }
      for (const path of Object.keys(skipped)) {
        if (!force && previous[path] === undefined) continue;
        if (!workspace.remove)
          throw failure(`Nod can't remove the outdated ${path} from this workspace.`, 503);
        await workspace.remove(turn.threadId, `${folder}/${path}`, signal);
        delete next[path];
        if (previous[path] !== undefined) removed.push(path);
      }
      if (!same(next, previous) || state.synced.thread !== turn.threadId)
        await client.query(
          `INSERT INTO job_profile(owner_id,synced) VALUES($1,$2)
           ON CONFLICT (owner_id) DO UPDATE SET synced=$2`,
          [ownerId, JSON.stringify({ thread: turn.threadId, files: next })],
        );
      return {
        folder: `/workspace/${turn.threadId}/${folder}`,
        written,
        unchanged,
        removed,
        skipped,
      };
    });
  }

  async function savePdf(turn: TurnRef, id: string, revision: number) {
    const workspace = options.workspace;
    if (!workspace) throw failure('The workspace is unavailable.', 503);
    if ((await rootedIn(pool, turn)) === 'other')
      throw failure(
        'Only work started by an owner message, or a schedule, can save a CV PDF.',
        403,
      );
    const row = await oneCv(pool, id);
    if (uploadedPdf(row))
      throw failure('This CV was uploaded as a PDF, and that file stays its PDF.', 409);
    const path = pdfPath(row.id);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await workspace.read(turn.threadId, path, fileBytes));
    } catch (error) {
      throw failure(
        `Nod couldn't read /workspace/${turn.threadId}/${path}: ${error instanceof Error ? error.message : String(error)} Make the PDF at that path first.`,
      );
    }
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw failure(`/workspace/${turn.threadId}/${path} is not a PDF.`);
    const stored = await options.artifacts.storeArtifact(
      bytes,
      `${row.label}.pdf`,
      'application/pdf',
      undefined,
      undefined,
      undefined,
      true,
    );
    return turnWrite(turn, async (client) => {
      if ((await rootedIn(client, turn)) === 'other')
        throw failure(
          'Only work started by an owner message, or a schedule, can save a CV PDF.',
          403,
        );
      const current = await oneCv(client, row.id);
      if (current.revision !== revision)
        throw failure(
          `This CV's text changed after the PDF was made; it is now at version ${current.revision}. Make the PDF again from the current text.`,
          409,
        );
      await options.artifacts.retainArtifacts([stored.id], client);
      await expire(client, [current.pdf_artifact_id], current.id);
      await client.query(
        'UPDATE job_cvs SET pdf_artifact_id=$3,pdf_revision=$4,updated_at=now() WHERE id=$1 AND owner_id=$2',
        [current.id, ownerId, stored.id, current.revision],
      );
      return oneCv(client, current.id);
    });
  }

  async function sentFile(client: Query, turn: TurnRef, path: string) {
    const id = attachedId(path);
    const artifact =
      id &&
      (
        await client.query<{ id: string; name: string; mime_type: string }>(
          `SELECT a.id,a.name,a.mime_type FROM artifacts a WHERE a.id=$1 AND a.owner_id=$2 AND a.deleting_at IS NULL
           AND EXISTS (SELECT 1 FROM messages m WHERE m.owner_id=$2 AND m.thread_id=$3 AND m.role='user'
             AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id::text))
             AND NOT ${withdrawnSql('m')})`,
          [id, ownerId, turn.threadId],
        )
      ).rows[0];
    if (!artifact)
      throw failure(
        'cv_add takes the workspaceFile of a file the owner sent in this conversation, exactly as workspaceAttachments lists it.',
      );
    return artifact;
  }

  async function pickCv(client: Query, input: { id?: string; label?: string }) {
    if (input.id) return oneCv(client, input.id);
    const wanted = input.label!.toLocaleLowerCase();
    const rows = (await cvs(client)).filter((row) => row.label.toLocaleLowerCase() === wanted);
    if (rows.length === 1) return rows[0]!;
    throw failure(
      rows.length
        ? 'More than one CV has that label. Use its id from setup_status.'
        : 'No CV has that label. Read setup_status for the CVs and their ids.',
      404,
    );
  }

  async function applyLimits(raw: unknown, client: PoolClient, expected: unknown) {
    const input = parse(jobLimitsInput, raw, 'The job search limits');
    await lock(client);
    const current = await profileState(client);
    if (limitsKey(liveLimits(current.profile)) !== limitsKey(expected))
      throw Object.assign(
        failure('The job search limits changed after Nod asked. Ask again.', 409),
        { notRun: true },
      );
    const profile = parse(jobProfileSchema, merged(current.profile, input), 'The job profile');
    const revision = await saveProfile(client, { profile }, 'nod');
    afterCommit(client, changed);
    return { revision, inviteLimits: profile.inviteLimits, noLuck: profile.noLuck };
  }

  async function updateProfile(
    turn: TurnRef,
    request: { profile?: z.infer<typeof jobProfilePatch>; portals?: Record<string, unknown> },
    review?: (input: JobLimits, current: JobLimitValues) => Promise<unknown>,
  ) {
    const patch = { ...request.profile };
    const asked: Record<string, Record<string, number>> = {};
    for (const key of jobLimitFields)
      if (patch[key] !== undefined) {
        asked[key] = patch[key] as Record<string, number>;
        delete patch[key];
      }
    const saved = await turnWrite(turn, async (client) => {
      await ownerOnly(client, turn, 'change the job profile');
      const current = await profileState(client);
      const profile = parse(jobProfileSchema, merged(current.profile, patch), 'The job profile');
      const change = Object.fromEntries(
        jobLimitFields.flatMap((key) => {
          const now = current.profile[key] as Record<string, number>;
          const fields = Object.entries(asked[key] ?? {}).filter(
            ([name, value]) => now[name] !== value,
          );
          return fields.length ? [[key, Object.fromEntries(fields)]] : [];
        }),
      ) as JobLimits;
      if (Object.keys(change).length && !review)
        throw failure(
          "Changing invite limits or no-luck days needs the owner's approval, which isn't available here.",
          403,
        );
      const revision =
        Object.keys(patch).length || request.portals
          ? await saveProfile(client, { profile, portals: request.portals }, 'nod')
          : current.revision;
      return { revision, change, current: liveLimits(current.profile) };
    });
    const reply = async (extra: Record<string, unknown> = {}) => {
      const { profile, revision } = await profileState(pool);
      return { value: { revision, profile, ...extra } };
    };
    if (!Object.keys(saved.change).length || !review) return reply();
    const reviewed = await review(
      parse(jobLimitsInput, saved.change, 'The job search limits'),
      saved.current,
    );
    if (reviewed && typeof reviewed === 'object' && appConfirmation in reviewed)
      return { confirmation: reviewed };
    return reply({ limits: reviewed });
  }

  async function execute(
    turn: TurnRef,
    raw: unknown,
    context: {
      signal?: AbortSignal;
      reviewLimits?: (input: JobLimits, current: JobLimitValues) => Promise<unknown>;
    } = {},
  ) {
    const request = parse(toolInput, raw, 'The jobs request');
    const result = async (): Promise<unknown> => {
      switch (request.action) {
        case 'setup_status': {
          const { profile, portals, revision } = await profileState(pool);
          return {
            ...(await setup(pool)),
            folder: `/workspace/${turn.threadId}/${folder}`,
            cvs: (await cvs(pool)).map(withoutText),
            profile,
            profileRevision: revision,
            portals,
            templates: (await templates(pool)).templates.map(({ language, revision }) => ({
              language,
              revision,
            })),
          };
        }
        case 'sync':
          return sync(turn, Boolean(request.force), context.signal);
        case 'cv_get': {
          const id = request.workspaceFile ? attachedId(request.workspaceFile) : undefined;
          const row = request.id
            ? await oneCv(pool, request.id)
            : (await cvs(pool)).find((entry) => id && entry.artifact_id === id);
          if (!row)
            throw failure(
              'No CV uses that file. Read setup_status for the CVs, or add the file with cv_add.',
              404,
            );
          return cvView(row);
        }
        case 'cv_file': {
          if (!options.workspace) throw failure('The workspace is unavailable.', 503);
          const row = request.id
            ? await oneCv(pool, request.id)
            : (await cvs(pool)).find((entry) => entry.is_main);
          if (!row)
            throw failure(
              'There is no main CV yet. The owner can add one on the Jobs page or send it in chat.',
            );
          const pdf = cvView(row).pdf;
          if (!pdf)
            throw failure(
              row.pdf_revision !== null && row.pdf_revision !== row.revision
                ? "This CV's text changed after its PDF was made. Make the PDF again from the current text, as the job-search guide's cv-pdf reference describes."
                : "This CV has no PDF for its current text yet. Make it as the job-search guide's cv-pdf reference describes.",
              409,
            );
          const name = fileName(
            pdf.name.toLowerCase().endsWith('.pdf')
              ? pdf.name
              : `${row.label.replace(/[/\\]/g, '-')}.pdf`,
          ).replace(/^\.+/, '');
          await options.workspace.write(
            turn.threadId,
            `${folder}/cv-pdf/${name}`,
            await options.artifacts.readArtifact(pdf.id),
            context.signal,
          );
          return {
            workspaceFile: `/workspace/${turn.threadId}/${folder}/cv-pdf/${name}`,
            name,
            label: row.label,
            main: row.is_main,
          };
        }
        case 'cv_save': {
          if (request.pdf) return withoutText(await savePdf(turn, request.id, request.revision));
          return withoutText(
            await turnWrite(turn, async (client) => {
              await ownerOnly(client, turn, "change a CV's text");
              return editCv(
                client,
                request.id,
                { markdown: request.markdown, revision: request.revision },
                'nod',
              );
            }),
          );
        }
        case 'profile_update': {
          const outcome = await updateProfile(turn, request, context.reviewLimits);
          return 'confirmation' in outcome ? outcome.confirmation : outcome.value;
        }
        case 'cv_add': {
          const { row, added } = await turnWrite(turn, async (client) => {
            await ownerOnly(client, turn, 'add a CV');
            return addCv(
              client,
              await sentFile(client, turn, request.workspaceFile),
              request.label,
            );
          });
          return {
            ...withoutText(row),
            added,
            next: 'Convert it now as the job-search guide describes: extract its text, save the markdown with cv_save, then draft the profile.',
          };
        }
        case 'cv_main':
          return withoutText(
            await turnWrite(turn, async (client) => {
              await ownerOnly(client, turn, 'change the main CV');
              return makeMain(client, (await pickCv(client, request)).id);
            }),
          );
      }
    };
    const value = await result();
    if (!quietActions.has(request.action)) changed();
    if (value && typeof value === 'object' && appConfirmation in value) return value;
    return untrustedBlock('job search records', JSON.stringify(value));
  }

  function registerRoutes(app: FastifyInstance) {
    const body = <T extends z.ZodType>(schema: T, value: unknown, what: string) =>
      parse(schema, value, what);
    app.get('/api/jobs/setup', () => setup(pool));
    app.get('/api/jobs/cvs', async () => (await cvs(pool)).map(cvView));
    app.post('/api/jobs/cvs', async (request) => {
      const input = body(
        z.object({ uploadId: z.uuid(), label: label.optional() }).strict(),
        request.body,
        'The new CV',
      );
      const row = await owned(async (client) => {
        const artifact = (
          await client.query<{ id: string; name: string; mime_type: string }>(
            'SELECT id,name,mime_type FROM artifacts WHERE id=$1 AND owner_id=$2 AND deleting_at IS NULL',
            [input.uploadId, ownerId],
          )
        ).rows[0];
        if (!artifact) throw failure('The upload is unavailable. Choose the file again.');
        const { row, added } = await addCv(client, artifact, input.label);
        if (!added) throw failure('This file is already in your CVs.', 409);
        return row;
      });
      let conversion: 'started' | string = 'started';
      try {
        await convert(row.id);
      } catch (error) {
        conversion = error instanceof Error ? error.message : String(error);
      }
      changed();
      return { cv: cvView((await cvs(pool, { id: row.id }))[0] ?? row), conversion };
    });
    app.post<{ Params: { id: string } }>('/api/jobs/cvs/:id/convert', async (request) => {
      await convert(request.params.id);
      changed();
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/api/jobs/cvs/:id/main', async (request) =>
      cvView(await owned((client) => makeMain(client, request.params.id))),
    );
    app.patch<{ Params: { id: string } }>('/api/jobs/cvs/:id', async (request) => {
      const change = body(
        z
          .object({
            label: label.optional(),
            markdown: z.string().trim().max(200_000).optional(),
            revision: z.int().min(0).optional(),
          })
          .strict()
          .refine((value) => value.label !== undefined || value.markdown !== undefined, {
            message: 'Send a label, markdown or both.',
          }),
        request.body,
        'The CV change',
      );
      return cvView(await owned((client) => editCv(client, request.params.id, change, 'owner')));
    });
    app.post<{ Params: { id: string } }>('/api/jobs/cvs/:id/archive', async (request) => {
      await owned((client) => archive(client, request.params.id));
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/api/jobs/cvs/:id', async (request) => {
      await owned((client) => remove(client, request.params.id));
      return { ok: true };
    });
    app.get<{ Params: { id: string } }>('/api/jobs/cvs/:id/revisions', async (request) => {
      const row = await oneCv(pool, request.params.id);
      return revisions<{ markdown: string }>(pool, 'cv', row.id);
    });
    app.post<{ Params: { id: string; revision: string } }>(
      '/api/jobs/cvs/:id/revisions/:revision/restore',
      async (request) =>
        cvView(
          await owned(async (client) => {
            const row = await oneCv(client, request.params.id);
            const earlier = await oneRevision<{ markdown: string }>(
              client,
              'cv',
              row.id,
              request.params.revision,
            );
            return editCv(client, row.id, { markdown: earlier.data.markdown }, 'owner');
          }),
        ),
    );
    app.get('/api/jobs/profile', async (): Promise<JobProfileView> => {
      const { profile, portals, revision } = await profileState(pool);
      return { profile, portals, revision };
    });
    app.put('/api/jobs/profile', async (request): Promise<JobProfileView> => {
      const input = body(
        z
          .object({
            profile: jobProfileSchema,
            portals: jobPortalsSchema.optional(),
            revision: z.int().min(0),
          })
          .strict(),
        request.body,
        'The profile',
      );
      await owned((client) =>
        saveProfile(
          client,
          { profile: input.profile, portals: input.portals },
          'owner',
          input.revision,
        ),
      );
      const { profile, portals, revision } = await profileState(pool);
      return { profile, portals, revision };
    });
    app.get('/api/jobs/profile/revisions', () =>
      revisions<{ profile: JobProfile; portals: Record<string, unknown> }>(pool, 'profile', null),
    );
    app.post<{ Params: { revision: string } }>(
      '/api/jobs/profile/revisions/:revision/restore',
      async (request): Promise<JobProfileView> => {
        await owned(async (client) => {
          const earlier = await oneRevision<{
            profile: JobProfile;
            portals: Record<string, unknown>;
          }>(client, 'profile', null, request.params.revision);
          await saveProfile(
            client,
            {
              profile: parse(
                jobProfileSchema,
                merged(defaultJobProfile, earlier.data.profile),
                'The earlier profile',
              ),
              portals: earlier.data.portals,
            },
            'owner',
          );
        });
        const { profile, portals, revision } = await profileState(pool);
        return { profile, portals, revision };
      },
    );
    app.get('/api/jobs/templates', () => templates(pool));
    app.put('/api/jobs/templates', async (request) => {
      const input = body(
        z
          .object({ templates: z.array(jobTemplateSchema).max(20), revision: z.int().min(0) })
          .strict(),
        request.body,
        'The templates',
      );
      await owned((client) => saveTemplates(client, input.templates, input.revision));
      return templates(pool);
    });
  }

  return {
    execute,
    applyLimits,
    registerRoutes,
    setup: () => setup(pool),
  };
}
