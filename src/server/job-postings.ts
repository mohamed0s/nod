import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TelegramChannels, TelegramPost } from '../ports/job-sources.ts';
import {
  jobPostingStatuses,
  jobSourceKinds,
  jobSwitchDefaults,
  jobSwitches,
  telegramChannel,
  type JobChannel,
  type JobPosting,
  type JobPostingsView,
  type JobSourceKind,
  type JobSourcesView,
  type JobSwitch,
} from '../shared/job-postings.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import { jobFingerprint, jobUrl, jobUrlKey, siteOf } from './job-urls.ts';
import {
  alertPostings,
  clean,
  isoDate,
  scanHistoryPostings,
  telegramPostings,
  type JobCandidate,
} from './jobs-parsers.ts';
import { failure, parse, rootedIn, type Lineage, type Query, type TurnRef } from './jobs-shared.ts';

export const jobPostingTables = `
  CREATE TABLE IF NOT EXISTS job_postings (
    id uuid PRIMARY KEY, owner_id text NOT NULL, url_key text NOT NULL, url text NOT NULL, fingerprint text,
    title text NOT NULL, company text NOT NULL DEFAULT '', location text NOT NULL DEFAULT '',
    posted_at timestamptz, excerpt text NOT NULL DEFAULT '',
    score real CHECK (score IS NULL OR (score>=0 AND score<=5)), score_kind text CHECK (score_kind IN ('short','full')),
    summary text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','shortlisted','skipped','applied')),
    revision integer NOT NULL DEFAULT 0,
    first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_postings_url_key ON job_postings(owner_id,url_key);
  CREATE INDEX IF NOT EXISTS job_postings_fingerprint ON job_postings(owner_id,fingerprint) WHERE fingerprint IS NOT NULL;
  CREATE INDEX IF NOT EXISTS job_postings_list ON job_postings(owner_id,status,first_seen_at DESC);
  CREATE TABLE IF NOT EXISTS job_posting_links (
    owner_id text NOT NULL, url_key text NOT NULL,
    posting_id uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    source text NOT NULL CHECK (source IN ('career-ops','telegram','email','web')),
    source_detail text NOT NULL DEFAULT '', url text NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id,url_key)
  );
  CREATE INDEX IF NOT EXISTS job_posting_links_posting ON job_posting_links(posting_id);
  CREATE TABLE IF NOT EXISTS job_sources (
    id uuid PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('telegram','switch')),
    name text NOT NULL, enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
    last_post_id bigint, last_read_at timestamptz, last_error text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_sources_name ON job_sources(owner_id,kind,lower(name));
`;

export const postingActions = new Set([
  'list',
  'import',
  'posting_update',
  'sources',
  'source_update',
  'telegram',
]);

const importBytes = 8 * 1024 * 1024;
const historyDays = 30;
const shown = 50;
const firstReadDays = 14;
const morePages = 3;
const score = z.number().min(0).max(5);
const statusFilter = z.enum([...jobPostingStatuses, 'all']);

const candidate = z.object({
  url: z
    .string()
    .max(2048)
    .transform((value, context) => {
      const url = jobUrl(value);
      const key = jobUrlKey(value);
      if (url && key) return { url, key };
      context.addIssue({ code: 'custom', message: 'needs a public http or https link' });
      return z.NEVER;
    }),
  title: z
    .string()
    .transform((value) => clean(value, 200))
    .pipe(z.string().min(1, 'needs a title')),
  company: z
    .string()
    .nullish()
    .transform((value) => clean(value ?? '', 160)),
  location: z
    .string()
    .nullish()
    .transform((value) => clean(value ?? '', 160)),
  postedAt: z
    .string()
    .nullish()
    .transform((value) => isoDate(value)),
  excerpt: z
    .string()
    .nullish()
    .transform((value) => clean(value ?? '', 600)),
  detail: z
    .string()
    .nullish()
    .transform((value) => clean(value ?? '', 80)),
});

const webFile = z
  .array(
    z.object({
      url: z.string().max(2048),
      title: z.string().max(1000),
      company: z.string().max(1000).nullish(),
      location: z.string().max(1000).nullish(),
      postedAt: z.string().max(100).nullish(),
      summary: z.string().max(5000).nullish(),
    }),
  )
  .max(500);

const emailFile = z
  .array(
    z.object({
      id: z.string().max(500).nullish(),
      from: z.string().max(1000).nullish(),
      subject: z.string().max(2000).nullish(),
      date: z.string().max(200).nullish(),
      html: z.string().max(2_000_000).nullish(),
      text: z.string().max(1_000_000).nullish(),
    }),
  )
  .max(200);

const toolInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      status: statusFilter.optional(),
      minScore: score.optional(),
      scored: z.enum(['none', 'short', 'full']).optional(),
      source: z.enum(jobSourceKinds).optional(),
      sinceHours: z
        .int()
        .min(1)
        .max(24 * 60)
        .optional(),
      limit: z.int().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('import'),
      workspaceFile: z.string().trim().min(1).max(4096),
      source: z.enum(['career-ops', 'email', 'web']),
    })
    .strict(),
  z
    .object({
      action: z.literal('posting_update'),
      postings: z
        .array(
          z
            .object({
              id: z.uuid(),
              score: score.optional(),
              check: z.enum(['short', 'full']).optional(),
              summary: z.string().trim().max(1000).optional(),
              status: z.enum(jobPostingStatuses).optional(),
            })
            .strict()
            .refine(
              (entry) =>
                entry.score !== undefined ||
                entry.summary !== undefined ||
                entry.status !== undefined,
              { message: 'Each change needs score, summary, status or more than one of them.' },
            ),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z.object({ action: z.literal('sources') }).strict(),
  z
    .object({
      action: z.literal('source_update'),
      telegram: z
        .object({
          add: z.array(telegramChannel).max(30).optional(),
          remove: z.array(telegramChannel).max(30).optional(),
        })
        .strict()
        .optional(),
      switches: z
        .object(
          Object.fromEntries(jobSwitches.map((key) => [key, z.boolean().optional()])) as Record<
            JobSwitch,
            z.ZodOptional<z.ZodBoolean>
          >,
        )
        .strict()
        .optional(),
    })
    .strict()
    .refine((value) => value.telegram !== undefined || value.switches !== undefined, {
      message: 'source_update needs telegram, switches or both.',
    }),
  z.object({ action: z.literal('telegram'), channel: telegramChannel.optional() }).strict(),
]);

type PostingRow = {
  id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  posted_at: Date | null;
  excerpt: string;
  score: number | null;
  score_kind: 'short' | 'full' | null;
  summary: string;
  status: JobPosting['status'];
  revision: number;
  first_seen_at: Date;
  last_seen_at: Date;
  sources: JobPosting['sources'];
};
type SourceRow = {
  kind: 'telegram' | 'switch';
  name: string;
  enabled: boolean;
  revision: number;
  last_post_id: string | null;
  last_read_at: Date | null;
  last_error: string | null;
};
type Created = {
  id: string;
  source: JobSourceKind;
  detail: string;
  company: string;
  title: string;
  location: string;
  url: string;
  postedAt: string | null;
  excerpt: string;
};

function view(row: PostingRow): JobPosting {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    sources: row.sources,
    postedAt: row.posted_at?.toISOString() ?? null,
    score: row.score,
    scoreKind: row.score_kind,
    summary: row.summary,
    excerpt: row.excerpt,
    status: row.status,
    revision: row.revision,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

function channelView(row: SourceRow): JobChannel {
  return {
    name: row.name,
    enabled: row.enabled,
    revision: row.revision,
    lastPostId: row.last_post_id === null ? null : Number(row.last_post_id),
    lastReadAt: row.last_read_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createJobPostings(options: {
  pool: Pool;
  ownerId: string;
  read?: (threadId: string, path: string, maxBytes: number) => Promise<Uint8Array>;
  telegram?: TelegramChannels;
  scanSummary: (client: Query) => Promise<{ boards: string[]; companies: number }>;
  turnWrite: <T>(
    turn: TurnRef,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  owned: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
  changed: () => void;
}) {
  const { pool, ownerId } = options;

  async function writer(client: Query, turn: TurnRef, what: string) {
    const lineage = await rootedIn(client, ownerId, turn);
    if (lineage === 'other')
      throw failure(`Only work started by an owner message, or a schedule, can ${what}.`, 403);
    return lineage;
  }

  async function postings(
    client: Query,
    filter: {
      id?: string;
      status?: z.infer<typeof statusFilter>;
      minScore?: number;
      scored?: 'none' | 'short' | 'full';
      source?: JobSourceKind;
      sinceHours?: number;
      limit?: number;
    } = {},
  ) {
    const { rows } = await client.query<PostingRow>(
      `SELECT p.*,COALESCE((SELECT json_agg(json_build_object('kind',l.source,'detail',l.source_detail,'url',l.url)
           ORDER BY l.first_seen_at,l.url_key) FROM job_posting_links l WHERE l.owner_id=p.owner_id AND l.posting_id=p.id),'[]') AS sources
       FROM job_postings p
       WHERE p.owner_id=$1 AND ($2::uuid IS NULL OR p.id=$2) AND ($3::text IS NULL OR $3='all' OR p.status=$3)
         AND ($4::real IS NULL OR p.score>=$4)
         AND ($5::text IS NULL OR ($5='none' AND p.score IS NULL) OR p.score_kind=$5)
         AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM job_posting_links s WHERE s.owner_id=p.owner_id AND s.posting_id=p.id AND s.source=$6))
         AND ($7::int IS NULL OR p.first_seen_at>now()-make_interval(hours=>$7))
       ORDER BY p.score DESC NULLS LAST,p.first_seen_at DESC,p.id LIMIT $8`,
      [
        ownerId,
        filter.id ?? null,
        filter.status ?? null,
        filter.minScore ?? null,
        filter.scored ?? null,
        filter.source ?? null,
        filter.sinceHours ?? null,
        filter.limit ?? 50,
      ],
    );
    return rows.map(view);
  }

  async function onePosting(client: Query, id: string) {
    const found = (await postings(client, { id: parse(z.uuid(), id, 'The posting id') }))[0];
    if (!found) throw failure('Posting not found.', 404);
    return found;
  }

  async function importRows(client: Query, kind: JobSourceKind, rows: JobCandidate[]) {
    const counts = { read: rows.length, new: 0, known: 0, merged: 0, skipped: 0 };
    const problems: string[] = [];
    const created: Created[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of rows.entries()) {
      const parsed = candidate.safeParse(raw);
      if (!parsed.success) {
        counts.skipped++;
        const issue = parsed.error.issues[0]!;
        if (problems.length < 5)
          problems.push(`row ${index + 1} (${issue.path.join('.') || 'row'}): ${issue.message}`);
        continue;
      }
      const row = parsed.data;
      if (seen.has(row.url.key)) {
        counts.known++;
        continue;
      }
      seen.add(row.url.key);
      const known = await client.query<{ posting_id: string }>(
        `UPDATE job_posting_links SET last_seen_at=now() WHERE owner_id=$1 AND url_key=$2 RETURNING posting_id`,
        [ownerId, row.url.key],
      );
      if (known.rowCount) {
        await client.query(
          'UPDATE job_postings SET last_seen_at=now() WHERE owner_id=$1 AND id=$2',
          [ownerId, known.rows[0]!.posting_id],
        );
        counts.known++;
        continue;
      }
      const fingerprint = jobFingerprint(row.company, row.title, row.location);
      const twin =
        fingerprint &&
        (
          await client.query<{ id: string }>(
            `SELECT p.id FROM job_postings p WHERE p.owner_id=$1 AND p.fingerprint=$2
               AND NOT EXISTS (SELECT 1 FROM job_posting_links l WHERE l.owner_id=$1 AND l.posting_id=p.id
                 AND l.source=$3 AND l.source_detail=$4)
             ORDER BY p.first_seen_at,p.id LIMIT 1`,
            [ownerId, fingerprint, kind, row.detail],
          )
        ).rows[0];
      const id = twin ? twin.id : randomUUID();
      if (twin) {
        await client.query(
          `UPDATE job_postings SET last_seen_at=now(),posted_at=COALESCE(posted_at,$3),
             excerpt=CASE WHEN excerpt='' THEN $4 ELSE excerpt END WHERE owner_id=$1 AND id=$2`,
          [ownerId, id, row.postedAt, row.excerpt],
        );
        counts.merged++;
      } else {
        await client.query(
          `INSERT INTO job_postings(id,owner_id,url_key,url,fingerprint,title,company,location,posted_at,excerpt)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            ownerId,
            row.url.key,
            row.url.url,
            fingerprint,
            row.title,
            row.company,
            row.location,
            row.postedAt,
            row.excerpt,
          ],
        );
        counts.new++;
        created.push({
          id,
          source: kind,
          detail: row.detail,
          company: row.company,
          title: row.title,
          location: row.location,
          url: row.url.url,
          postedAt: row.postedAt,
          excerpt: row.excerpt,
        });
      }
      await client.query(
        `INSERT INTO job_posting_links(owner_id,url_key,posting_id,source,source_detail,url) VALUES($1,$2,$3,$4,$5,$6)`,
        [ownerId, row.url.key, id, kind, row.detail, row.url.url],
      );
    }
    return { counts, problems, created };
  }

  function report(
    result: Awaited<ReturnType<typeof importRows>>,
    extra: Record<string, unknown> = {},
  ) {
    return {
      ...result.counts,
      ...extra,
      ...(result.problems.length ? { problems: result.problems } : {}),
      postings: result.created.slice(0, shown),
      ...(result.created.length > shown
        ? {
            more: `${result.created.length - shown} more new postings; read them with jobs list {status:'new', scored:'none'}.`,
          }
        : {}),
    };
  }

  function json(text: string, what: string) {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw failure(`${what} isn't valid JSON: ${message(error)}`);
    }
  }

  function candidates(source: 'career-ops' | 'email' | 'web', text: string) {
    if (source === 'career-ops') {
      if (/^\s*[[{]/.test(text))
        throw failure(
          "A career-ops import reads career-ops' data/scan-history.tsv, and this file is JSON.",
        );
      try {
        const { rows, old, other } = scanHistoryPostings(
          text,
          new Date(Date.now() - historyDays * 86_400_000),
        );
        return { rows, extra: { older: old, notAdded: other } };
      } catch (error) {
        throw failure(`The scan history can't be read: ${message(error)}.`);
      }
    }
    if (source === 'email') {
      const emails = parse(
        emailFile,
        json(text, 'The alert email file'),
        'The alert email file, a JSON array of {id, from, subject, date, html or text}',
      );
      return {
        rows: emails.flatMap((email) => alertPostings(email)),
        extra: { emails: emails.length },
      };
    }
    const rows = parse(
      webFile,
      json(text, 'The postings file'),
      'The postings file, a JSON array of {url, title, company, location, postedAt, summary}',
    );
    return {
      rows: rows.map((row): JobCandidate => ({
        url: row.url,
        title: row.title,
        company: row.company ?? '',
        location: row.location ?? '',
        postedAt: row.postedAt ?? null,
        excerpt: row.summary ?? '',
        detail: siteOf(row.url),
      })),
      extra: {},
    };
  }

  async function importFile(
    turn: TurnRef,
    request: { workspaceFile: string; source: 'career-ops' | 'email' | 'web' },
    signal?: AbortSignal,
  ) {
    if (!options.read) throw failure('The workspace is unavailable.', 503);
    await writer(pool, turn, 'import job postings');
    let bytes: Uint8Array;
    try {
      bytes = await options.read(turn.threadId, request.workspaceFile, importBytes);
    } catch (error) {
      throw failure(
        `Nod couldn't read ${request.workspaceFile}: ${message(error)} An import reads one file of this workspace, up to ${importBytes / 1024 / 1024} MB.`,
      );
    }
    const { rows, extra } = candidates(request.source, Buffer.from(bytes).toString('utf8'));
    return options.turnWrite(
      turn,
      async (client) => {
        await writer(client, turn, 'import job postings');
        return report(await importRows(client, request.source, rows), extra);
      },
      signal,
    );
  }

  async function updatePostings(
    turn: TurnRef,
    changes: Array<{
      id: string;
      score?: number;
      check?: 'short' | 'full';
      summary?: string;
      status?: JobPosting['status'];
    }>,
    signal?: AbortSignal,
  ) {
    return options.turnWrite(
      turn,
      async (client) => {
        const lineage: Lineage = await writer(client, turn, 'change job postings');
        const updated: JobPosting[] = [];
        const kept: Array<{ id: string; status: string; reason: string }> = [];
        const missing: string[] = [];
        for (const change of changes) {
          const current = (
            await client.query<{ status: JobPosting['status'] }>(
              'SELECT status FROM job_postings WHERE owner_id=$1 AND id=$2 FOR UPDATE',
              [ownerId, change.id],
            )
          ).rows[0];
          if (!current) {
            missing.push(change.id);
            continue;
          }
          let status = change.status;
          if (
            status &&
            status !== current.status &&
            lineage !== 'owner' &&
            current.status !== 'new'
          ) {
            kept.push({
              id: change.id,
              status: current.status,
              reason:
                'The owner already chose this status; scheduled work changes only new postings.',
            });
            status = undefined;
          }
          await client.query(
            `UPDATE job_postings SET score=COALESCE($3,score),score_kind=CASE WHEN $3::real IS NULL THEN score_kind ELSE $4 END,
               summary=COALESCE($5,summary),status=COALESCE($6,status),revision=revision+1,updated_at=now()
             WHERE owner_id=$1 AND id=$2`,
            [
              ownerId,
              change.id,
              change.score ?? null,
              change.check ?? 'short',
              change.summary ?? null,
              status ?? null,
            ],
          );
          updated.push(await onePosting(client, change.id));
        }
        return {
          updated,
          ...(kept.length ? { kept } : {}),
          ...(missing.length ? { missing } : {}),
        };
      },
      signal,
    );
  }

  async function sourceRows(client: Query) {
    return (
      await client.query<SourceRow>(
        `SELECT kind,name,enabled,revision,last_post_id,last_read_at,last_error FROM job_sources
         WHERE owner_id=$1 ORDER BY kind,lower(name)`,
        [ownerId],
      )
    ).rows;
  }

  async function sources(client: Query): Promise<JobSourcesView> {
    const rows = await sourceRows(client);
    const switches = jobSwitches.map((key) => {
      const row = rows.find((entry) => entry.kind === 'switch' && entry.name === key);
      return row
        ? { key, enabled: row.enabled, revision: row.revision }
        : { key, enabled: jobSwitchDefaults[key], revision: 0 };
    });
    return {
      channels: rows.filter((row) => row.kind === 'telegram').map(channelView),
      switches,
      ...(await options.scanSummary(client)),
    };
  }

  async function addChannel(client: Query, name: string) {
    const { rowCount } = await client.query(
      `INSERT INTO job_sources(id,owner_id,kind,name) VALUES($1,$2,'telegram',$3) ON CONFLICT DO NOTHING`,
      [randomUUID(), ownerId, name],
    );
    return Boolean(rowCount);
  }

  async function removeChannel(client: Query, name: string) {
    const { rowCount } = await client.query(
      `DELETE FROM job_sources WHERE owner_id=$1 AND kind='telegram' AND lower(name)=lower($2)`,
      [ownerId, name],
    );
    return Boolean(rowCount);
  }

  async function setSource(
    client: Query,
    kind: 'telegram' | 'switch',
    name: string,
    enabled: boolean,
    expected?: number,
  ) {
    const row = (await sourceRows(client)).find(
      (entry) => entry.kind === kind && entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (expected !== undefined && (row?.revision ?? 0) !== expected)
      throw failure(
        'This source changed since you opened the Sources tab. Reload it, then make your change again.',
        409,
      );
    if (!row) {
      if (kind === 'telegram') throw failure('That channel is not on your list.', 404);
      await client.query(
        `INSERT INTO job_sources(id,owner_id,kind,name,enabled) VALUES($1,$2,'switch',$3,$4)`,
        [randomUUID(), ownerId, name, enabled],
      );
      return;
    }
    if (row.enabled !== enabled)
      await client.query(
        `UPDATE job_sources SET enabled=$4,revision=revision+1,updated_at=now()
         WHERE owner_id=$1 AND kind=$2 AND lower(name)=lower($3)`,
        [ownerId, kind, name, enabled],
      );
  }

  async function updateSources(
    turn: TurnRef,
    request: {
      telegram?: { add?: string[]; remove?: string[] };
      switches?: Partial<Record<JobSwitch, boolean>>;
    },
    signal?: AbortSignal,
  ) {
    return options.turnWrite(
      turn,
      async (client) => {
        if ((await rootedIn(client, ownerId, turn)) !== 'owner')
          throw failure('Only work started by an owner message can change job sources.', 403);
        const added: string[] = [];
        for (const name of request.telegram?.add ?? []) {
          if (await addChannel(client, name)) added.push(name);
          else await setSource(client, 'telegram', name, true);
        }
        const removed: string[] = [];
        for (const name of request.telegram?.remove ?? [])
          if (await removeChannel(client, name)) removed.push(name);
        for (const key of jobSwitches) {
          const enabled = request.switches?.[key];
          if (enabled !== undefined) await setSource(client, 'switch', key, enabled);
        }
        return { added, removed, ...(await sources(client)) };
      },
      signal,
    );
  }

  async function channelPosts(channel: JobChannel, signal: AbortSignal) {
    const reader = options.telegram!;
    const last = channel.lastPostId;
    let page = await reader.read(channel.name, { signal });
    const posts = new Map<number, TelegramPost>(page.map((post) => [post.id, post]));
    for (let more = 0; last !== null && more < morePages && page.length; more++) {
      const oldest = Math.min(...page.map((post) => post.id));
      if (oldest <= last + 1) break;
      page = await reader.read(channel.name, { before: oldest, signal });
      for (const post of page) posts.set(post.id, post);
    }
    const cutoff = Date.now() - firstReadDays * 86_400_000;
    return [...posts.values()]
      .filter((post) =>
        last !== null ? post.id > last : !post.date || Date.parse(post.date) >= cutoff,
      )
      .sort((a, b) => a.id - b.id);
  }

  async function readTelegram(turn: TurnRef, name: string | undefined, signal?: AbortSignal) {
    if (!options.telegram) throw failure('Reading Telegram channels is unavailable here.', 503);
    await writer(pool, turn, 'read job channels');
    const channels = (await sources(pool)).channels.filter(
      (channel) => channel.enabled && (!name || channel.name.toLowerCase() === name.toLowerCase()),
    );
    if (name && !channels.length)
      throw failure(
        `${name} isn't an enabled channel on the Sources tab. Add a channel only when the owner accepts it.`,
        404,
      );
    const operation = signal ?? new AbortController().signal;
    const reads: Array<{ channel: JobChannel; posts?: TelegramPost[]; error?: string }> = [];
    for (const channel of channels) {
      try {
        reads.push({
          channel,
          posts: await channelPosts(
            channel,
            AbortSignal.any([operation, AbortSignal.timeout(30_000)]),
          ),
        });
      } catch (error) {
        operation.throwIfAborted();
        reads.push({ channel, error: message(error) });
      }
    }
    return options.turnWrite(
      turn,
      async (client) => {
        await writer(client, turn, 'read job channels');
        const summary: Array<Record<string, unknown>> = [];
        const created: Created[] = [];
        for (const { channel, posts, error } of reads) {
          if (!posts) {
            await client.query(
              `UPDATE job_sources SET last_error=$3,last_read_at=now()
               WHERE owner_id=$1 AND kind='telegram' AND lower(name)=lower($2)`,
              [ownerId, channel.name, error],
            );
            summary.push({ channel: channel.name, error });
            continue;
          }
          const rows = posts
            .map((post) => telegramPostings(channel.name, post))
            .filter((row): row is JobCandidate => Boolean(row));
          const result = await importRows(client, 'telegram', rows);
          const top = posts.length ? Math.max(...posts.map((post) => post.id)) : null;
          await client.query(
            `UPDATE job_sources SET last_post_id=GREATEST(COALESCE(last_post_id,0),COALESCE($3::bigint,0)),
               last_read_at=now(),last_error=NULL WHERE owner_id=$1 AND kind='telegram' AND lower(name)=lower($2)`,
            [ownerId, channel.name, top],
          );
          summary.push({
            channel: channel.name,
            posts: posts.length,
            ...result.counts,
            ...(result.problems.length ? { problems: result.problems } : {}),
          });
          created.push(...result.created);
        }
        return {
          channels: summary,
          postings: created.slice(0, shown),
          ...(created.length > shown
            ? { more: `${created.length - shown} more new postings; read them with jobs list.` }
            : {}),
        };
      },
      signal,
    );
  }

  function handles(raw: unknown) {
    const action =
      raw && typeof raw === 'object' ? (raw as { action?: unknown }).action : undefined;
    return typeof action === 'string' && postingActions.has(action);
  }

  async function execute(turn: TurnRef, raw: unknown, signal?: AbortSignal) {
    const request = parse(toolInput, raw, 'The jobs request');
    const value = await (async (): Promise<unknown> => {
      switch (request.action) {
        case 'list': {
          const { action: _action, ...filter } = request;
          return { postings: await postings(pool, { status: 'new', ...filter }) };
        }
        case 'import':
          return importFile(turn, request, signal);
        case 'posting_update':
          return updatePostings(turn, request.postings, signal);
        case 'sources':
          return sources(pool);
        case 'source_update':
          return updateSources(turn, request, signal);
        case 'telegram':
          return readTelegram(turn, request.channel, signal);
      }
    })();
    if (request.action !== 'list' && request.action !== 'sources') options.changed();
    return untrustedBlock('job search records', JSON.stringify(value));
  }

  function registerRoutes(app: FastifyInstance) {
    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/api/jobs/postings',
      async (request): Promise<JobPostingsView> => {
        const query = parse(
          z
            .object({
              status: statusFilter.optional(),
              minScore: z.coerce.number().min(0).max(5).optional(),
              source: z.enum(jobSourceKinds).optional(),
              limit: z.coerce.number().int().min(1).max(500).optional(),
            })
            .strict(),
          request.query,
          'The postings filter',
        );
        const counts = Object.fromEntries(
          jobPostingStatuses.map((status) => [status, 0]),
        ) as Record<JobPosting['status'], number>;
        for (const row of (
          await pool.query<{ status: JobPosting['status']; count: number }>(
            `SELECT status,count(*)::int AS count FROM job_postings WHERE owner_id=$1 GROUP BY status`,
            [ownerId],
          )
        ).rows)
          if (row.status in counts) counts[row.status] = row.count;
        const list = await postings(pool, {
          status: query.status ?? 'new',
          minScore: query.minScore,
          source: query.source,
          limit: query.limit ?? 100,
        });
        const total =
          (query.status ?? 'new') === 'all'
            ? Object.values(counts).reduce((sum, count) => sum + count, 0)
            : counts[(query.status ?? 'new') as JobPosting['status']];
        return { postings: list, total, counts };
      },
    );
    app.patch<{ Params: { id: string } }>('/api/jobs/postings/:id', async (request) => {
      const change = parse(
        z.object({ status: z.enum(jobPostingStatuses), revision: z.int().min(0) }).strict(),
        request.body,
        'The posting change',
      );
      return options.owned(async (client) => {
        const current = await onePosting(client, request.params.id);
        if (current.revision !== change.revision)
          throw failure(
            'This posting changed since you loaded it. Reload the list, then make your change again.',
            409,
          );
        if (current.status !== change.status)
          await client.query(
            `UPDATE job_postings SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2`,
            [ownerId, current.id, change.status],
          );
        return onePosting(client, current.id);
      });
    });
    app.get('/api/jobs/sources', () => sources(pool));
    app.post('/api/jobs/sources/telegram', async (request) => {
      const { name } = parse(
        z.object({ name: telegramChannel }).strict(),
        request.body,
        'The channel',
      );
      return options.owned(async (client) => {
        if (!(await addChannel(client, name)))
          throw failure(`${name} is already on your list.`, 409);
        return sources(client);
      });
    });
    app.patch<{ Params: { name: string } }>('/api/jobs/sources/telegram/:name', async (request) => {
      const change = parse(
        z.object({ enabled: z.boolean(), revision: z.int().min(0) }).strict(),
        request.body,
        'The channel change',
      );
      const name = parse(telegramChannel, request.params.name, 'The channel');
      return options.owned(async (client) => {
        await setSource(client, 'telegram', name, change.enabled, change.revision);
        return sources(client);
      });
    });
    app.delete<{ Params: { name: string } }>(
      '/api/jobs/sources/telegram/:name',
      async (request) => {
        const name = parse(telegramChannel, request.params.name, 'The channel');
        return options.owned(async (client) => {
          if (!(await removeChannel(client, name)))
            throw failure('That channel is not on your list.', 404);
          return sources(client);
        });
      },
    );
    app.put<{ Params: { key: string } }>('/api/jobs/sources/switches/:key', async (request) => {
      const key = parse(z.enum(jobSwitches), request.params.key, 'The source');
      const change = parse(
        z.object({ enabled: z.boolean(), revision: z.int().min(0) }).strict(),
        request.body,
        'The source change',
      );
      return options.owned(async (client) => {
        await setSource(client, 'switch', key, change.enabled, change.revision);
        return sources(client);
      });
    });
  }

  return { handles, execute, registerRoutes };
}
