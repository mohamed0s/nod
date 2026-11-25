import type { Pool, PoolClient } from 'pg';

type Database = Pick<Pool | PoolClient, 'query'>;

export interface Chat {
  id: string | null;
  title: string;
  within?: string[];
}

export const turnChatSql = (turn: string) =>
  `(CASE WHEN ${turn}.session_id<>${turn}.thread_id THEN COALESCE(
    (SELECT k.id FROM tasks k WHERE k.id=${turn}.task_id AND k.owner_id=${turn}.owner_id),
    (SELECT k.id FROM tasks k WHERE k.id=${turn}.session_id AND k.session_id=k.id AND k.owner_id=${turn}.owner_id)) END)`;

const ownerTasks = (owner: string, sessions: boolean) =>
  `(SELECT k.id FROM tasks k WHERE k.owner_id=${owner}${sessions ? ' AND k.session_id=k.id' : ''})`;

export const inChatSql = (turn: string, main: boolean, chat: string, owner: string) =>
  main
    ? `(${chat}::uuid IS NULL AND (${turn}.id IS NULL OR ${turn}.session_id=${turn}.thread_id
        OR ((${turn}.task_id IS NULL OR ${turn}.task_id NOT IN ${ownerTasks(owner, false)})
          AND ${turn}.session_id NOT IN ${ownerTasks(owner, true)})))`
    : `((${turn}.task_id=${chat}::uuid OR ${turn}.session_id=${chat}::uuid) AND ${turnChatSql(turn)}=${chat}::uuid)`;

export const messageChatSql = (message: string) =>
  `(SELECT ${turnChatSql('w')} FROM turns w WHERE w.id=${message}.turn_id AND w.owner_id=${message}.owner_id)`;

export const chatNameSql = (chat: string, owner: string) =>
  `COALESCE((SELECT k.title FROM tasks k WHERE k.id=${chat} AND k.owner_id=${owner}),'Main')`;

export async function chatsReady(db: Database) {
  return Boolean((await db.query("SELECT to_regclass('tasks') AS name")).rows[0]?.name);
}

export async function turnChat(
  db: Database,
  ownerId: string,
  turnId: string | undefined,
): Promise<Chat | undefined> {
  if (!turnId || !(await chatsReady(db))) return undefined;
  const row = (
    await db.query<{ id: string | null; title: string }>(
      `SELECT c.id,${chatNameSql('c.id', 'c.owner_id')} AS title
       FROM (SELECT ${turnChatSql('u')} AS id,u.owner_id FROM turns u WHERE u.id=$1 AND u.owner_id=$2) c`,
      [turnId, ownerId],
    )
  ).rows[0];
  return row ? { id: row.id, title: row.title } : undefined;
}

export function chatLabel<T extends { chat?: string | null }>(row: T): T {
  if (row.chat) return row;
  const { chat: _chat, ...rest } = row;
  return rest as T;
}
