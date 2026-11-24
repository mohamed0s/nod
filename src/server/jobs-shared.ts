import type { PoolClient } from 'pg';
import type { z } from 'zod';

export type Query = Pick<PoolClient, 'query'>;
export type TurnRef = { threadId: string; turnId: string };
export type Lineage = 'owner' | 'schedule' | 'other';

export function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const path = issue.path.join('.');
  throw failure(`${what}${path ? ` (${path})` : ''}: ${issue.message}`);
}

export function companyLabel(name: string) {
  const text = name
    .replace(/[^\p{L}\p{N} .,&'()-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, 40).join('').trim() || 'this company';
}

export async function applyChatOf(client: Query, ownerId: string, turn: TurnRef) {
  const { rows } = await client.query<{ company_id: string; session_id: string }>(
    `SELECT c.id AS company_id,u.session_id FROM turns u
     JOIN job_companies c ON c.owner_id=u.owner_id AND c.apply_session_id=u.session_id
     JOIN tasks t ON t.owner_id=u.owner_id AND t.id=u.session_id
     WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3 AND NOT u.proactive`,
    [turn.turnId, ownerId, turn.threadId],
  );
  const row = rows[0];
  return row ? { companyId: row.company_id, sessionId: row.session_id } : null;
}

export async function rootedIn(client: Query, ownerId: string, turn: TurnRef): Promise<Lineage> {
  const { rows } = await client.query<{ source: string; message_id: string | null }>(
    `WITH RECURSIVE lineage AS (
       SELECT id,parent_turn_id,source,message_id,0 AS depth FROM turns WHERE id=$1 AND owner_id=$2 AND thread_id=$3
       UNION ALL SELECT p.id,p.parent_turn_id,p.source,p.message_id,c.depth+1 FROM turns p
         JOIN lineage c ON c.parent_turn_id=p.id WHERE p.owner_id=$2 AND c.depth<100
     ) SELECT source,message_id FROM lineage ORDER BY depth DESC LIMIT 1`,
    [turn.turnId, ownerId, turn.threadId],
  );
  const root = rows[0];
  return root?.source === 'user' && root.message_id
    ? 'owner'
    : root?.source === 'schedule'
      ? 'schedule'
      : 'other';
}
