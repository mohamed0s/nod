import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { Artifact } from '../shared/contracts.ts';
import { fileBytes, fileName } from '../shared/files.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import {
  cvMimeTypes,
  defaultJobProfile,
  jobPlaceholders,
  jobPortalsSchema,
  jobProfilePatch,
  jobProfileSchema,
  jobTemplateSchema,
  unknownPlaceholders,
  type JobCv,
  type JobProfile,
  type JobProfileView,
  type JobSetup,
  type JobTemplate,
  type JobTemplatesView,
} from '../shared/jobs.ts';
import type { ArtifactService } from './artifacts.ts';
import { lockKey } from './locks.ts';
import { transaction } from './transaction.ts';

export const jobTables = `
  CREATE TABLE IF NOT EXISTS job_cvs (
    id uuid PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
    artifact_id uuid, pdf_artifact_id uuid, markdown text NOT NULL DEFAULT '',
    is_main boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'converting' CHECK (status IN ('converting','ready')),
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_cvs_one_main ON job_cvs(owner_id) WHERE is_main AND archived_at IS NULL;
  CREATE INDEX IF NOT EXISTS job_cvs_owner ON job_cvs(owner_id,created_at);
  CREATE TABLE IF NOT EXISTS job_profile (
    owner_id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}', portals jsonb NOT NULL DEFAULT '{}',
    revision integer NOT NULL DEFAULT 0, synced jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS job_templates (
    id uuid PRIMARY KEY, owner_id text NOT NULL, language text NOT NULL, body text NOT NULL,
    greetings jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_templates_language ON job_templates(owner_id,language);
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

const folder = 'shared/career-ops';
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const label = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\r\n\x00-\x1f]/.test(value), 'A CV label is one line.');
const markdown = z.string().trim().min(1).max(200_000);
const workspacePath = z.string().trim().min(1).max(4096);

const toolInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setup_status') }).strict(),
  z.object({ action: z.literal('sync'), force: z.boolean().optional() }).strict(),
  z
    .object({
      action: z.literal('cv_save'),
      id: z.uuid(),
      markdown: markdown.optional(),
      pdfFile: workspacePath.optional(),
    })
    .strict()
    .refine((value) => value.markdown !== undefined || value.pdfFile !== undefined, {
      message: 'cv_save needs markdown, pdfFile or both.',
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
  z.object({ action: z.literal('cv_file'), id: z.uuid().optional() }).strict(),
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
const quietActions = new Set(['setup_status', 'cv_file', 'sync']);

type Query = Pick<PoolClient, 'query'>;
type TurnRef = { threadId: string; turnId: string };
type CvRow = {
  id: string;
  label: string;
  artifact_id: string | null;
  pdf_artifact_id: string | null;
  markdown: string;
  is_main: boolean;
  status: JobCv['status'];
  revision: number;
  created_at: Date;
  updated_at: Date;
  file_name: string | null;
  file_mime: string | null;
  pdf_name: string | null;
};

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
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

function cvKind(name: string, mimeType: string) {
  if (mimeType in cvMimeTypes) return mimeType;
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return docx;
  return undefined;
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
    status: row.status,
    revision: row.revision,
    markdown: row.markdown,
    file: original,
    pdf:
      original && cvKind(original.name, original.mimeType) === 'application/pdf'
        ? { id: original.id, name: original.name, url: original.url }
        : row.pdf_artifact_id && row.pdf_name
          ? { id: row.pdf_artifact_id, name: row.pdf_name, url: url(row.pdf_artifact_id) }
          : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function bullets(items: string[], empty: string) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function careerOpsProfile(profile: JobProfile) {
  const link = (pattern: RegExp) => profile.links.find((entry) => pattern.test(entry.label))?.url;
  const linkedin = link(/linkedin/i);
  const github = link(/github/i);
  const portfolio = profile.links.find((entry) => !/linkedin|github/i.test(entry.label))?.url;
  return {
    candidate: {
      full_name: profile.name,
      location: profile.location,
      ...(linkedin ? { linkedin } : {}),
      ...(github ? { github } : {}),
      ...(portfolio ? { portfolio_url: portfolio } : {}),
    },
    target_roles: {
      primary: profile.targetRoles,
      archetypes: profile.targetRoles.map((name) => ({ name, fit: 'primary' })),
    },
    narrative: { headline: profile.intro },
    location: { visa_status: profile.workAuthorization },
    language: { output: profile.languageRule.default },
  };
}

function profileNotes(profile: JobProfile) {
  return `# Job search profile

Nod writes this file from the owner's job profile. Change the profile in Nod; edits here are replaced.

## Introduction
${profile.intro || 'Not set.'}

## Target roles
${bullets(profile.targetRoles, 'Not set.')}

## Regions
${bullets(profile.regions, 'Not set.')}

## Location
${profile.location || 'Not set.'}

## Work authorization
${profile.workAuthorization || 'Not set.'}

## Languages
${bullets(profile.languages, 'Not set.')}

## Programmes and tracks
${bullets(
  profile.programmes.map((entry) =>
    entry.tracks.length ? `${entry.name}: ${entry.tracks.join(', ')}` : entry.name,
  ),
  'None.',
)}
`;
}

function brief(profile: JobProfile) {
  return `# Triage brief

Nod writes this file from the owner's job profile for short checks. Full scoring also reads cv.md and modes/_profile.md.

## Identity
${[profile.name, profile.intro].filter(Boolean).join(': ') || 'Not set.'}
Location: ${profile.location || 'not set'}. Work authorization: ${profile.workAuthorization || 'not set'}.

## Target roles
${bullets(profile.targetRoles, 'Not set.')}

## Regions
${bullets(profile.regions, 'Any.')}

## Quick check
- A role that matches a target role in a listed region can pass.
- A role that needs work authorization the profile doesn't show, or a seniority far from the CV, fails.
- Anything else is marginal: say why in one line.
`;
}

export function createJobs(options: {
  pool: Pool;
  ownerId: string;
  artifacts: Pick<ArtifactService, 'retainArtifacts' | 'readArtifact' | 'storeArtifact'>;
  workspace?: {
    write(threadId: string, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
    read(threadId: string, path: string, maxBytes: number): Promise<Uint8Array>;
  };
  startChat?: (text: string, attachments: Artifact[]) => Promise<unknown>;
  origin?: (turnId: string) => Promise<{ source: string } | undefined>;
  withTurnLock?: <T>(turnId: string, operation: (client: PoolClient) => Promise<T>) => Promise<T>;
  changed?: () => void;
}) {
  const { pool, ownerId } = options;
  const changed = options.changed ?? (() => {});
  const lock = (client: Query) => lockKey(client, `jobs:${ownerId}`);
  const owned = <T>(operation: (client: PoolClient) => Promise<T>) =>
    transaction(async (client) => {
      await lock(client);
      return operation(client);
    }, pool);
  const turnWrite = <T>(turn: TurnRef, operation: (client: PoolClient) => Promise<T>) => {
    if (!options.withTurnLock) throw failure('Job records are unavailable in this runtime.', 503);
    return options.withTurnLock(turn.turnId, async (client) => {
      await lock(client);
      return operation(client);
    });
  };

  async function cvs(client: Query, filter: { id?: string } = {}) {
    const { rows } = await client.query<CvRow>(
      `SELECT c.*,a.name AS file_name,a.mime_type AS file_mime,p.name AS pdf_name FROM job_cvs c
       LEFT JOIN artifacts a ON a.id=c.artifact_id AND a.owner_id=c.owner_id AND a.deleting_at IS NULL
       LEFT JOIN artifacts p ON p.id=c.pdf_artifact_id AND p.owner_id=c.owner_id AND p.deleting_at IS NULL
       WHERE c.owner_id=$1 AND ($2::uuid IS NULL OR c.id=$2) AND c.archived_at IS NULL
       ORDER BY c.is_main DESC,c.created_at DESC,c.id`,
      [ownerId, filter.id ?? null],
    );
    return rows;
  }

  async function oneCv(client: Query, id: string) {
    const row = (await cvs(client, { id: z.uuid().parse(id) }))[0];
    if (!row) throw failure('CV not found.', 404);
    return row;
  }

  async function profileState(client: Query) {
    const row = (
      await client.query<{
        data: Record<string, unknown>;
        portals: Record<string, unknown>;
        revision: number;
        synced: { thread?: string; files?: Record<string, string> };
      }>('SELECT data,portals,revision,synced FROM job_profile WHERE owner_id=$1', [ownerId])
    ).rows[0];
    const parsed = jobProfileSchema.safeParse(merged(defaultJobProfile, row?.data ?? {}));
    return {
      profile: parsed.success ? parsed.data : defaultJobProfile,
      portals: row?.portals ?? {},
      revision: row?.revision ?? 0,
      synced: row?.synced ?? {},
    };
  }

  async function saveProfile(
    client: Query,
    profile: JobProfile | undefined,
    portals: Record<string, unknown> | undefined,
  ) {
    const current = await profileState(client);
    const next = profile ?? current.profile;
    const nextPortals = portals ?? current.portals;
    if (
      current.revision > 0 &&
      JSON.stringify(next) === JSON.stringify(current.profile) &&
      JSON.stringify(nextPortals) === JSON.stringify(current.portals)
    )
      return current.revision;
    const { rows } = await client.query<{ revision: number }>(
      `INSERT INTO job_profile(owner_id,data,portals,revision) VALUES($1,$2,$3,1)
       ON CONFLICT (owner_id) DO UPDATE SET data=$2,portals=$3,revision=job_profile.revision+1,updated_at=now()
       RETURNING revision`,
      [ownerId, JSON.stringify(next), JSON.stringify(nextPortals)],
    );
    return rows[0]!.revision;
  }

  async function templates(client: Query): Promise<JobTemplatesView> {
    const { rows } = await client.query<JobTemplate & { revision: number }>(
      'SELECT language,body,greetings,revision FROM job_templates WHERE owner_id=$1 ORDER BY language',
      [ownerId],
    );
    return rows.length
      ? { templates: rows, examples: false }
      : { templates: exampleTemplates.map((entry) => ({ ...entry, revision: 0 })), examples: true };
  }

  function checkTemplates(list: JobTemplate[]) {
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
  }

  async function saveTemplates(client: Query, list: JobTemplate[]) {
    checkTemplates(list);
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
  }

  async function setup(client: Query): Promise<JobSetup> {
    const main = (await cvs(client)).find((row) => row.is_main);
    const profile = await profileState(client);
    const saved = await client.query('SELECT 1 FROM job_templates WHERE owner_id=$1 LIMIT 1', [
      ownerId,
    ]);
    return {
      items: [
        { key: 'cv', done: Boolean(main && main.status === 'ready') },
        { key: 'profile', done: profile.revision > 0 },
        { key: 'templates', done: Boolean(saved.rowCount) },
      ],
      mainCv: main ? { id: main.id, label: main.label, status: main.status } : null,
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
        label.parse(name ?? (artifact.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'CV')),
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

  async function archive(client: Query, id: string) {
    const row = await oneCv(client, id);
    await client.query(
      'UPDATE job_cvs SET archived_at=now(),is_main=false,updated_at=now() WHERE id=$1 AND owner_id=$2',
      [row.id, ownerId],
    );
    if (row.is_main)
      await client.query(
        `UPDATE job_cvs SET is_main=true WHERE id=(SELECT id FROM job_cvs WHERE owner_id=$1 AND archived_at IS NULL
           ORDER BY updated_at DESC,id LIMIT 1) AND owner_id=$1`,
        [ownerId],
      );
  }

  async function editCv(client: Query, id: string, change: { label?: string; markdown?: string }) {
    const row = await oneCv(client, id);
    const text = change.markdown ?? row.markdown;
    await client.query(
      `UPDATE job_cvs SET label=$3,markdown=$4,status=CASE WHEN $4<>'' THEN 'ready' ELSE 'converting' END,
         revision=revision+CASE WHEN markdown=$4 THEN 0 ELSE 1 END,updated_at=now()
       WHERE id=$1 AND owner_id=$2`,
      [row.id, ownerId, change.label ?? row.label, text],
    );
    return oneCv(client, row.id);
  }

  async function convert(row: CvRow) {
    if (!options.startChat) throw failure('New chats are unavailable on this server.', 503);
    if (!row.artifact_id || !row.file_name) throw failure('This CV has no file to convert.', 409);
    await options.startChat(`Convert my CV '${row.label}' for job search`, [
      {
        id: row.artifact_id,
        name: row.file_name,
        mimeType: row.file_mime ?? 'application/octet-stream',
        size: (
          await pool.query<{ size: number }>(
            'SELECT size FROM artifacts WHERE id=$1 AND owner_id=$2',
            [row.artifact_id, ownerId],
          )
        ).rows[0]!.size,
        url: `/api/artifacts/${row.artifact_id}`,
      },
    ]);
  }

  async function syncFiles(client: Query) {
    const { profile, portals } = await profileState(client);
    const main = (await cvs(client)).find((row) => row.is_main);
    const files: Record<string, string> = {
      'config/profile.yml': `${JSON.stringify(careerOpsProfile(profile), null, 2)}\n`,
      'modes/_profile.md': profileNotes(profile),
      'modes/_brief.md': brief(profile),
    };
    const skipped: Record<string, string> = {};
    if (main?.markdown) files['cv.md'] = `${main.markdown}\n`;
    else
      skipped['cv.md'] = main
        ? `The main CV '${main.label}' has no converted markdown yet.`
        : 'There is no main CV yet.';
    const scan = Object.keys(portals).length
      ? portals
      : profile.targetRoles.length
        ? { title_filter: { positive: profile.targetRoles, negative: [] } }
        : undefined;
    if (scan) files['portals.yml'] = `${JSON.stringify(scan, null, 2)}\n`;
    else skipped['portals.yml'] = 'The profile has no target roles or scan sources yet.';
    return { files, skipped };
  }

  async function sync(turn: TurnRef, force: boolean, signal?: AbortSignal) {
    if (!options.workspace) throw failure('The workspace is unavailable.', 503);
    const { files, skipped } = await syncFiles(pool);
    const { synced } = await profileState(pool);
    const previous = synced.thread === turn.threadId ? (synced.files ?? {}) : {};
    const next = { ...previous };
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      const digest = hash(content);
      if (!force && previous[path] === digest) {
        unchanged.push(path);
        continue;
      }
      await options.workspace.write(
        turn.threadId,
        `${folder}/${path}`,
        Buffer.from(content),
        signal,
      );
      next[path] = digest;
      written.push(path);
    }
    if (written.length)
      await turnWrite(turn, (client) =>
        client.query(
          `INSERT INTO job_profile(owner_id,synced) VALUES($1,$2)
           ON CONFLICT (owner_id) DO UPDATE SET synced=$2`,
          [ownerId, JSON.stringify({ thread: turn.threadId, files: next })],
        ),
      );
    return {
      folder: `/workspace/${turn.threadId}/${folder}`,
      written,
      unchanged,
      skipped,
    };
  }

  async function ownerStarted(turn: TurnRef, sources: string[], what: string) {
    const origin = await options.origin?.(turn.turnId);
    if (!origin || !sources.includes(origin.source)) throw failure(what);
  }

  async function absolutePath(turn: TurnRef, path: string) {
    if (path.startsWith('/')) return path;
    const task = (
      await pool.query<{ task_id: string | null }>(
        'SELECT task_id FROM turns WHERE id=$1 AND owner_id=$2',
        [turn.turnId, ownerId],
      )
    ).rows[0]?.task_id;
    return posix.resolve(`/workspace/${turn.threadId}${task ? `/tasks/${task}` : ''}`, path);
  }

  async function savedPdf(turn: TurnRef, row: CvRow, path: string) {
    if (!options.workspace) throw failure('The workspace is unavailable.', 503);
    if (row.file_name && cvKind(row.file_name, row.file_mime ?? '') === 'application/pdf')
      throw failure(`The CV '${row.label}' was uploaded as a PDF, and that file stays its PDF.`);
    const base = `/workspace/${turn.threadId}`;
    const full = posix.resolve(base, await absolutePath(turn, path));
    if (!full.startsWith(`${base}/`)) throw failure('The PDF must be a file in this workspace.');
    const bytes = Buffer.from(
      await options.workspace.read(turn.threadId, posix.relative(base, full), fileBytes),
    );
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw failure(`${posix.basename(full)} is not a PDF.`);
    return options.artifacts.storeArtifact(bytes, `${row.label}.pdf`, 'application/pdf');
  }

  async function sentFile(client: Query, turn: TurnRef, path: string) {
    const id = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i.exec(
      posix.basename(path),
    )?.[1];
    const artifact =
      id &&
      (
        await client.query<{ id: string; name: string; mime_type: string }>(
          `SELECT a.id,a.name,a.mime_type FROM artifacts a WHERE a.id=$1 AND a.owner_id=$2 AND a.deleting_at IS NULL
           AND EXISTS (SELECT 1 FROM messages m WHERE m.owner_id=$2 AND m.thread_id=$3 AND m.role='user'
             AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id::text)))`,
          [id.toLowerCase(), ownerId, turn.threadId],
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
    const names = (await cvs(client)).map((row) => `'${row.label}'`).join(', ') || 'none';
    throw failure(
      rows.length
        ? `More than one CV is called '${input.label}'. Use its id from setup_status.`
        : `No CV is called '${input.label}'. The CVs are: ${names}.`,
      404,
    );
  }

  async function execute(turn: TurnRef, raw: unknown, signal?: AbortSignal) {
    const request = toolInput.parse(raw);
    const result = async (): Promise<unknown> => {
      switch (request.action) {
        case 'setup_status': {
          const rows = await cvs(pool);
          const { profile, portals, revision } = await profileState(pool);
          return {
            ...(await setup(pool)),
            folder: `/workspace/${turn.threadId}/${folder}`,
            cvs: rows.map((row) => {
              const { markdown: text, ...view } = cvView(row);
              return { ...view, markdownCharacters: text.length };
            }),
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
          return sync(turn, Boolean(request.force), signal);
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
              `The CV '${row.label}' has no PDF yet. Make one from its markdown as the job-search guide's cv-pdf reference describes, then save it with cv_save pdfFile.`,
            );
          const name = fileName(
            pdf.name.toLowerCase().endsWith('.pdf')
              ? pdf.name
              : `${row.label.replace(/[/\\\x00-\x1f]/g, '-')}.pdf`,
          ).replace(/^\.+/, '');
          await options.workspace.write(
            turn.threadId,
            `${folder}/cv-pdf/${name}`,
            await options.artifacts.readArtifact(pdf.id),
            signal,
          );
          return {
            workspaceFile: `/workspace/${turn.threadId}/${folder}/cv-pdf/${name}`,
            name,
            label: row.label,
            main: row.is_main,
          };
        }
        case 'cv_save': {
          await ownerStarted(
            turn,
            ['user', 'task', 'schedule'],
            'Only work the owner started, or a schedule, can change a CV.',
          );
          const row = await oneCv(pool, request.id);
          const pdf = request.pdfFile ? await savedPdf(turn, row, request.pdfFile) : undefined;
          const saved = await turnWrite(turn, async (client) => {
            if (pdf)
              await client.query(
                'UPDATE job_cvs SET pdf_artifact_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2',
                [row.id, ownerId, pdf.id],
              );
            return request.markdown === undefined
              ? oneCv(client, row.id)
              : editCv(client, row.id, { markdown: request.markdown });
          });
          const { markdown: _text, ...view } = cvView(saved);
          return view;
        }
        case 'profile_update': {
          await ownerStarted(
            turn,
            ['user', 'task', 'schedule'],
            'Only work the owner started, or a schedule, can change the job profile.',
          );
          return turnWrite(turn, async (client) => {
            const current = await profileState(client);
            const profile = request.profile
              ? jobProfileSchema.parse(merged(current.profile, request.profile))
              : undefined;
            const revision = await saveProfile(client, profile, request.portals);
            return { revision, profile: profile ?? current.profile };
          });
        }
        case 'cv_add': {
          await ownerStarted(
            turn,
            ['user', 'task'],
            'Only work the owner started with a message can add a CV.',
          );
          const { row, added } = await turnWrite(turn, async (client) =>
            addCv(client, await sentFile(client, turn, request.workspaceFile), request.label),
          );
          const { markdown: _text, ...view } = cvView(row);
          return {
            ...view,
            added,
            next: 'Convert it now as the job-search guide describes: extract its text, save the markdown with cv_save, then draft the profile.',
          };
        }
        case 'cv_main': {
          await ownerStarted(
            turn,
            ['user', 'task'],
            'Only work the owner started with a message can change the main CV.',
          );
          const row = await turnWrite(turn, async (client) =>
            makeMain(client, (await pickCv(client, request)).id),
          );
          const { markdown: _text, ...view } = cvView(row);
          return view;
        }
      }
    };
    const value = await result();
    if (!quietActions.has(request.action)) changed();
    return untrustedBlock('job search records', JSON.stringify(value));
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/jobs/setup', () => setup(pool));
    app.get('/api/jobs/cvs', async () => (await cvs(pool)).map(cvView));
    app.post('/api/jobs/cvs', async (request) => {
      const input = z
        .object({ uploadId: z.uuid(), label: label.optional() })
        .strict()
        .parse(request.body);
      const row = await owned(async (client) => {
        const artifact = (
          await client.query<{ id: string; name: string; mime_type: string }>(
            'SELECT id,name,mime_type FROM artifacts WHERE id=$1 AND owner_id=$2 AND deleting_at IS NULL',
            [input.uploadId, ownerId],
          )
        ).rows[0];
        if (!artifact) throw failure('The upload is unavailable. Choose the file again.');
        const { row, added } = await addCv(client, artifact, input.label);
        if (!added) throw failure(`This file is already the CV '${row.label}'.`, 409);
        return row;
      });
      changed();
      let conversion: 'started' | string = 'started';
      try {
        await convert(row);
      } catch (error) {
        conversion = error instanceof Error ? error.message : String(error);
      }
      return { cv: cvView(row), conversion };
    });
    app.post<{ Params: { id: string } }>('/api/jobs/cvs/:id/convert', async (request) => {
      await convert(await oneCv(pool, request.params.id));
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/api/jobs/cvs/:id/main', async (request) => {
      const row = await owned((client) => makeMain(client, request.params.id));
      changed();
      return cvView(row);
    });
    app.patch<{ Params: { id: string } }>('/api/jobs/cvs/:id', async (request) => {
      const change = z
        .object({ label: label.optional(), markdown: z.string().trim().max(200_000).optional() })
        .strict()
        .refine((value) => value.label !== undefined || value.markdown !== undefined)
        .parse(request.body);
      const row = await owned((client) => editCv(client, request.params.id, change));
      changed();
      return cvView(row);
    });
    app.delete<{ Params: { id: string } }>('/api/jobs/cvs/:id', async (request) => {
      await owned((client) => archive(client, request.params.id));
      changed();
      return { ok: true };
    });
    app.get('/api/jobs/profile', async (): Promise<JobProfileView> => {
      const { profile, portals, revision } = await profileState(pool);
      return { profile, portals, revision };
    });
    app.put('/api/jobs/profile', async (request): Promise<JobProfileView> => {
      const input = z
        .object({ profile: jobProfileSchema, portals: jobPortalsSchema.optional() })
        .strict()
        .parse(request.body);
      const revision = await owned((client) => saveProfile(client, input.profile, input.portals));
      changed();
      const { profile, portals } = await profileState(pool);
      return { profile, portals, revision };
    });
    app.get('/api/jobs/templates', () => templates(pool));
    app.put('/api/jobs/templates', async (request) => {
      const { templates: list } = z
        .object({ templates: z.array(jobTemplateSchema).max(20) })
        .strict()
        .parse(request.body);
      await owned((client) => saveTemplates(client, list));
      changed();
      return templates(pool);
    });
  }

  return { execute, registerRoutes, setup: () => setup(pool) };
}
