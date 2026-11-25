import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AgentSchedules } from '../shared/agents.ts';
import type { ModelSelection, WorkKind } from '../shared/models.ts';
import { afterCommit, transaction } from './transaction.ts';
import type { TrustReason } from './trust.ts';
import type { TrustBasis } from './trust-basis.ts';
import { workOriginSql } from './turn-chain.ts';

type Client = Pick<PoolClient, 'query'>;
type Origin = { kind: WorkKind; task: ModelSelection | null; schedule: ModelSelection | null };

const linkInput = z
  .object({ agentId: z.uuid().nullable(), useAgentModel: z.boolean().default(false) })
  .strict();
const askedLink = z
  .object({
    scheduleId: z.uuid(),
    agent: z.string().trim().min(1).max(60).nullable(),
    useAgentModel: z.boolean().optional(),
  })
  .strict();
const approvedLink = z
  .object({
    scheduleId: z.uuid(),
    schedule: z.string(),
    agentId: z.uuid().nullable(),
    agent: z.string().nullable(),
    useAgentModel: z.boolean(),
  })
  .strict();

function failure(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

export function createAgentSchedules(options: {
  pool: Pool;
  ownerId: string;
  refresh?: () => void;
}) {
  const { pool, ownerId } = options;
  const refresh = options.refresh ?? (() => {});

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_schedules (
        schedule_id uuid PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
        owner_id text NOT NULL,
        agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        use_agent_model boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_schedules_agent ON agent_schedules(agent_id);
    `);
  }

  async function view(): Promise<AgentSchedules> {
    const [agents, links] = await Promise.all([
      pool.query('SELECT id,name FROM agents WHERE owner_id=$1 ORDER BY lower(name),id', [ownerId]),
      pool.query(
        `SELECT s.schedule_id AS "scheduleId",s.agent_id AS "agentId",
           s.use_agent_model AS "useAgentModel",x.title
         FROM agent_schedules s JOIN schedules x ON x.id=s.schedule_id AND x.owner_id=s.owner_id
         WHERE s.owner_id=$1 ORDER BY lower(x.title),x.id`,
        [ownerId],
      ),
    ]);
    return { agents: agents.rows, links: links.rows };
  }

  async function link(
    client: Client,
    scheduleId: string,
    agentId: string | null,
    useAgentModel: boolean,
  ) {
    const schedule = await client.query(
      'SELECT 1 FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [scheduleId, ownerId],
    );
    if (!schedule.rowCount) throw failure('Schedule not found.', 404);
    if (agentId) {
      const agent = await client.query('SELECT 1 FROM agents WHERE id=$1 AND owner_id=$2', [
        agentId,
        ownerId,
      ]);
      if (!agent.rowCount) throw failure('Agent not found.', 404);
      await client.query(
        `INSERT INTO agent_schedules(schedule_id,owner_id,agent_id,use_agent_model) VALUES($1,$2,$3,$4)
         ON CONFLICT(schedule_id) DO UPDATE SET agent_id=EXCLUDED.agent_id,use_agent_model=EXCLUDED.use_agent_model`,
        [scheduleId, ownerId, agentId, useAgentModel],
      );
    } else
      await client.query('DELETE FROM agent_schedules WHERE schedule_id=$1 AND owner_id=$2', [
        scheduleId,
        ownerId,
      ]);
    afterCommit(client, refresh);
  }

  async function modelOrigin(turnId: string, origin: Origin | undefined) {
    if (!origin || origin.kind !== 'schedule' || origin.task || origin.schedule) return origin;
    const model = (
      await pool.query<{ model: ModelSelection | null }>(
        `SELECT chat.model FROM turns cur ${workOriginSql('cur')}
         JOIN agent_schedules s ON s.owner_id=cur.owner_id AND s.schedule_id=work_schedule.id
           AND s.use_agent_model
         JOIN agents a ON a.id=s.agent_id AND a.owner_id=s.owner_id
         JOIN tasks chat ON chat.id=a.chat_id AND chat.owner_id=a.owner_id
         WHERE cur.id=$1 AND cur.owner_id=$2`,
        [turnId, ownerId],
      )
    ).rows[0]?.model;
    return model ? { ...origin, schedule: model } : origin;
  }

  async function request(
    turnId: string,
    args: Record<string, unknown>,
    review: {
      check(
        input: Record<string, unknown>,
      ): Promise<{ confirm: false; basis: TrustBasis } | { confirm: true; reason: TrustReason }>;
      ask(
        input: Record<string, unknown>,
        decision: { allowed: boolean; basis?: TrustBasis; details: Record<string, unknown> },
      ): Promise<unknown>;
    },
  ) {
    const asked = askedLink.parse(args);
    const schedule = (
      await pool.query<{ title: string }>(
        'SELECT title FROM schedules WHERE id=$1 AND owner_id=$2',
        [asked.scheduleId, ownerId],
      )
    ).rows[0];
    if (!schedule) throw new Error('Schedule not found. Read schedule_list for its id.');
    const agent =
      asked.agent === null
        ? null
        : (
            await pool.query<{ id: string; name: string }>(
              'SELECT id,name FROM agents WHERE owner_id=$1 AND lower(name)=lower($2)',
              [ownerId, asked.agent],
            )
          ).rows[0];
    if (agent === undefined) {
      const names = (
        await pool.query<{ name: string }>(
          'SELECT name FROM agents WHERE owner_id=$1 ORDER BY lower(name)',
          [ownerId],
        )
      ).rows.map(({ name }) => JSON.stringify(name));
      throw new Error(
        names.length
          ? `No agent is named ${JSON.stringify(asked.agent)}. The agents are ${names.join(', ')}.`
          : 'There are no agents yet. The owner makes one from a chat header.',
      );
    }
    const current = (
      await pool.query<{ agent: string; useAgentModel: boolean }>(
        `SELECT a.name AS agent,s.use_agent_model AS "useAgentModel" FROM agent_schedules s
         JOIN agents a ON a.id=s.agent_id AND a.owner_id=s.owner_id
         WHERE s.schedule_id=$1 AND s.owner_id=$2`,
        [asked.scheduleId, ownerId],
      )
    ).rows[0] ?? { agent: null, useAgentModel: false };
    const input = {
      scheduleId: asked.scheduleId,
      schedule: schedule.title,
      agentId: agent?.id ?? null,
      agent: agent?.name ?? null,
      useAgentModel: Boolean(
        agent && (asked.useAgentModel ?? (current.agent === agent.name && current.useAgentModel)),
      ),
    };
    if (input.agent === current.agent && input.useAgentModel === current.useAgentModel)
      throw new Error('This schedule already runs that way.');
    const verdict = await review.check({ ...input, current });
    const allowed = !verdict.confirm && verdict.basis.kind === 'message';
    return review.ask(input, {
      allowed,
      ...(!verdict.confirm && allowed ? { basis: verdict.basis } : {}),
      details: { current, ...(verdict.confirm ? { reason: verdict.reason } : {}) },
    });
  }

  async function validate(raw: Record<string, unknown>, client: Client = pool) {
    const input = approvedLink.parse(raw);
    const named = await client.query(
      `SELECT 1 FROM schedules x WHERE x.id=$1 AND x.owner_id=$2 AND x.title=$3
         AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM agents a WHERE a.id=$4 AND a.owner_id=$2 AND a.name=$5))`,
      [input.scheduleId, ownerId, input.schedule, input.agentId, input.agent],
    );
    if (!named.rowCount)
      throw failure('The schedule or agent changed. Review it before asking again.', 409);
    return input;
  }

  async function apply(raw: Record<string, unknown>, client: Client) {
    const input = await validate(raw, client);
    await link(client, input.scheduleId, input.agentId, input.useAgentModel);
    return { schedule: input.schedule, agent: input.agent, useAgentModel: input.useAgentModel };
  }

  async function adopt(turnId: string, created: unknown) {
    const schedule = created as { id?: unknown; existing?: unknown } | null;
    if (!schedule || typeof schedule.id !== 'string' || schedule.existing) return;
    const adopted = await pool.query(
      `INSERT INTO agent_schedules(schedule_id,owner_id,agent_id)
       SELECT x.id,x.owner_id,a.id FROM turns u
       JOIN agents a ON a.owner_id=u.owner_id AND a.chat_id=u.session_id
       JOIN schedules x ON x.id=$3 AND x.owner_id=u.owner_id
       WHERE u.id=$1 AND u.owner_id=$2 ON CONFLICT(schedule_id) DO NOTHING`,
      [turnId, ownerId, schedule.id],
    );
    if (adopted.rowCount) refresh();
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/agents/schedules', view);
    app.put<{ Params: { id: string } }>('/api/agents/schedules/:id', async (request) => {
      const scheduleId = z.uuid().parse(request.params.id);
      const { agentId, useAgentModel } = linkInput.parse(request.body);
      await transaction(
        (client) => link(client, scheduleId, agentId, Boolean(agentId) && useAgentModel),
        pool,
      );
      return view();
    });
  }

  return { initialize, modelOrigin, request, validate, apply, adopt, registerRoutes };
}
