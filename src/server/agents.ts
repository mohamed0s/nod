import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { agentLimits, type Agent } from '../shared/agents.ts';
import { afterCommit, transaction } from './transaction.ts';
import type { ApprovalDescription, ApprovalPresentation } from './approvals.ts';
import { channelText } from './channel-text.ts';
import { publicText } from './communication.ts';
import type { TrustReason } from './trust.ts';
import type { TrustBasis } from './trust-basis.ts';

type Client = Pick<PoolClient, 'query'>;

const hidden = /(?![\u200c\u200d])\p{Cf}/u;

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\r\n]*$/, 'Use one line.');
const profile = z.object({
  name: oneLine(agentLimits.name).min(1),
  description: oneLine(agentLimits.description),
  instructions: z.string().trim().max(agentLimits.instructions),
});
const memoryMode = z
  .enum(['shared', 'own', 'own_and_shared'])
  .refine((value) => value === 'shared', 'Only shared memory is available for agents for now.');
const changeInput = profile.partial().extend({ memoryMode: memoryMode.optional() }).strict();
const approvedChange = profile
  .partial()
  .extend({ id: z.uuid(), revision: z.number().int().positive() })
  .strict();

function failure(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

function conflict(error: unknown) {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  if (code !== '23505') return error;
  return constraint === 'agents_chat'
    ? failure('This chat is already an agent.', 409)
    : failure('Another agent already has this name.', 409);
}

export function createAgents(options: {
  pool: Pool;
  ownerId: string;
  refresh?: () => void;
  renamed?: (taskId: string, title: string) => void;
}) {
  const { pool, ownerId } = options;
  const refresh = options.refresh ?? (() => {});

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id uuid PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
        description text NOT NULL DEFAULT '', instructions text NOT NULL DEFAULT '',
        memory_mode text NOT NULL DEFAULT 'shared' CHECK (memory_mode IN ('shared','own','own_and_shared')),
        chat_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agents_chat ON agents(chat_id) WHERE chat_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS agents_name ON agents(owner_id,lower(name));
    `);
  }

  async function list(threadId?: string): Promise<Agent[]> {
    return (
      await pool.query<Agent>(
        `SELECT a.id,a.name,a.description,a.instructions,a.memory_mode AS "memoryMode",a.revision,
           CASE WHEN u.thread_id=$2 THEN a.chat_id END AS "chatId",t.model
         FROM agents a LEFT JOIN tasks t ON t.id=a.chat_id AND t.owner_id=a.owner_id
         LEFT JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         WHERE a.owner_id=$1 ORDER BY lower(a.name),a.id`,
        [ownerId, threadId ?? null],
      )
    ).rows;
  }

  async function context(sessionId: string) {
    return (
      await pool.query<{ name: string; description: string; instructions: string }>(
        'SELECT name,description,instructions FROM agents WHERE owner_id=$1 AND chat_id=$2',
        [ownerId, sessionId],
      )
    ).rows[0];
  }

  async function title(client: Client, chatId: string | null, name: string) {
    if (!chatId) return;
    await client.query(
      "UPDATE tasks SET title=$3,title_by='owner',updated_at=now() WHERE id=$1 AND owner_id=$2",
      [chatId, ownerId, name],
    );
    afterCommit(client, () => options.renamed?.(chatId, name));
  }

  async function make(raw: unknown) {
    const { chatId, ...input } = profile
      .partial({ description: true, instructions: true })
      .extend({ chatId: z.uuid() })
      .strict()
      .parse(raw);
    return transaction(async (client) => {
      const chat = await client.query(
        'SELECT 1 FROM tasks WHERE id=$1 AND owner_id=$2 AND session_id=id FOR UPDATE',
        [chatId, ownerId],
      );
      if (!chat.rowCount) throw failure('Chat not found.', 404);
      const id = randomUUID();
      await client
        .query(
          `INSERT INTO agents(id,owner_id,name,description,instructions,chat_id)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [id, ownerId, input.name, input.description ?? '', input.instructions ?? '', chatId],
        )
        .catch((error: unknown) => {
          throw conflict(error);
        });
      await title(client, chatId, input.name);
      afterCommit(client, refresh);
      return { id };
    }, pool);
  }

  async function change(
    client: Client,
    id: string,
    revision: number,
    input: z.infer<typeof changeInput>,
  ) {
    const updated = (
      await client
        .query<{ name: string; chat_id: string | null; renamed: boolean }>(
          `UPDATE agents a SET name=COALESCE($4,a.name),description=COALESCE($5,a.description),
             instructions=COALESCE($6,a.instructions),memory_mode=COALESCE($7,a.memory_mode),
             revision=a.revision+1,updated_at=now()
           FROM agents before WHERE a.id=$1 AND a.owner_id=$2 AND a.revision=$3 AND before.id=a.id
           RETURNING a.name,a.chat_id,a.name IS DISTINCT FROM before.name AS renamed`,
          [
            id,
            ownerId,
            revision,
            input.name ?? null,
            input.description ?? null,
            input.instructions ?? null,
            input.memoryMode ?? null,
          ],
        )
        .catch((error: unknown) => {
          throw conflict(error);
        })
    ).rows[0];
    if (!updated) {
      const exists = await client.query('SELECT 1 FROM agents WHERE id=$1 AND owner_id=$2', [
        id,
        ownerId,
      ]);
      throw exists.rowCount
        ? failure('This agent changed. Review it before saving again.', 409)
        : failure('Agent not found.', 404);
    }
    if (updated.renamed) await title(client, updated.chat_id, updated.name);
    afterCommit(client, refresh);
    return updated.name;
  }

  async function attach(client: PoolClient, agentId: string, chatId: string) {
    const agent = (
      await client.query<{ name: string; model: object | null; active: boolean }>(
        `SELECT a.name,previous.model,EXISTS(SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id
             WHERE u.id=previous.turn_id AND u.owner_id=a.owner_id AND th.archived_at IS NULL) AS active
         FROM agents a LEFT JOIN tasks previous ON previous.id=a.chat_id AND previous.owner_id=a.owner_id
         WHERE a.id=$1 AND a.owner_id=$2 FOR UPDATE OF a`,
        [agentId, ownerId],
      )
    ).rows[0];
    if (!agent) throw failure('Agent not found.', 404);
    if (agent.active)
      throw failure('This agent already has a chat in this conversation. Write in it.', 409);
    await client.query(
      `UPDATE tasks SET title=$3,title_by='owner',model=COALESCE(model,$4::jsonb)
       WHERE id=$1 AND owner_id=$2`,
      [chatId, ownerId, agent.name, agent.model ? JSON.stringify(agent.model) : null],
    );
    await client.query(
      'UPDATE agents SET chat_id=$3,updated_at=now() WHERE id=$1 AND owner_id=$2',
      [agentId, ownerId, chatId],
    );
  }

  async function taken(client: Client, id: string, name: string | undefined) {
    if (name === undefined) return;
    const other = await client.query(
      'SELECT 1 FROM agents WHERE owner_id=$1 AND lower(name)=lower($2) AND id<>$3',
      [ownerId, name, id],
    );
    if (other.rowCount) throw failure('Another agent already has this name.', 409);
  }

  async function proposed(turnId: string, raw: Record<string, unknown>) {
    const input = profile.partial().strict().parse(raw);
    const agent = (
      await pool.query<{
        id: string;
        name: string;
        description: string;
        instructions: string;
        revision: number;
      }>(
        `SELECT a.id,a.name,a.description,a.instructions,a.revision FROM turns u
         JOIN agents a ON a.owner_id=u.owner_id AND a.chat_id=u.session_id
         WHERE u.id=$1 AND u.owner_id=$2`,
        [turnId, ownerId],
      )
    ).rows[0];
    if (!agent)
      throw new Error(
        'This chat is not an agent. The owner can make it one from the chat header first.',
      );
    const { id, revision, ...current } = agent;
    const changes = Object.fromEntries(
      Object.entries(input).filter(
        ([key, value]) => current[key as keyof typeof current] !== value,
      ),
    ) as Partial<z.infer<typeof profile>>;
    if (!Object.keys(changes).length) throw new Error('Choose a detail of the agent to change.');
    for (const [key, value] of Object.entries(changes))
      if (publicText(value) !== value || hidden.test(value))
        throw new Error(
          `The new ${key} has a secret, a private Nod link or invisible characters, so the owner could not read it exactly before approving. Write it without them.`,
        );
    await taken(pool, id, changes.name);
    return { input: { id, revision, ...changes }, current };
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
    const { input, current } = await proposed(turnId, args);
    const verdict = await review.check({ ...input, currentAgent: current });
    const allowed =
      !verdict.confirm && (!('instructions' in input) || verdict.basis.kind === 'message');
    return review.ask(input, {
      allowed,
      ...(!verdict.confirm && allowed ? { basis: verdict.basis } : {}),
      details: { current, ...(verdict.confirm ? { reason: verdict.reason } : {}) },
    });
  }

  async function describe(
    proposal: ApprovalDescription,
    signal: AbortSignal | undefined,
    base: (proposal: ApprovalDescription, signal?: AbortSignal) => Promise<ApprovalPresentation>,
    canDeliverLiteral: (channel: string, text: string, literal: string) => boolean,
  ): Promise<ApprovalPresentation> {
    const change = approvedChange.parse(proposal.args);
    const literal = [
      change.name !== undefined && `Name: ${change.name}`,
      change.description !== undefined && `What it's for: ${change.description}`,
      change.instructions !== undefined && `Instructions:\n${change.instructions}`,
    ]
      .filter(Boolean)
      .join('\n');
    const fence = '`'.repeat(
      Math.max(3, ...(literal.match(/`+/g) ?? []).map((run) => run.length + 1)),
    );
    const presentation = await base(proposal, signal);
    const text = `${presentation.question}\n\nThe exact new text:\n\n${fence}\n${literal}\n${fence}`;
    const channel = proposal.channel;
    const shown =
      !channel ||
      channel === 'web' ||
      (channelText(text).text === text.trim() && canDeliverLiteral(channel, text, literal));
    return {
      ...presentation,
      question: shown
        ? text
        : `${presentation.question}\n\nOpen this chat in the Nod app to read the exact new text before you answer.`,
    };
  }

  async function validate(raw: Record<string, unknown>, client: Client = pool) {
    const { id, revision, name } = approvedChange.parse(raw);
    const current = await client.query(
      'SELECT 1 FROM agents WHERE id=$1 AND owner_id=$2 AND revision=$3',
      [id, ownerId, revision],
    );
    if (!current.rowCount) throw failure('This agent changed. Review it before asking again.', 409);
    await taken(client, id, name);
  }

  async function apply(raw: Record<string, unknown>, client: Client) {
    const { id, revision, ...input } = approvedChange.parse(raw);
    return { agent: await change(client, id, revision, input), changed: Object.keys(input) };
  }

  async function forTopic(topic: {
    provider: string;
    account_id: string;
    sender_id: string;
    topic_id: string | null;
  }) {
    if (!topic.topic_id) return undefined;
    return (
      await pool.query<{ id: string }>(
        `SELECT a.id FROM channel_topics c
         JOIN agents a ON a.owner_id=c.owner_id AND a.chat_id=c.task_id
         JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id AND th.archived_at IS NOT NULL
         WHERE c.owner_id=$1 AND c.provider=$2 AND c.account_id=$3 AND c.sender_id=$4 AND c.topic_id=$5`,
        [ownerId, topic.provider, topic.account_id, topic.sender_id, topic.topic_id],
      )
    ).rows[0]?.id;
  }

  function registerRoutes(app: FastifyInstance) {
    app.post('/api/agents', (request) => make(request.body));
    app.patch<{ Params: { id: string } }>('/api/agents/:id', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const { revision, ...input } = changeInput
        .extend({ revision: z.number().int().positive() })
        .parse(request.body);
      await transaction((client) => change(client, id, revision, input), pool);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/api/agents/:id', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const removed = await pool.query('DELETE FROM agents WHERE id=$1 AND owner_id=$2', [
        id,
        ownerId,
      ]);
      if (!removed.rowCount) throw failure('Agent not found.', 404);
      refresh();
      return { ok: true };
    });
  }

  return {
    initialize,
    list,
    context,
    attach,
    request,
    describe,
    validate,
    apply,
    forTopic,
    registerRoutes,
  };
}
