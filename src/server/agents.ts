import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  agentAllowlist,
  agentLimits,
  agentMemoryModes,
  type Agent,
  type AgentChoices,
} from '../shared/agents.ts';
import { afterCommit, transaction } from './transaction.ts';
import {
  agentPictureColumns,
  agentPictureInput,
  createAgentPictures,
  defaultAgentPicture,
} from './agent-pictures.ts';
import type { ApprovalDescription, ApprovalPresentation } from './approvals.ts';
import { channelText } from './channel-text.ts';
import { publicText } from './communication.ts';
import type { TrustReason } from './trust.ts';
import type { TrustBasis } from './trust-basis.ts';
import { workOriginSql } from './turn-chain.ts';

type Client = Pick<PoolClient, 'query'>;

const outsideApp = 'Open this chat in the Nod app to read the exact new text before you answer.';
const appOnly = 'Open Nod in the app to read the exact new text and answer there.';

const hidden = /(?![\u200c\u200d])\p{Cf}/u;

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\r\n]*$/, 'Use one line.');
const allowlist = (max: number) =>
  z
    .array(oneLine(200).min(1))
    .max(max)
    .transform((values) => [...new Set(values)]);
const profile = z.object({
  name: oneLine(agentLimits.name).min(1),
  description: oneLine(agentLimits.description),
  instructions: z.string().trim().max(agentLimits.instructions),
  apps: allowlist(agentLimits.apps),
  skills: allowlist(agentLimits.skills),
});
const memoryMode = z.enum(['shared', 'own', 'own_and_shared']);
const changeInput = profile
  .partial()
  .extend({ memoryMode: memoryMode.optional(), ...agentPictureInput })
  .strict();
const approvedChange = profile
  .partial()
  .extend({ id: z.uuid(), revision: z.number().int().positive() })
  .strict();
const newAgent = profile.extend({ memoryMode }).strict();
const newAgentInput = profile
  .partial({ description: true, instructions: true, apps: true, skills: true })
  .extend({ memoryMode: memoryMode.optional() })
  .strict();

type Review = {
  check(
    input: Record<string, unknown>,
  ): Promise<{ confirm: false; basis: TrustBasis } | { confirm: true; reason: TrustReason }>;
  ask(
    input: Record<string, unknown>,
    decision: { allowed: boolean; basis?: TrustBasis; details: Record<string, unknown> },
  ): Promise<unknown>;
};

function readable(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values))
    for (const text of [value].flat())
      if (typeof text === 'string' && (publicText(text) !== text || hidden.test(text)))
        throw new Error(
          `The new ${key} has a secret, a private Nod link or invisible characters, so the owner could not read it exactly before approving. Write it without them.`,
        );
}

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

export interface AgentScope {
  id: string;
  name: string;
  description: string;
  instructions: string;
  memoryMode: Agent['memoryMode'];
  apps: string[];
  skills: string[];
  scheduled: boolean;
}

export function createAgents(options: {
  pool: Pool;
  ownerId: string;
  refresh?: () => void;
  renamed?: (taskId: string, title: string) => void;
  choices?: () => Promise<AgentChoices>;
  removed?: (agentId: string) => Promise<void>;
  readArtifact?: (id: string) => Promise<Buffer>;
}) {
  const { pool, ownerId } = options;
  const refresh = options.refresh ?? (() => {});
  const pictures = createAgentPictures({ ownerId, read: options.readArtifact });

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
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS apps text[] NOT NULL DEFAULT '{}';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS agent_chats (
        owner_id text NOT NULL, agent_id uuid NOT NULL,
        chat_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, PRIMARY KEY (agent_id,chat_id)
      );
      ALTER TABLE agent_chats DROP CONSTRAINT IF EXISTS agent_chats_agent_id_fkey;
      CREATE INDEX IF NOT EXISTS agent_chats_chat ON agent_chats(owner_id,chat_id);
      INSERT INTO agent_chats(owner_id,agent_id,chat_id)
        SELECT owner_id,id,chat_id FROM agents WHERE chat_id IS NOT NULL ON CONFLICT DO NOTHING;
      ${agentPictureColumns}
    `);
  }

  async function list(threadId?: string): Promise<Agent[]> {
    return (
      await pool.query<Omit<Agent, 'lastActiveAt'> & { lastActiveAt: Date | null }>(
        `SELECT a.id,a.name,a.description,a.instructions,a.memory_mode AS "memoryMode",a.apps,a.skills,a.revision,
           CASE WHEN u.thread_id=$2 THEN a.chat_id END AS "chatId",t.model,a.emoji,a.color,a.image_id AS "imageId",
           (SELECT max(c.updated_at) FROM agent_chats ac JOIN tasks c ON c.id=ac.chat_id AND c.owner_id=ac.owner_id
             WHERE ac.owner_id=a.owner_id AND ac.agent_id=a.id) AS "lastActiveAt"
         FROM agents a LEFT JOIN tasks t ON t.id=a.chat_id AND t.owner_id=a.owner_id
         LEFT JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         WHERE a.owner_id=$1 ORDER BY lower(a.name),a.id`,
        [ownerId, threadId ?? null],
      )
    ).rows.map(({ lastActiveAt, ...agent }) => ({
      ...agent,
      lastActiveAt: lastActiveAt?.toISOString() ?? null,
    }));
  }

  async function scope(turnId: string): Promise<AgentScope | undefined> {
    return (
      await pool.query<AgentScope>(
        `SELECT a.id,a.name,a.description,a.instructions,a.memory_mode AS "memoryMode",a.apps,a.skills,
           a.chat_id IS DISTINCT FROM cur.session_id AND m.agent_id IS NULL AS scheduled
         FROM turns cur ${workOriginSql('cur')}
         LEFT JOIN agent_schedules s ON s.owner_id=cur.owner_id AND s.schedule_id=work_schedule.id
         LEFT JOIN room_members m ON m.owner_id=cur.owner_id AND m.session_id=cur.session_id
         JOIN agents a ON a.owner_id=cur.owner_id
           AND (a.chat_id=cur.session_id OR a.id=s.agent_id OR a.id=m.agent_id)
         WHERE cur.id=$1 AND cur.owner_id=$2
         ORDER BY (a.chat_id IS NOT DISTINCT FROM cur.session_id) DESC LIMIT 1`,
        [turnId, ownerId],
      )
    ).rows[0];
  }

  async function context(turnId: string) {
    const row = await scope(turnId);
    if (!row) return undefined;
    const { name, description, instructions, scheduled, apps, skills } = row;
    return {
      name,
      description,
      instructions,
      ...(scheduled ? { scheduled } : {}),
      ...(apps.length ? { apps } : {}),
      ...(skills.length ? { skills } : {}),
    };
  }

  async function checkChoices(input: { apps?: string[]; skills?: string[] }) {
    if (!input.apps?.length && !input.skills?.length) return;
    if (!options.choices) throw failure('App and skill choices are unavailable.', 503);
    const choices = await options.choices();
    const known = {
      apps: choices.apps.flatMap((app) => [app.slug, ...app.accounts.map(({ id }) => id)]),
      skills: choices.skills.map(({ name }) => name),
    };
    for (const kind of ['apps', 'skills'] as const) {
      const unknown = (input[kind] ?? []).filter((value) => !known[kind].includes(value));
      if (unknown.length)
        throw failure(
          `Not ${kind === 'apps' ? 'a connected app or account' : 'a skill'}: ${unknown.join(', ')}. Choose from: ${known[kind].join(', ') || 'none'}.`,
          400,
        );
    }
  }

  async function chatOf(client: Client, agentId: string, chatId: string) {
    await client.query(
      'INSERT INTO agent_chats(owner_id,agent_id,chat_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [ownerId, agentId, chatId],
    );
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
    const { chatId, imageId, ...input } = profile
      .partial({ description: true, instructions: true, apps: true, skills: true })
      .extend({
        chatId: z.uuid().optional(),
        memoryMode: memoryMode.optional(),
        ...agentPictureInput,
      })
      .strict()
      .parse(raw);
    await checkChoices(input);
    const picture = defaultAgentPicture();
    return transaction(async (client) => {
      if (chatId) {
        const chat = await client.query(
          'SELECT 1 FROM tasks WHERE id=$1 AND owner_id=$2 AND session_id=id FOR UPDATE',
          [chatId, ownerId],
        );
        if (!chat.rowCount) throw failure('Chat not found.', 404);
      }
      if (imageId) await pictures.keep(client, imageId);
      const id = randomUUID();
      await client
        .query(
          `INSERT INTO agents(id,owner_id,name,description,instructions,chat_id,memory_mode,apps,skills,emoji,color,image_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            ownerId,
            input.name,
            input.description ?? '',
            input.instructions ?? '',
            chatId ?? null,
            input.memoryMode ?? 'shared',
            input.apps ?? [],
            input.skills ?? [],
            input.emoji ?? picture.emoji,
            input.color ?? picture.color,
            imageId ?? null,
          ],
        )
        .catch((error: unknown) => {
          throw conflict(error);
        });
      if (chatId) {
        await chatOf(client, id, chatId);
        await title(client, chatId, input.name);
      }
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
    if (input.imageId) await pictures.keep(client, input.imageId);
    const updated = (
      await client
        .query<{
          name: string;
          chat_id: string | null;
          renamed: boolean;
          repictured: boolean;
          previous_image: string | null;
          chat_title: string | null;
        }>(
          `UPDATE agents a SET name=COALESCE($4,a.name),description=COALESCE($5,a.description),
             instructions=COALESCE($6,a.instructions),memory_mode=COALESCE($7,a.memory_mode),
             apps=COALESCE($8::text[],a.apps),skills=COALESCE($9::text[],a.skills),
             emoji=COALESCE($10,a.emoji),color=COALESCE($11,a.color),
             image_id=CASE WHEN $12::boolean THEN $13::uuid ELSE a.image_id END,
             revision=a.revision+1,updated_at=now()
           FROM agents before WHERE a.id=$1 AND a.owner_id=$2 AND a.revision=$3 AND before.id=a.id
           RETURNING a.name,a.chat_id,a.name IS DISTINCT FROM before.name AS renamed,
             a.emoji IS DISTINCT FROM before.emoji AS repictured,before.image_id AS previous_image,
             (SELECT title FROM tasks WHERE id=a.chat_id AND owner_id=a.owner_id) AS chat_title`,
          [
            id,
            ownerId,
            revision,
            input.name ?? null,
            input.description ?? null,
            input.instructions ?? null,
            input.memoryMode ?? null,
            input.apps ?? null,
            input.skills ?? null,
            input.emoji ?? null,
            input.color ?? null,
            input.imageId !== undefined,
            input.imageId ?? null,
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
    const chatId = updated.chat_id;
    if (updated.renamed) await title(client, chatId, updated.name);
    else if (updated.repictured && chatId && updated.chat_title !== null) {
      const chatTitle = updated.chat_title;
      afterCommit(client, () => options.renamed?.(chatId, chatTitle));
    }
    if (input.imageId !== undefined && updated.previous_image !== input.imageId)
      await pictures.release(client, updated.previous_image);
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
    await chatOf(client, agentId, chatId);
  }

  async function taken(client: Client, id: string | null, name: string | undefined) {
    if (name === undefined) return;
    const other = await client.query(
      'SELECT 1 FROM agents WHERE owner_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3)',
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
        apps: string[];
        skills: string[];
        revision: number;
      }>(
        `SELECT a.id,a.name,a.description,a.instructions,a.apps,a.skills,a.revision FROM turns u
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
        ([key, value]) =>
          JSON.stringify(current[key as keyof typeof current]) !== JSON.stringify(value),
      ),
    ) as Partial<z.infer<typeof profile>>;
    if (!Object.keys(changes).length) throw new Error('Choose a detail of the agent to change.');
    readable(changes);
    await checkChoices(changes);
    await taken(pool, id, changes.name);
    return { input: { id, revision, ...changes }, current };
  }

  async function decide(
    review: Review,
    input: Record<string, unknown>,
    checked: Record<string, unknown>,
    details: Record<string, unknown>,
  ) {
    const verdict = await review.check(checked);
    const allowed = !verdict.confirm && verdict.basis.kind === 'message';
    return review.ask(input, {
      allowed,
      ...(!verdict.confirm && allowed ? { basis: verdict.basis } : {}),
      details: { ...details, ...(verdict.confirm ? { reason: verdict.reason } : {}) },
    });
  }

  async function request(turnId: string, args: Record<string, unknown>, review: Review) {
    const { input, current } = await proposed(turnId, args);
    return decide(review, input, { ...input, currentAgent: current }, { current });
  }

  async function requestCreate(args: Record<string, unknown>, review: Review) {
    const input = newAgent.parse({
      description: '',
      instructions: '',
      apps: [],
      skills: [],
      memoryMode: 'shared',
      ...newAgentInput.parse(args),
    });
    readable(input);
    await checkChoices(input);
    await taken(pool, null, input.name);
    return decide(review, input, input, {});
  }

  async function describe(
    proposal: ApprovalDescription,
    signal: AbortSignal | undefined,
    base: (proposal: ApprovalDescription, signal?: AbortSignal) => Promise<ApprovalPresentation>,
    canDeliverLiteral: (channel: string, text: string, literal: string) => boolean,
  ): Promise<ApprovalPresentation> {
    const change =
      proposal.action === 'NOD_agent_create'
        ? newAgent.parse(proposal.args)
        : approvedChange.parse(proposal.args);
    const memory = 'memoryMode' in change ? change.memoryMode : undefined;
    const accounts = new Map(
      change.apps?.some((value) => z.uuid().safeParse(value).success)
        ? ((await options.choices?.())?.apps ?? []).flatMap((app) =>
            app.accounts.map(({ id, label }) => [id, `${id} (${app.name}, ${label})`] as const),
          )
        : [],
    );
    const literal = [
      change.name !== undefined && `Name: ${change.name}`,
      change.description !== undefined && `What it's for: ${change.description}`,
      memory && `Memory: ${agentMemoryModes.find(({ id }) => id === memory)?.label ?? memory}`,
      change.apps !== undefined &&
        `Apps: ${agentAllowlist(
          change.apps.map((value) => accounts.get(value) ?? value),
          'all connected apps',
        )}`,
      change.skills !== undefined && `Skills: ${agentAllowlist(change.skills, 'all skills')}`,
      change.instructions !== undefined && `Instructions:\n${change.instructions}`,
    ]
      .filter(Boolean)
      .join('\n');
    const fence = '`'.repeat(
      Math.max(3, ...(literal.match(/`+/g) ?? []).map((run) => run.length + 1)),
    );
    const presentation = await base(proposal, signal);
    const text = `${presentation.question}\n\nThe exact new text:\n\n${fence}\n${literal}\n${fence}`;
    const channel =
      proposal.channel ??
      (
        await pool.query<{ channel: string | null }>(
          'SELECT channel FROM turns WHERE id=$1 AND owner_id=$2',
          [proposal.turn.turnId, ownerId],
        )
      ).rows[0]?.channel;
    const safe = channelText(text);
    const verbatim =
      Boolean(channel) &&
      channel !== 'web' &&
      safe.text === text.trim() &&
      !safe.secureAction &&
      !safe.artifact &&
      canDeliverLiteral(channel!, text, literal);
    return {
      ...presentation,
      cardQuestion: presentation.cardQuestion ?? presentation.question,
      question: verbatim ? text : `${presentation.question}\n\n${outsideApp}`,
    };
  }

  async function answerRefusal(approvalId: string) {
    const refused = await pool.query(
      `SELECT 1 FROM approvals a JOIN messages m ON m.id=a.confirmation_message_id AND m.owner_id=a.owner_id
       WHERE a.id=$1 AND a.owner_id=$2 AND a.action IN ('NOD_agent_update','NOD_agent_create') AND a.status='pending'
         AND right(m.text,$3)=$4`,
      [approvalId, ownerId, outsideApp.length, outsideApp],
    );
    return refused.rowCount ? appOnly : undefined;
  }

  async function validate(
    raw: Record<string, unknown>,
    client: Client = pool,
    action = 'NOD_agent_update',
  ) {
    if (action === 'NOD_agent_create') {
      const { name, ...choices } = newAgent.parse(raw);
      await checkChoices(choices);
      return taken(client, null, name);
    }
    const { id, revision, name } = approvedChange.parse(raw);
    const current = await client.query(
      'SELECT 1 FROM agents WHERE id=$1 AND owner_id=$2 AND revision=$3',
      [id, ownerId, revision],
    );
    if (!current.rowCount) throw failure('This agent changed. Review it before asking again.', 409);
    await taken(client, id, name);
  }

  async function apply(raw: Record<string, unknown>, client: Client, action = 'NOD_agent_update') {
    if (action === 'NOD_agent_create') {
      const input = newAgent.parse(raw);
      await client
        .query(
          `INSERT INTO agents(id,owner_id,name,description,instructions,memory_mode,apps,skills)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            ownerId,
            input.name,
            input.description,
            input.instructions,
            input.memoryMode,
            input.apps,
            input.skills,
          ],
        )
        .catch((error: unknown) => {
          throw conflict(error);
        });
      afterCommit(client, refresh);
      return { agent: input.name, created: true };
    }
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
      await checkChoices(input);
      await transaction((client) => change(client, id, revision, input), pool);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/api/agents/:id', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const removed = await pool.query<{ image_id: string | null }>(
        'DELETE FROM agents WHERE id=$1 AND owner_id=$2 RETURNING image_id',
        [id, ownerId],
      );
      if (!removed.rowCount) throw failure('Agent not found.', 404);
      await pictures.release(pool, removed.rows[0]!.image_id);
      await options.removed?.(id);
      refresh();
      return { ok: true };
    });
    app.get('/api/agents/choices', async () => {
      if (!options.choices) throw failure('App and skill choices are unavailable.', 503);
      return options.choices();
    });
  }

  return {
    initialize,
    list,
    scope,
    context,
    attach,
    request,
    requestCreate,
    describe,
    validate,
    apply,
    forTopic,
    answerRefusal,
    registerRoutes,
  };
}
