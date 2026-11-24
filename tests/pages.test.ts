import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { runPagesTool } from '../src/runtime/pages-tool.ts';
import type { Turn } from '../src/runtime/turn.ts';

function records(text: unknown) {
  assert.equal(typeof text, 'string');
  const value = text as string;
  return JSON.parse(
    value.slice(value.indexOf('\n\n') + 2, value.lastIndexOf('\n</untrusted_tool_result>')),
  );
}

test('subagents can only list and read pages', async () => {
  const calls: string[] = [];
  const turn = (parentRunId?: string) =>
    ({
      execution: { parentRunId },
      context: {
        manage: async (_name: string, input: { action: string }) => {
          calls.push(input.action);
          return 'pages';
        },
      },
    }) as unknown as Turn;
  await assert.rejects(
    runPagesTool(turn('helper'), { action: 'publish' }),
    /subagent can only list and read/,
  );
  for (const action of ['list', 'get'])
    assert.equal(await runPagesTool(turn('helper'), { action }), 'pages');
  assert.equal(await runPagesTool(turn(), { action: 'publish' }), 'pages');
  assert.deepEqual(calls, ['list', 'get', 'publish']);
});

test(
  'pages stay with their owner and only owner-started or scheduled work publishes them',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 90_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_pages_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = `test_pages_boss_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), 'nod-pages-'));
    const db = await import('../src/server/db.ts');
    const { createArtifactService } = await import('../src/server/artifacts.ts');
    const { createPages } = await import('../src/server/pages.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const { withTurnLock } = await import('../src/server/thread.ts');
    const files = new Map<string, Buffer>();
    const owner = (ownerId: string) => {
      const artifacts = createArtifactService({ database: db.pool, ownerId, localRoot: root });
      const pages = createPages({
        pool: db.pool,
        ownerId,
        artifacts,
        workspace: {
          writeArtifact: async (threadId, path, bytes) => {
            files.set(`${threadId}/${path}`, Buffer.from(bytes));
          },
          readArtifact: async (threadId, path) => {
            const file = files.get(`${threadId}/${path}`);
            if (!file) throw new Error('The workspace file operation failed.');
            return Buffer.from(file);
          },
        },
        withTurnLock,
      });
      const app = Fastify();
      pages.registerRoutes(app);
      return { ownerId, artifacts, pages, app };
    };
    const a = owner('local-development');
    const b = owner('synthetic-owner-b');
    type Side = typeof a;
    const threads = new Map<string, string>();
    const thread = async (side: Side) => {
      if (!threads.has(side.ownerId)) {
        const id = randomUUID();
        await db.pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [id, side.ownerId]);
        threads.set(side.ownerId, id);
      }
      return threads.get(side.ownerId)!;
    };
    const turn = async (
      side: Side,
      source: string,
      options: { parent?: string; sourceId?: string; proactive?: boolean } = {},
    ) => {
      const threadId = await thread(side);
      const turnId = randomUUID();
      await db.pool.query(
        `INSERT INTO turns(id,owner_id,thread_id,session_id,source,source_id,prompt,message_id,status,parent_turn_id,proactive)
         VALUES($1,$2,$3,$3,$4,$5,'synthetic',$6,'running',$7,$8)`,
        [
          turnId,
          side.ownerId,
          threadId,
          source,
          options.sourceId ?? null,
          source === 'user' ? randomUUID() : null,
          options.parent ?? null,
          options.proactive ?? false,
        ],
      );
      return { threadId, turnId };
    };
    const write = (place: { threadId: string }, path: string, body: string | Buffer) =>
      files.set(`${place.threadId}/${path}`, Buffer.from(body));
    const html = (text: string) => `<!doctype html><title>Synthetic</title><p>${text}</p>`;
    const publish = async (
      side: Side,
      place: { threadId: string; turnId: string; signal?: AbortSignal },
      input: Record<string, unknown>,
    ) => records(await side.pages.execute(place, { action: 'publish', ...input }));
    const request = (side: Side, method: string, path: string, payload?: unknown) =>
      side.app.inject({ method: method as 'GET', url: path, payload: payload as object });
    const expires = async (id: string) =>
      (await db.pool.query('SELECT expires_at FROM artifacts WHERE id=$1', [id])).rows[0]
        ?.expires_at as Date | null | undefined;
    const artifactOf = async (pageId: string) =>
      (await db.pool.query('SELECT artifact_id FROM pages WHERE id=$1', [pageId])).rows[0]
        .artifact_id as string;
    try {
      await db.initializeDatabase();
      await createTasks({ pool: db.pool, ownerId: 'synthetic-owner-c' }).initialize();
      await db.pool.query('CREATE TABLE IF NOT EXISTS schedules(id uuid,owner_id text,title text)');
      await Promise.all([a.app.ready(), b.app.ready()]);

      let trackerId = '';
      await t.test('owner-started work and schedules publish, other work does not', async () => {
        const started = await turn(a, 'user');
        write(started, 'tracker.html', html('first'));
        const made = await publish(a, started, {
          title: 'Reading tracker',
          workspaceFile: 'tracker.html',
        });
        assert.equal(made.created, true);
        assert.deepEqual(made.publishedBy, { kind: 'chat', current: true });
        trackerId = made.pageId;

        const task = await turn(a, 'task', { parent: started.turnId });
        write(task, 'tracker.html', html('from a task'));
        const fromTask = await publish(a, task, {
          pageId: trackerId,
          title: 'Renamed in chat',
          workspaceFile: 'tracker.html',
        });
        assert.equal(fromTask.revision, 2);
        assert.equal(fromTask.title, 'Reading tracker');

        const scheduleId = randomUUID();
        await db.pool.query('INSERT INTO schedules(id,owner_id,title) VALUES($1,$2,$3)', [
          scheduleId,
          a.ownerId,
          'Morning refresh',
        ]);
        const scheduled = await turn(a, 'schedule', {
          sourceId: `schedule:${scheduleId}:${randomUUID()}`,
        });
        write(scheduled, 'tracker.html', html('from a schedule'));
        const refreshed = await publish(a, scheduled, {
          pageId: trackerId,
          title: 'Renamed by a schedule',
          workspaceFile: 'tracker.html',
        });
        assert.equal(refreshed.pageId, trackerId);
        assert.equal(refreshed.title, 'Reading tracker');
        assert.deepEqual(refreshed.publishedBy, {
          kind: 'schedule',
          id: scheduleId,
          title: 'Morning refresh',
        });

        for (const other of [
          await turn(a, 'event'),
          await turn(a, 'schedule'),
          await turn(a, 'user', { proactive: true }),
          await turn(a, 'task', { parent: (await turn(a, 'event')).turnId }),
        ]) {
          write(other, 'tracker.html', html('not allowed'));
          await assert.rejects(
            publish(a, other, { pageId: trackerId, workspaceFile: 'tracker.html' }),
            /Only work started by an owner message, or a schedule/,
          );
          await assert.rejects(
            publish(a, other, { title: 'Another page', workspaceFile: 'tracker.html' }),
            /Only work started by an owner message, or a schedule/,
          );
        }
        assert.equal((await request(a, 'GET', '/api/pages')).json().length, 1);
        assert.equal((await request(a, 'GET', `/api/pages/${trackerId}`)).json().revision, 3);
      });

      await t.test(
        'an update keeps the same page and keeps only the last ten versions',
        async () => {
          const started = await turn(a, 'user');
          const version = async (revision: number) =>
            (
              await db.pool.query(
                'SELECT artifact_id FROM page_versions WHERE page_id=$1 AND revision=$2',
                [trackerId, revision],
              )
            ).rows[0].artifact_id as string;
          const [first, second, third] = [await version(1), await version(2), await version(3)];
          for (let count = 4; count <= 12; count++) {
            write(started, 'tracker.html', html(`version ${count}`));
            const page = await publish(a, started, {
              title: count % 2 ? 'READING tracker' : undefined,
              pageId: count % 2 ? undefined : trackerId,
              workspaceFile: 'tracker.html',
            });
            assert.equal(page.pageId, trackerId);
            assert.equal(page.revision, count);
          }
          const unchanged = await publish(a, started, {
            pageId: trackerId,
            workspaceFile: 'tracker.html',
          });
          assert.equal(unchanged.unchanged, true);
          assert.equal(unchanged.revision, 12);
          const versions = (await request(a, 'GET', `/api/pages/${trackerId}/versions`)).json();
          assert.deepEqual(
            versions.map((version: { revision: number }) => version.revision),
            [12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
          );
          assert.ok(await expires(first));
          assert.ok(await expires(second));
          assert.equal(await expires(third), null);
          assert.equal(await expires(await artifactOf(trackerId)), null);
          assert.equal((await request(a, 'GET', '/api/pages')).json().length, 1);
        },
      );

      await t.test('publish takes one .html file of at most 2 MB in UTF-8', async () => {
        const started = await turn(a, 'user');
        write(started, 'notes.txt', 'plain text');
        write(started, 'large.html', Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
        write(started, 'latin.html', Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c]));
        for (const [workspaceFile, reason] of [
          ['notes.txt', /not an \.html file/],
          ['large.html', /larger than 2 MB/],
          ['latin.html', /not UTF-8/],
          ['../elsewhere/page.html', /inside this workspace/],
        ] as const)
          await assert.rejects(publish(a, started, { title: 'Refused', workspaceFile }), reason);
        assert.equal((await request(a, 'GET', '/api/pages')).json().length, 1);
      });

      await t.test('another owner never sees or changes a page', async () => {
        const theirs = await turn(b, 'user');
        assert.deepEqual((await request(b, 'GET', '/api/pages')).json(), []);
        assert.deepEqual(records(await b.pages.execute(theirs, { action: 'list' })).pages, []);
        assert.equal((await request(b, 'GET', `/api/pages/${trackerId}`)).statusCode, 404);
        assert.equal((await request(b, 'DELETE', `/api/pages/${trackerId}`)).statusCode, 404);
        await assert.rejects(
          b.pages.execute(theirs, { action: 'get', pageId: trackerId }),
          /No page has that pageId/,
        );
        write(theirs, 'tracker.html', html('theirs'));
        await assert.rejects(
          publish(b, theirs, { pageId: trackerId, workspaceFile: 'tracker.html' }),
          /No page has that pageId/,
        );
        assert.equal(
          (await request(b, 'POST', '/api/pages', { artifactId: await artifactOf(trackerId) }))
            .statusCode,
          404,
        );
        assert.equal((await request(a, 'GET', `/api/pages/${trackerId}`)).json().revision, 12);
      });

      await t.test('a publish from a copy read before a newer version is refused', async () => {
        const chat = await turn(a, 'user');
        write(chat, 'plan.html', html('plan one'));
        const plan = await publish(a, chat, { title: 'Weekly plan', workspaceFile: 'plan.html' });
        const read = records(await a.pages.execute(chat, { action: 'get', pageId: plan.pageId }));
        assert.equal(read.revision, 1);
        const copy = read.workspaceFile.slice(`/workspace/${chat.threadId}/`.length);
        assert.ok(files.has(`${chat.threadId}/${copy}`));
        const scheduleId = randomUUID();
        await db.pool.query('INSERT INTO schedules(id,owner_id,title) VALUES($1,$2,$3)', [
          scheduleId,
          a.ownerId,
          'Plan refresh',
        ]);
        const scheduled = await turn(a, 'schedule', {
          sourceId: `schedule:${scheduleId}:${randomUUID()}`,
        });
        write(scheduled, 'plan.html', html('plan from the schedule'));
        await publish(a, scheduled, { pageId: plan.pageId, workspaceFile: 'plan.html' });
        write(chat, copy, html('plan with a stale edit'));
        await assert.rejects(
          publish(a, chat, { pageId: plan.pageId, revision: 1, workspaceFile: copy }),
          /changed since you read it: it is now at version 2/,
        );
        const fresh = records(await a.pages.execute(chat, { action: 'get', pageId: plan.pageId }));
        write(chat, copy, html('plan with a fresh edit'));
        assert.equal(
          (
            await publish(a, chat, {
              pageId: plan.pageId,
              revision: fresh.revision,
              workspaceFile: copy,
            })
          ).revision,
          3,
        );
        assert.equal((await request(a, 'DELETE', `/api/pages/${plan.pageId}`)).statusCode, 200);
      });

      await t.test(
        'Keep in Pages copies an HTML file once and owner saves refuse stale changes',
        async () => {
          const shared = await a.artifacts.storeUpload(
            Buffer.from(html('kept')),
            'Weekly report.html',
            'text/html',
          );
          const kept = await request(a, 'POST', '/api/pages', { artifactId: shared.id });
          assert.equal(kept.statusCode, 200, kept.body);
          assert.equal(kept.json().title, 'Weekly report');
          assert.deepEqual(kept.json().source, { kind: 'owner' });
          assert.notEqual(kept.json().file.id, shared.id);
          assert.equal(
            (await request(a, 'POST', '/api/pages', { artifactId: shared.id })).statusCode,
            409,
          );
          const text = await a.artifacts.storeUpload(
            Buffer.from('plain'),
            'notes.txt',
            'text/plain',
          );
          assert.equal(
            (await request(a, 'POST', '/api/pages', { artifactId: text.id })).statusCode,
            400,
          );
          const rename = (current: string) =>
            request(a, 'PATCH', `/api/pages/${trackerId}`, { title: 'Books', current });
          const named = (await request(a, 'GET', `/api/pages/${trackerId}`)).json().title;
          assert.equal((await rename(`${named} before`)).statusCode, 409);
          assert.equal((await rename(named)).json().title, 'Books');
          const restore = (revision: number) =>
            request(a, 'POST', `/api/pages/${trackerId}/versions/5/restore`, { revision });
          assert.equal((await restore(11)).statusCode, 409);
          const restored = (await restore(12)).json();
          assert.equal(restored.revision, 13);
          assert.deepEqual(restored.source, { kind: 'owner' });
          const fifth = (
            await db.pool.query(
              'SELECT artifact_id FROM page_versions WHERE page_id=$1 AND revision=5',
              [trackerId],
            )
          ).rows[0].artifact_id;
          assert.equal(restored.file.id, fifth);
          const started = await turn(a, 'user');
          for (const count of [14, 15]) {
            write(started, 'tracker.html', html(`after the restore ${count}`));
            await publish(a, started, { pageId: trackerId, workspaceFile: 'tracker.html' });
          }
          const history = (await request(a, 'GET', `/api/pages/${trackerId}/versions`)).json();
          assert.equal(history.at(-1).revision, 6);
          assert.equal(
            history.find((entry: { revision: number }) => entry.revision === 13).file.id,
            fifth,
          );
          assert.equal(await expires(fifth), null);
          const archived = await request(a, 'POST', `/api/pages/${trackerId}/archive`);
          assert.ok(archived.json().archivedAt);
          write(started, 'tracker.html', html('archived'));
          await assert.rejects(
            publish(a, started, { pageId: trackerId, workspaceFile: 'tracker.html' }),
            /archived/,
          );
          await assert.rejects(
            publish(a, started, { title: 'books', workspaceFile: 'tracker.html' }),
            /archived/,
          );
          assert.equal((await request(a, 'GET', '/api/pages')).json().length, 2);
          await request(a, 'POST', `/api/pages/${trackerId}/unarchive`);
        },
      );

      await t.test('delete expires its files unless a chat message still holds them', async () => {
        const started = await turn(a, 'user');
        write(started, 'brief.html', html('one'));
        const page = await publish(a, started, { title: 'Brief', workspaceFile: 'brief.html' });
        const older = await artifactOf(page.pageId);
        write(started, 'brief.html', html('two'));
        await publish(a, started, { pageId: page.pageId, workspaceFile: 'brief.html' });
        const newer = await artifactOf(page.pageId);
        await db.pool.query(
          `INSERT INTO messages(id,owner_id,role,text,thread_id,attachments) VALUES($1,$2,'assistant','synthetic',$3,$4)`,
          [randomUUID(), a.ownerId, started.threadId, JSON.stringify([{ id: newer }])],
        );
        assert.equal(await expires(older), null);
        assert.equal((await request(a, 'DELETE', `/api/pages/${page.pageId}`)).statusCode, 200);
        assert.ok(await expires(older));
        assert.ok(await expires(newer));
        assert.equal(
          (await db.pool.query('SELECT 1 FROM page_versions WHERE page_id=$1', [page.pageId]))
            .rowCount,
          0,
        );
        await a.artifacts.sweep();
        assert.equal(await expires(older), undefined);
        assert.ok(await expires(newer));
      });

      await t.test('a stopped turn publishes nothing', async () => {
        const started = await turn(a, 'user');
        write(started, 'late.html', html('late'));
        await db.pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [started.turnId]);
        await assert.rejects(
          publish(a, started, { title: 'Late page', workspaceFile: 'late.html' }),
          /no longer active/,
        );
        const running = await turn(a, 'user');
        write(running, 'late.html', html('late'));
        const stop = new AbortController();
        stop.abort();
        await assert.rejects(
          publish(
            a,
            { ...running, signal: stop.signal },
            {
              title: 'Late page',
              workspaceFile: 'late.html',
            },
          ),
          { name: 'AbortError' },
        );
        assert.equal(
          (await db.pool.query("SELECT 1 FROM pages WHERE title='Late page'")).rowCount,
          0,
        );
      });
    } finally {
      await Promise.allSettled([a.app.close(), b.app.close()]);
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
