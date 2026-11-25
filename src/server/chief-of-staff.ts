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
}) {
  const { pool, ownerId } = options;

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_briefs (
        owner_id text NOT NULL, chat_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE, text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id,chat_id,message_id)
      );
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

  return { initialize, context, fromMain, send, read };
}
