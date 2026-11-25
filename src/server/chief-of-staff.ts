import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RuntimeContext } from '../ports/agent.ts';
import type { Agent } from '../shared/agents.ts';
import type { Task } from '../shared/contracts.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import { inChatSql } from './chat-scope.ts';
import { bareConfirmationAnswer } from './owner-instructions.ts';
import type { TaskAgents } from './tasks.ts';

type Client = Pick<PoolClient, 'query'>;

export const agentStopLimits = { quietHours: 6, runsPerHour: 20, checkIns: 2 } as const;

type StopReason = 'quiet' | 'loop' | 'cost';

const stopWording: Record<StopReason, string> = {
  quiet: `it had made no progress for ${agentStopLimits.quietHours} hours`,
  loop: `it started ${agentStopLimits.runsPerHour} or more runs in an hour without a message from you`,
  cost: `its work since your last message to it passed ${agentStopLimits.checkIns} times your task check-in`,
};

const ownerMessageSql = (chat: string, since: string) =>
  `EXISTS (SELECT 1 FROM turns w JOIN messages m ON m.owner_id=w.owner_id AND (m.id=w.message_id OR m.turn_id=w.id)
     WHERE w.owner_id=$1 AND w.session_id=${chat} AND m.role='user' AND m.created_at>=${since})`;

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function createChiefOfStaff(options: {
  pool: Pool;
  ownerId: string;
  agents: {
    context(turnId: string): Promise<RuntimeContext['agent']>;
    list(threadId?: string): Promise<Agent[]>;
    attach(client: PoolClient, agentId: string, chatId: string): Promise<void>;
  };
  halt(
    id: string,
    guard: (client: PoolClient, threadId: string) => Promise<boolean>,
  ): Promise<boolean>;
  checkIn(
    sessionId: string,
    turnId: string,
  ): Promise<{ budgetUsd: number; spentUsd: number } | undefined>;
}) {
  const { pool, ownerId } = options;

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_briefs (
        owner_id text NOT NULL, chat_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE, text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,chat_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS agent_stops (
        id uuid PRIMARY KEY, owner_id text NOT NULL,
        agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
        chat_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        reason text NOT NULL CHECK (reason IN ('quiet','loop','cost')),
        message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_stops_chat ON agent_stops(owner_id,chat_id,created_at DESC);
    `);
  }

  async function context(turnId: string) {
    const [agent, turn] = await Promise.all([
      options.agents.context(turnId),
      pool.query<{ thread_id: string; main: boolean; brief: string | null }>(
        `SELECT u.thread_id,(u.session_id IS NULL OR u.session_id=u.thread_id) AND NOT u.proactive AS main,
           b.text AS brief
         FROM turns u LEFT JOIN agent_briefs b ON b.owner_id=u.owner_id AND b.chat_id=u.session_id
           AND b.message_id=u.message_id
         WHERE u.id=$1 AND u.owner_id=$2`,
        [turnId, ownerId],
      ),
    ]);
    const row = turn.rows[0];
    const agents = row?.main
      ? (await options.agents.list(row.thread_id)).map(({ name, description, chatId }) => ({
          name,
          description,
          chatId,
        }))
      : [];
    return {
      ...(agent ? { agent } : {}),
      ...(agents.length ? { agents } : {}),
      ...(row?.brief ? { fromMain: row.brief } : {}),
    };
  }

  async function fromMain(sessionId: string, messageId: string) {
    return (
      await pool.query<{ text: string }>(
        'SELECT text FROM agent_briefs WHERE owner_id=$1 AND chat_id=$2 AND message_id=$3',
        [ownerId, sessionId, messageId],
      )
    ).rows[0]?.text;
  }

  const send: TaskAgents['send'] = async (client, request) => {
    if (request.current.background || request.current.proactive)
      throw failure(
        "Only Main, answering the owner's message, can send work to an agent. Schedule, event and observer runs can't.",
      );
    const message = (
      await client.query<{ text: string }>(
        "SELECT text FROM messages WHERE id=$1 AND owner_id=$2 AND role='user'",
        [request.messageId, ownerId],
      )
    ).rows[0];
    if (!message) throw failure('Sending work to an agent needs an owner message.');
    if (bareConfirmationAnswer(message.text))
      throw failure(
        "A yes or no can't be sent to an agent. The owner answers an agent's question or approval in that agent's own chat.",
      );
    const agent = (
      await client.query<{ id: string; name: string; chat: string | null }>(
        `SELECT a.id,a.name,CASE WHEN u.thread_id=$3 THEN a.chat_id END AS chat
         FROM agents a LEFT JOIN tasks t ON t.id=a.chat_id AND t.owner_id=a.owner_id
         LEFT JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         WHERE a.owner_id=$1 AND lower(a.name)=lower($2) FOR UPDATE OF a`,
        [ownerId, request.name, request.turn.threadId],
      )
    ).rows[0];
    if (!agent)
      throw failure(
        `No agent is named ${JSON.stringify(request.name)}. Use a name from agents.`,
        404,
      );
    let chat = agent.chat;
    if (!chat) {
      chat = randomUUID();
      await client.query(
        `INSERT INTO tasks(id,owner_id,turn_id,session_id,title,done_when,brief,now_text,title_by)
         VALUES($1,$2,$3,$1,$4,'','','','owner')`,
        [chat, ownerId, request.turn.turnId, agent.name],
      );
      await options.agents.attach(client as PoolClient, agent.id, chat);
    }
    await request.deliver(chat);
    if (request.brief)
      await client.query(
        `INSERT INTO agent_briefs(owner_id,chat_id,message_id,text) VALUES($1,$2,$3,$4)
         ON CONFLICT (owner_id,chat_id,message_id) DO NOTHING`,
        [ownerId, chat, request.messageId, request.brief],
      );
  };

  async function read(client: Client, task: Task) {
    const messages = (
      await client.query<{ role: string; text: string; created_at: Date }>(
        `SELECT m.role,m.text,m.created_at FROM messages m
         JOIN turns w ON w.id=m.turn_id AND w.owner_id=m.owner_id
         WHERE m.owner_id=$1 AND ${inChatSql('w', false, '$2', '$1')} AND m.hidden_at IS NULL AND m.text<>''
         ORDER BY m.created_at DESC,m.id DESC LIMIT 8`,
        [ownerId, task.id],
      )
    ).rows.reverse();
    const chat = untrustedBlock(
      'task chat',
      JSON.stringify({
        id: task.id,
        title: task.title,
        status: task.status,
        ...(task.question ? { question: task.question } : {}),
        ...(task.closedAt ? { result: task.result.slice(0, 4000) } : { now: task.now }),
        messages: messages.map(({ role, text, created_at }) => ({
          role,
          text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text,
          at: created_at.toISOString(),
        })),
      }),
    );
    return { chat };
  }

  async function watch() {
    const { quietHours, runsPerHour, checkIns } = agentStopLimits;
    const { rows } = await pool.query<{
      agent_id: string;
      name: string;
      chat_id: string;
      turn_id: string;
      quiet: boolean;
      loop: boolean;
      at: Date;
    }>(
      `SELECT a.id AS agent_id,a.name,t.id AS chat_id,live.id AS turn_id,now() AS at,
         live.status='running' AND live.started_at<now()-make_interval(hours=>$2)
           AND NOT EXISTS (SELECT 1 FROM turn_events e JOIN turns w ON w.id=e.turn_id AND w.owner_id=$1
             WHERE w.session_id=t.id AND e.created_at>now()-make_interval(hours=>$2))
           AND NOT EXISTS (SELECT 1 FROM messages m JOIN turns w ON w.id=m.turn_id AND w.owner_id=m.owner_id
             WHERE m.owner_id=$1 AND w.session_id=t.id AND m.created_at>now()-make_interval(hours=>$2)) AS quiet,
         (SELECT count(*) FROM turns w WHERE w.owner_id=$1 AND w.session_id=t.id
             AND w.created_at>now()-interval '1 hour')>=$3
           AND NOT ${ownerMessageSql('t.id', "now()-interval '1 hour'")} AS loop
       FROM agents a JOIN tasks t ON t.id=a.chat_id AND t.owner_id=a.owner_id AND t.state='open'
       JOIN turns first ON first.id=t.turn_id AND first.owner_id=t.owner_id
       JOIN threads th ON th.id=first.thread_id AND th.owner_id=t.owner_id AND th.archived_at IS NULL
       CROSS JOIN LATERAL (SELECT w.id,w.status,w.started_at FROM turns w
         WHERE w.owner_id=t.owner_id AND w.session_id=t.id AND w.status IN ('queued','running')
         ORDER BY w.status='running' DESC,w.created_at DESC,w.id DESC LIMIT 1) live
       WHERE a.owner_id=$1`,
      [ownerId, quietHours, runsPerHour],
    );
    const stopped: Array<{ chatId: string; reason: StopReason }> = [];
    for (const row of rows) {
      const spend = await options.checkIn(row.chat_id, row.turn_id);
      const reason: StopReason | undefined =
        spend && spend.spentUsd >= checkIns * spend.budgetUsd
          ? 'cost'
          : row.loop
            ? 'loop'
            : row.quiet
              ? 'quiet'
              : undefined;
      if (!reason) continue;
      const done = await options.halt(row.chat_id, async (client, threadId) => {
        const current = await client.query(
          `SELECT 1 FROM tasks t JOIN turns first ON first.id=t.turn_id AND first.owner_id=t.owner_id
           WHERE t.id=$2 AND t.owner_id=$1 AND t.state='open' AND first.thread_id=$3
             AND EXISTS (SELECT 1 FROM turns w WHERE w.owner_id=$1 AND w.session_id=t.id
               AND w.status IN ('queued','running'))
             AND NOT ${ownerMessageSql('t.id', '$4')}
           FOR UPDATE OF t`,
          [ownerId, row.chat_id, threadId, row.at],
        );
        if (!current.rowCount) return false;
        await notify(client, threadId, row, reason);
        return true;
      });
      if (done) stopped.push({ chatId: row.chat_id, reason });
    }
    return stopped;
  }

  async function notify(
    client: Client,
    threadId: string,
    row: { agent_id: string; name: string; chat_id: string },
    reason: StopReason,
  ) {
    const stopId = randomUUID();
    const turnId = randomUUID();
    const messageId = randomUUID();
    const channel =
      (
        await client.query<{ channel: string }>(
          `SELECT u.channel FROM messages m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
           WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.role='user' AND u.session_id=u.thread_id
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
          [ownerId, threadId],
        )
      ).rows[0]?.channel ?? 'web';
    await client.query(
      `INSERT INTO turns(id,owner_id,thread_id,session_id,source,source_id,prompt,channel,background,status,finished_at)
       VALUES($1,$2,$3,$3,'event',$4,'',$5,true,'succeeded',now())`,
      [turnId, ownerId, threadId, `agent-stop:${stopId}`, channel],
    );
    await client.query(
      "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,$2,'assistant',$3,$4,$5)",
      [
        messageId,
        ownerId,
        `I stopped ${row.name} because ${stopWording[reason]}. Stopping changed nothing else. Write in its chat to start it again.`,
        threadId,
        turnId,
      ],
    );
    await client.query(
      'INSERT INTO agent_stops(id,owner_id,agent_id,chat_id,reason,message_id) VALUES($1,$2,$3,$4,$5,$6)',
      [stopId, ownerId, row.agent_id, row.chat_id, reason, messageId],
    );
  }

  return { initialize, context, fromMain, send, read, watch };
}
