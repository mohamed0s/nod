import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  agentColors,
  agentDefaultEmoji,
  agentLimits,
  agentPictureTypes,
  isAgentEmoji,
} from '../shared/agents.ts';

type Client = Pick<PoolClient, 'query'>;

const pick = (values: readonly string[]) =>
  `(ARRAY[${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(',')}])[1+floor(random()*${values.length})::int]`;

export const agentPictureColumns = `
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS emoji text NOT NULL DEFAULT ${pick(agentDefaultEmoji)};
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT ${pick(agentColors)};
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS image_id uuid;`;

const random = <T>(values: readonly T[]) => values[Math.floor(Math.random() * values.length)]!;

export const defaultAgentPicture = () => ({
  emoji: random(agentDefaultEmoji),
  color: random(agentColors),
});

export const agentPictureInput = {
  emoji: z.string().trim().refine(isAgentEmoji, 'Use one emoji.').optional(),
  color: z.enum(agentColors).optional(),
  imageId: z.uuid().nullable().optional(),
};

export const agentTopicName = (owner: string, task: string, title: string) =>
  `COALESCE((SELECT topic_agent.emoji||' '||${title} FROM agent_chats topic_chat
    JOIN agents topic_agent ON topic_agent.id=topic_chat.agent_id AND topic_agent.owner_id=topic_chat.owner_id
    WHERE topic_chat.owner_id=${owner} AND topic_chat.chat_id=${task}
    ORDER BY (topic_agent.chat_id=${task}) DESC LIMIT 1),${title})`;

const signatures: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) =>
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': (bytes) =>
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/gif': (bytes) => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1')),
};

function refused(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function createAgentPictures(options: {
  ownerId: string;
  read?: (id: string) => Promise<Buffer>;
}) {
  const { ownerId } = options;

  async function keep(client: Client, id: string) {
    const file = (
      await client.query<{ mime_type: string; size: number }>(
        `SELECT mime_type,size FROM artifacts
         WHERE id=$1 AND owner_id=$2 AND deleting_at IS NULL AND thread_id IS NULL
           AND (expires_at IS NOT NULL OR EXISTS (SELECT 1 FROM agents WHERE owner_id=$2 AND image_id=$1))
         FOR UPDATE`,
        [id, ownerId],
      )
    ).rows[0];
    if (!file) throw refused('The picture is unavailable. Upload it again.', 404);
    if (!agentPictureTypes.includes(file.mime_type))
      throw refused(
        `A picture must be a PNG, JPEG, WebP or GIF image, not ${file.mime_type || 'a file of unknown type'}.`,
      );
    if (file.size > agentLimits.pictureBytes)
      throw refused(
        `A picture must be at most ${agentLimits.pictureBytes / 1024 / 1024} MB; this one is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
      );
    if (!options.read) throw refused('Pictures are unavailable on this server.', 503);
    if (!signatures[file.mime_type]!(await options.read(id)))
      throw refused(`The picture's content doesn't match its type, ${file.mime_type}.`);
    await client.query('UPDATE artifacts SET expires_at=NULL WHERE id=$1 AND owner_id=$2', [
      id,
      ownerId,
    ]);
  }

  async function release(client: Client, id: string | null) {
    if (!id) return;
    const kept = await client.query(
      'SELECT 1 FROM artifacts WHERE id=$1 AND owner_id=$2 AND thread_id IS NULL FOR UPDATE',
      [id, ownerId],
    );
    if (!kept.rowCount) return;
    await client.query(
      `UPDATE artifacts SET expires_at=clock_timestamp()
       WHERE id=$1 AND owner_id=$2 AND expires_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM agents WHERE owner_id=$2 AND image_id=$1)`,
      [id, ownerId],
    );
  }

  return { keep, release };
}
