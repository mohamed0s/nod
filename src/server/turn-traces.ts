import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ModelCallTrace } from '../ports/traces.ts';
import { events } from './events.ts';
import { logFailure } from './failure-log.ts';
import type { CapturedCall } from './traces.ts';

const retentionDays = 14;
const pruneEveryMs = 60 * 60 * 1000;
const queueLimit = 50;

export function createTurnTraces(options: { pool: Pool; ownerId: string }) {
  const { pool, ownerId } = options;
  let pruned = 0;
  let queued = 0;
  let pending = Promise.resolve();

  async function store(entry: CapturedCall) {
    const { id, json } = entry.build();
    const { rowCount } = await pool.query(
      `INSERT INTO model_call_traces(id,owner_id,turn_id,call)
       SELECT $1,$2,$3,$4::jsonb WHERE EXISTS (SELECT 1 FROM turns WHERE id=$3 AND owner_id=$2)`,
      [id, ownerId, entry.turnId, json],
    );
    if (rowCount) events.emit('event', { type: 'trace', ownerId, turnId: entry.turnId });
  }

  function prune() {
    if (Date.now() - pruned < pruneEveryMs) return;
    pruned = Date.now();
    void pool
      .query(
        `DELETE FROM model_call_traces WHERE owner_id=$1 AND created_at < now() - make_interval(days => $2)`,
        [ownerId, retentionDays],
      )
      .catch((error) => logFailure('model_call_trace_prune', error));
  }

  return {
    record(entry: CapturedCall) {
      if (!z.uuid().safeParse(entry.turnId).success || queued >= queueLimit) return;
      queued++;
      pending = pending
        .then(() => store(entry))
        .catch((error) => logFailure('model_call_trace_store', error))
        .finally(() => queued--);
      prune();
    },
    read,
    list,
    registerRoutes(app: FastifyInstance) {
      app.get('/api/traces', async () => ({ turns: await list() }));
      app.get<{ Params: { id: string } }>('/api/turns/:id/trace', async (request, reply) => {
        const found = await read(z.uuid().parse(request.params.id));
        if (!found) return reply.code(404).send({ error: 'Turn not found.' });
        return found;
      });
    },
  };

  async function list() {
    const { rows } = await pool.query(
      `SELECT id, source, status, left(prompt, 120) AS prompt, created_at, started_at
         FROM turns WHERE owner_id=$1 AND started_at IS NOT NULL
         ORDER BY started_at DESC, id DESC LIMIT 40`,
      [ownerId],
    );
    return rows.map((row) => ({
      id: row.id as string,
      source: row.source as string,
      status: row.status as string,
      prompt: row.prompt as string,
      createdAt: row.created_at as Date,
      startedAt: row.started_at as Date,
    }));
  }

  async function read(turnId: string) {
    const [turn, calls, steps] = await Promise.all([
      pool.query(
        `SELECT id, thread_id, source, status, background, parent_turn_id, prompt, created_at, started_at, finished_at
           FROM turns WHERE id=$1 AND owner_id=$2`,
        [turnId, ownerId],
      ),
      pool.query(
        'SELECT call FROM model_call_traces WHERE turn_id=$1 AND owner_id=$2 ORDER BY created_at, id',
        [turnId, ownerId],
      ),
      pool.query(
        `SELECT e.id, e.type, e.summary, e.detail, e.run_id, e.parent_run_id, e.call_id, e.created_at
           FROM turn_events e JOIN turns t ON t.id=e.turn_id
           WHERE e.turn_id=$1 AND t.owner_id=$2 ORDER BY e.created_at, e.id`,
        [turnId, ownerId],
      ),
    ]);
    const row = turn.rows[0];
    if (!row) return undefined;
    return {
      turn: {
        id: row.id,
        threadId: row.thread_id,
        source: row.source,
        status: row.status,
        background: row.background,
        parentTurnId: row.parent_turn_id,
        prompt: row.prompt,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      },
      calls: calls.rows.map((item) => item.call as ModelCallTrace),
      steps: steps.rows.map((item) => ({
        id: item.id,
        type: item.type,
        summary: item.summary,
        detail: item.detail,
        runId: item.run_id,
        parentRunId: item.parent_run_id,
        callId: item.call_id,
        createdAt: item.created_at,
      })),
    };
  }
}
