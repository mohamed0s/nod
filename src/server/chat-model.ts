import type { Pool } from 'pg';

export async function chatModelArgs(
  pool: Pool,
  ownerId: string,
  turnId: string,
  args: Record<string, unknown>,
) {
  const chat = (
    await pool.query<{ id: string }>(
      `SELECT t.id FROM turns u JOIN tasks t ON t.owner_id=u.owner_id AND t.id=u.session_id
       WHERE u.id=$1 AND u.owner_id=$2`,
      [turnId, ownerId],
    )
  ).rows[0]?.id;
  return {
    chat,
    args:
      chat && args.scope === undefined && args.id === undefined
        ? { ...args, scope: 'task', id: chat }
        : args,
  };
}
