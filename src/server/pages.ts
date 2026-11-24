import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { fileName } from '../shared/files.ts';
import {
  keptPageVersions,
  pageBytes,
  pageTitle,
  type PageSource,
  type PageVersion,
  type PageView,
} from '../shared/pages.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import type { Workspace } from '../ports/computer.ts';
import type { ArtifactService } from './artifacts.ts';
import { lockKey } from './locks.ts';
import { afterCommit, transaction } from './transaction.ts';

export const pageTables = `
  CREATE TABLE IF NOT EXISTS pages (
    id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, artifact_id uuid NOT NULL,
    revision integer NOT NULL DEFAULT 1, session_id uuid, schedule_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS pages_owner ON pages(owner_id,updated_at DESC);
  CREATE TABLE IF NOT EXISTS page_versions (
    owner_id text NOT NULL, page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    revision integer NOT NULL, artifact_id uuid NOT NULL, digest text NOT NULL,
    session_id uuid, schedule_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id,revision)
  );
  CREATE INDEX IF NOT EXISTS page_versions_artifact ON page_versions(owner_id,artifact_id);
`;

type Query = Pick<PoolClient, 'query'>;
type TurnRef = { threadId: string; turnId: string; signal?: AbortSignal };
type Origin =
  | { kind: 'owner'; sessionId: string }
  | { kind: 'schedule'; sessionId: string; scheduleId: string }
  | { kind: 'other' };
type Publisher = { sessionId: string | null; scheduleId: string | null };
type SourceRow = {
  session_id: string | null;
  schedule_id: string | null;
  schedule_title: string | null;
  task: { id: string; title: string } | null;
  chat_current: boolean | null;
};
type PageRow = SourceRow & {
  id: string;
  title: string;
  artifact_id: string;
  revision: number;
  digest: string | null;
  file_size: number | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};
type VersionRow = SourceRow & {
  revision: number;
  artifact_id: string;
  file_size: number | null;
  created_at: Date;
};

const title = z
  .string()
  .max(1000)
  .transform(pageTitle)
  .pipe(z.string().min(1, 'A page title needs at least one visible character.'));
const toolInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('get'), pageId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal('publish'),
      title: title.optional(),
      workspaceFile: z.string().trim().min(1).max(4096),
      pageId: z.uuid().optional(),
      revision: z.int().min(1).optional(),
    })
    .strict()
    .refine((value) => value.pageId !== undefined || value.title !== undefined, {
      message: 'publish needs a title for a new page, or the pageId of the page to update.',
    }),
]);
const refused = 'Only work started by an owner message, or a schedule, can publish a page.';
const megabytes = `${pageBytes / 1024 / 1024} MB`;
const scheduleSource = /^schedule:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;

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

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkPage(bytes: Uint8Array, where: string) {
  if (bytes.byteLength > pageBytes)
    throw failure(`${where} is larger than ${megabytes}, the most a page holds.`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw failure(`${where} is not UTF-8 text. Save the page as UTF-8.`);
  }
  if (!text.trim()) throw failure(`${where} is empty.`);
}

function storedName(value: string) {
  return `${fileName(value.replace(/[/\\]/g, '-'))}.html`;
}

const sourceFields = (alias: string) => `${alias}.session_id,${alias}.schedule_id,
  (SELECT s.title FROM schedules s WHERE s.owner_id=${alias}.owner_id AND s.id=${alias}.schedule_id) AS schedule_title,
  (SELECT json_build_object('id',k.id,'title',k.title) FROM tasks k WHERE k.owner_id=${alias}.owner_id
    AND k.id=${alias}.session_id AND k.session_id=k.id LIMIT 1) AS task,
  (SELECT th.archived_at IS NULL FROM threads th WHERE th.owner_id=${alias}.owner_id AND th.id=${alias}.session_id) AS chat_current`;

function source(row: SourceRow): PageSource {
  if (row.schedule_id) return { kind: 'schedule', id: row.schedule_id, title: row.schedule_title };
  if (row.task) return { kind: 'task', id: row.task.id, title: row.task.title };
  if (row.session_id) return { kind: 'chat', current: row.chat_current === true };
  return { kind: 'owner' };
}

function file(id: string, size: number | null) {
  return size === null ? null : { id, url: `/api/artifacts/${id}`, size };
}

function pageView(row: PageRow): PageView {
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    file: file(row.artifact_id, row.file_size),
    source: source(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function toolView(row: PageRow) {
  const view = pageView(row);
  return {
    pageId: view.id,
    title: view.title,
    revision: view.revision,
    updatedAt: view.updatedAt,
    archived: Boolean(view.archivedAt),
    publishedBy: view.source,
  };
}

export function createPages(options: {
  pool: Pool;
  ownerId: string;
  artifacts: Pick<ArtifactService, 'retainArtifacts' | 'readArtifact' | 'storeArtifact'>;
  workspace?: Pick<Workspace, 'writeArtifact' | 'readArtifact'>;
  withTurnLock?: <T>(
    turn: string | { turnId: string; signal: AbortSignal },
    operation: (client: PoolClient) => Promise<T>,
  ) => Promise<T>;
  changed?: () => void;
}) {
  const { pool, ownerId } = options;
  const changed = options.changed ?? (() => {});
  const lock = (client: Query) => lockKey(client, `pages:${ownerId}`);
  const owned = <T>(operation: (client: PoolClient) => Promise<T>) =>
    transaction(async (client) => {
      await lock(client);
      const value = await operation(client);
      afterCommit(client, changed);
      return value;
    }, pool);
  const turnWrite = <T>(turn: TurnRef, operation: (client: PoolClient) => Promise<T>) => {
    if (!options.withTurnLock) throw failure('Pages are unavailable in this runtime.', 503);
    const { turnId, signal } = turn;
    return options.withTurnLock(signal ? { turnId, signal } : turnId, async (client) => {
      await lock(client);
      const value = await operation(client);
      afterCommit(client, changed);
      return value;
    });
  };

  async function pages(client: Query, filter: { id?: string; title?: string } = {}) {
    const { rows } = await client.query<PageRow>(
      `SELECT p.id,p.title,p.artifact_id,p.revision,p.created_at,p.updated_at,p.archived_at,a.size AS file_size,
         (SELECT v.digest FROM page_versions v WHERE v.owner_id=p.owner_id AND v.page_id=p.id AND v.revision=p.revision) AS digest,
         ${sourceFields('p')}
       FROM pages p
       LEFT JOIN artifacts a ON a.id=p.artifact_id AND a.owner_id=p.owner_id AND a.deleting_at IS NULL
       WHERE p.owner_id=$1 AND ($2::uuid IS NULL OR p.id=$2)
         AND ($3::text IS NULL OR lower(p.title)=lower($3))
       ORDER BY p.archived_at IS NOT NULL,p.updated_at DESC,p.id`,
      [ownerId, filter.id ?? null, filter.title ?? null],
    );
    return rows;
  }

  async function onePage(client: Query, id: string) {
    const row = (await pages(client, { id: parse(z.uuid(), id, 'The page id') }))[0];
    if (!row) throw failure('Page not found.', 404);
    return row;
  }

  async function versions(client: Query, id: string) {
    const page = await onePage(client, id);
    const { rows } = await client.query<VersionRow>(
      `SELECT v.revision,v.artifact_id,v.created_at,a.size AS file_size,${sourceFields('v')}
       FROM page_versions v
       LEFT JOIN artifacts a ON a.id=v.artifact_id AND a.owner_id=v.owner_id AND a.deleting_at IS NULL
       WHERE v.owner_id=$1 AND v.page_id=$2 ORDER BY v.revision DESC`,
      [ownerId, page.id],
    );
    return rows.map((row): PageVersion => ({
      revision: row.revision,
      file: file(row.artifact_id, row.file_size),
      source: source(row),
      createdAt: row.created_at.toISOString(),
    }));
  }

  async function origin(client: Query, turn: TurnRef): Promise<Origin> {
    const { rows } = await client.query<{
      source: string;
      source_id: string | null;
      message_id: string | null;
      proactive: boolean;
      session_id: string;
    }>(
      `WITH RECURSIVE lineage AS (
         SELECT id,parent_turn_id,source,source_id,message_id,proactive,session_id,0 AS depth FROM turns
           WHERE id=$1 AND owner_id=$2 AND thread_id=$3
         UNION ALL SELECT p.id,p.parent_turn_id,p.source,p.source_id,p.message_id,p.proactive,p.session_id,c.depth+1
           FROM turns p JOIN lineage c ON c.parent_turn_id=p.id WHERE p.owner_id=$2 AND c.depth<100
       ) SELECT source,source_id,message_id,proactive,session_id FROM lineage ORDER BY depth`,
      [turn.turnId, ownerId, turn.threadId],
    );
    const current = rows[0];
    const root = rows.at(-1);
    if (!current || !root || rows.some((row) => row.proactive)) return { kind: 'other' };
    if (root.source === 'user' && root.message_id)
      return { kind: 'owner', sessionId: current.session_id };
    const scheduleId =
      root.source === 'schedule' ? scheduleSource.exec(root.source_id ?? '')?.[1] : undefined;
    return scheduleId
      ? { kind: 'schedule', sessionId: current.session_id, scheduleId: scheduleId.toLowerCase() }
      : { kind: 'other' };
  }

  async function allowed(client: Query, turn: TurnRef) {
    const found = await origin(client, turn);
    if (found.kind === 'other') throw failure(refused, 403);
    return found;
  }

  async function target(
    client: Query,
    input: { pageId?: string; title?: string; revision?: number },
  ) {
    let row: PageRow | undefined;
    if (input.pageId) {
      row = (await pages(client, { id: input.pageId }))[0];
      if (!row)
        throw failure('No page has that pageId. Read pages list for the pages and their ids.', 404);
    } else {
      const rows = await pages(client, { title: input.title });
      if (rows.length > 1)
        throw failure(
          'More than one page has that title. Use its pageId from pages list to update one.',
          409,
        );
      row = rows[0];
    }
    if (row?.archived_at)
      throw failure(
        `The page “${row.title}” is archived, and Nod can't update an archived page. The owner can unarchive it on the Pages tab; for a separate page, publish with another title.`,
        409,
      );
    if (input.revision !== undefined && row?.revision !== input.revision)
      throw failure(
        row
          ? `The page changed since you read it: it is now at version ${row.revision}, and you edited version ${input.revision}. Read it again with pages get, make your change on that copy, then publish with revision ${row.revision}.`
          : 'No page has that title. Leave out revision to make a new page.',
        409,
      );
    return row;
  }

  async function expire(client: Query, ids: string[]) {
    if (!ids.length) return;
    await client.query(
      `UPDATE artifacts a SET expires_at=clock_timestamp() WHERE a.owner_id=$1 AND a.id=ANY($2::uuid[]) AND a.deleting_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.owner_id=$1 AND p.artifact_id=a.id)
         AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.owner_id=$1 AND v.artifact_id=a.id)`,
      [ownerId, [...new Set(ids)]],
    );
  }

  async function save(
    client: PoolClient,
    existing: PageRow | undefined,
    change: { title: string; artifactId: string; digest: string; by: Publisher },
  ) {
    await options.artifacts.retainArtifacts([change.artifactId], client);
    const id = existing?.id ?? randomUUID();
    const revision = (existing?.revision ?? 0) + 1;
    if (existing)
      await client.query(
        `UPDATE pages SET title=$3,artifact_id=$4,revision=$5,updated_at=now(),session_id=$6,schedule_id=$7
         WHERE id=$1 AND owner_id=$2`,
        [
          id,
          ownerId,
          change.title,
          change.artifactId,
          revision,
          change.by.sessionId,
          change.by.scheduleId,
        ],
      );
    else
      await client.query(
        `INSERT INTO pages(id,owner_id,title,artifact_id,revision,session_id,schedule_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          ownerId,
          change.title,
          change.artifactId,
          revision,
          change.by.sessionId,
          change.by.scheduleId,
        ],
      );
    await client.query(
      `INSERT INTO page_versions(owner_id,page_id,revision,artifact_id,digest,session_id,schedule_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        ownerId,
        id,
        revision,
        change.artifactId,
        change.digest,
        change.by.sessionId,
        change.by.scheduleId,
      ],
    );
    const dropped = await client.query<{ artifact_id: string }>(
      'DELETE FROM page_versions WHERE owner_id=$1 AND page_id=$2 AND revision<=$3 RETURNING artifact_id',
      [ownerId, id, revision - keptPageVersions],
    );
    await expire(
      client,
      dropped.rows.map((row) => row.artifact_id),
    );
    return onePage(client, id);
  }

  function workspacePath(threadId: string, value: string) {
    const base = `/workspace/${threadId}`;
    const actual = posix.resolve(base, value);
    if (value.includes('\\') || value.includes('\0') || !actual.startsWith(`${base}/`))
      throw failure(`publish takes a file inside this workspace, under ${base}/.`);
    if (!/\.html?$/i.test(actual))
      throw failure(`${actual} is not an .html file. A page is one .html file.`);
    return posix.relative(base, actual);
  }

  async function publish(
    turn: TurnRef,
    input: { title?: string; workspaceFile: string; pageId?: string; revision?: number },
  ) {
    const workspace = options.workspace;
    if (!workspace) throw failure('The workspace is unavailable.', 503);
    await allowed(pool, turn);
    const path = workspacePath(turn.threadId, input.workspaceFile);
    const where = `/workspace/${turn.threadId}/${path}`;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(
        await workspace.readArtifact(turn.threadId, path, pageBytes, 'attachment'),
      );
    } catch (error) {
      throw failure(
        `Nod couldn't read ${where} (${error instanceof Error ? error.message : String(error)}). A page is one .html file of at most ${megabytes}.`,
      );
    }
    checkPage(bytes, where);
    const hash = digest(bytes);
    const before = await target(pool, input);
    const stored =
      before?.digest === hash
        ? undefined
        : await options.artifacts.storeArtifact(
            bytes,
            storedName(before?.title ?? input.title ?? 'Page'),
            'text/html',
            undefined,
            undefined,
            undefined,
            true,
          );
    return turnWrite(turn, async (client) => {
      const by = await allowed(client, turn);
      const existing = await target(client, input);
      if (existing && existing.digest === hash) {
        if (stored) await expire(client, [stored.id]);
        return { page: existing, created: false, unchanged: true };
      }
      if (!stored)
        throw failure('The page changed while Nod was publishing it. Publish it again.', 409);
      const page = await save(client, existing, {
        title: existing?.title ?? input.title!,
        artifactId: stored.id,
        digest: hash,
        by: { sessionId: by.sessionId, scheduleId: by.kind === 'schedule' ? by.scheduleId : null },
      });
      return { page, created: !existing, unchanged: false };
    });
  }

  async function execute(turn: TurnRef, raw: unknown) {
    const request = parse(toolInput, raw, 'The pages request');
    const result = async (): Promise<unknown> => {
      switch (request.action) {
        case 'list':
          return { pages: (await pages(pool)).map(toolView) };
        case 'get': {
          if (!options.workspace) throw failure('The workspace is unavailable.', 503);
          const row = (await pages(pool, { id: request.pageId }))[0];
          if (!row)
            throw failure(
              'No page has that pageId. Read pages list for the pages and their ids.',
              404,
            );
          if (row.file_size === null) throw failure("This page's file is unavailable.", 409);
          const path = `pages/${row.id}.html`;
          await options.workspace.writeArtifact(
            turn.threadId,
            path,
            await options.artifacts.readArtifact(row.artifact_id),
            turn.signal,
          );
          return { ...toolView(row), workspaceFile: `/workspace/${turn.threadId}/${path}` };
        }
        case 'publish': {
          const { page, created, unchanged } = await publish(turn, request);
          return { ...toolView(page), created, unchanged };
        }
      }
    };
    return untrustedBlock('pages', JSON.stringify(await result()));
  }

  async function keep(input: { artifactId: string; title?: string }) {
    const artifact = (
      await pool.query<{ id: string; name: string; mime_type: string; size: number }>(
        'SELECT id,name,mime_type,size FROM artifacts WHERE id=$1 AND owner_id=$2 AND deleting_at IS NULL',
        [input.artifactId, ownerId],
      )
    ).rows[0];
    if (!artifact) throw failure('The file is unavailable.', 404);
    if (artifact.mime_type !== 'text/html' && !/\.html?$/i.test(artifact.name))
      throw failure('Only an HTML file can be kept in Pages.');
    if (artifact.size > pageBytes)
      throw failure(`This file is larger than ${megabytes}, the most a page holds.`);
    const bytes = Buffer.from(await options.artifacts.readArtifact(artifact.id));
    checkPage(bytes, artifact.name);
    const named = input.title ?? (pageTitle(artifact.name.replace(/\.html?$/i, '')) || 'Page');
    const hash = digest(bytes);
    const already = async (client: Query) => {
      const kept = (await pages(client)).find((row) => !row.archived_at && row.digest === hash);
      if (kept) throw failure(`This file is already in Pages as “${kept.title}”.`, 409);
    };
    await already(pool);
    const stored = await options.artifacts.storeArtifact(
      bytes,
      storedName(named),
      'text/html',
      undefined,
      undefined,
      undefined,
      true,
    );
    return owned(async (client) => {
      await already(client);
      return pageView(
        await save(client, undefined, {
          title: named,
          artifactId: stored.id,
          digest: hash,
          by: { sessionId: null, scheduleId: null },
        }),
      );
    });
  }

  async function restoreVersion(id: string, revision: number, expected: number) {
    return owned(async (client) => {
      const row = await onePage(client, id);
      if (row.revision !== expected)
        throw failure(
          `This page changed while you were looking at it; it is now at version ${row.revision}. Check the new version, then restore again.`,
          409,
        );
      const version = (
        await client.query<{ artifact_id: string; digest: string }>(
          'SELECT artifact_id,digest FROM page_versions WHERE owner_id=$1 AND page_id=$2 AND revision=$3',
          [ownerId, row.id, revision],
        )
      ).rows[0];
      if (!version) throw failure('That earlier version is no longer kept.', 404);
      if (version.digest === row.digest) return pageView(row);
      return pageView(
        await save(client, row, {
          title: row.title,
          artifactId: version.artifact_id,
          digest: version.digest,
          by: { sessionId: null, scheduleId: null },
        }),
      );
    });
  }

  async function remove(client: PoolClient, id: string) {
    const row = await onePage(client, id);
    const { rows } = await client.query<{ artifact_id: string }>(
      'SELECT artifact_id FROM page_versions WHERE owner_id=$1 AND page_id=$2',
      [ownerId, row.id],
    );
    await client.query('DELETE FROM pages WHERE id=$1 AND owner_id=$2', [row.id, ownerId]);
    await expire(client, [row.artifact_id, ...rows.map((entry) => entry.artifact_id)]);
  }

  function registerRoutes(app: FastifyInstance) {
    const revision = z.int().min(1);
    app.get('/api/pages', async () => (await pages(pool)).map(pageView));
    app.post('/api/pages', async (request) =>
      keep(
        parse(
          z.object({ artifactId: z.uuid(), title: title.optional() }).strict(),
          request.body,
          'The page',
        ),
      ),
    );
    app.get<{ Params: { id: string } }>('/api/pages/:id', async (request) =>
      pageView(await onePage(pool, request.params.id)),
    );
    app.get<{ Params: { id: string } }>('/api/pages/:id/versions', (request) =>
      versions(pool, request.params.id),
    );
    app.post<{ Params: { id: string; revision: string } }>(
      '/api/pages/:id/versions/:revision/restore',
      async (request) => {
        const input = parse(z.object({ revision }).strict(), request.body, 'The restore');
        return restoreVersion(
          request.params.id,
          parse(z.coerce.number().pipe(revision), request.params.revision, 'The version'),
          input.revision,
        );
      },
    );
    app.patch<{ Params: { id: string } }>('/api/pages/:id', async (request) => {
      const input = parse(
        z.object({ title, current: z.string().max(1000) }).strict(),
        request.body,
        'The page change',
      );
      return pageView(
        await owned(async (client) => {
          const row = await onePage(client, request.params.id);
          if (row.title !== input.current)
            throw failure(
              `This page was renamed to “${row.title}” while you were renaming it. Rename it again.`,
              409,
            );
          await client.query(
            'UPDATE pages SET title=$3 WHERE id=$1 AND owner_id=$2 AND title<>$3',
            [row.id, ownerId, input.title],
          );
          return onePage(client, row.id);
        }),
      );
    });
    for (const [action, archived] of [
      ['archive', true],
      ['unarchive', false],
    ] as const)
      app.post<{ Params: { id: string } }>(`/api/pages/:id/${action}`, async (request) =>
        pageView(
          await owned(async (client) => {
            const row = await onePage(client, request.params.id);
            await client.query(
              `UPDATE pages SET archived_at=${archived ? 'COALESCE(archived_at,now())' : 'NULL'} WHERE id=$1 AND owner_id=$2`,
              [row.id, ownerId],
            );
            return onePage(client, row.id);
          }),
        ),
      );
    app.delete<{ Params: { id: string } }>('/api/pages/:id', async (request) => {
      await owned((client) => remove(client, request.params.id));
      return { ok: true };
    });
  }

  return { execute, registerRoutes };
}
