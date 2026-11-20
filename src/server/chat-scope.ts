import type { Pool, PoolClient } from 'pg';

type Database = Pick<Pool | PoolClient, 'query'>;

export interface Chat {
  id: string | null;
  title: string;
}

const taskOfTurn = (turn: string) =>
  `SELECT k.id,k.title FROM tasks k WHERE k.owner_id=${turn}.owner_id AND ${turn}.session_id<>${turn}.thread_id
    AND (k.id=${turn}.task_id OR (k.id=${turn}.session_id AND k.session_id=k.id))
    ORDER BY k.created_at DESC,k.id DESC LIMIT 1`;

export const messageChatSql = (message: string) =>
  `(SELECT k.id FROM turns w CROSS JOIN LATERAL (${taskOfTurn('w')}) k
    WHERE w.id=${message}.turn_id AND w.owner_id=${message}.owner_id)`;

export const turnChatSql = (turn: string) => `(SELECT k.id FROM (${taskOfTurn(turn)}) k)`;

export const chatNameSql = (chat: string) =>
  `COALESCE((SELECT k.title FROM tasks k WHERE k.id=${chat}),'Main')`;

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
    await db.query<{ id: string | null; title: string | null }>(
      `SELECT k.id,k.title FROM turns u LEFT JOIN LATERAL (${taskOfTurn('u')}) k ON true
       WHERE u.id=$1 AND u.owner_id=$2`,
      [turnId, ownerId],
    )
  ).rows[0];
  return row ? { id: row.id, title: row.title ?? 'Main' } : undefined;
}

export function chatLabel<T extends { chat?: string | null }>(row: T): T {
  if (row.chat) return row;
  const { chat: _chat, ...rest } = row;
  return rest as T;
}
