import type { Composio } from '@composio/core';
import { z } from 'zod';
import type { JobMailMessage, JobMailReader } from '../../ports/job-mail.ts';
import { gmail } from './sent-email.ts';
import { mailbox, messageSchema, messageText, withoutComments } from './verification-email.ts';

type Client = Pick<Composio['tools'], 'proxyExecute'>;
type Message = z.infer<typeof messageSchema>;

const idList = z.object({
  messages: z
    .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }))
    .max(100)
    .default([]),
  nextPageToken: z.string().max(1000).optional(),
});
const skipped = new Set(['SPAM', 'TRASH', 'SENT', 'DRAFT']);
const mostLinks = 500;

function linksIn(payload: unknown) {
  const links = new Set<string>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  let visited = 0;
  while (queue.length && visited++ < 50 && links.size < mostLinks) {
    const { value, depth } = queue.shift()!;
    if (!value || typeof value !== 'object' || depth > 8) continue;
    const part = value as Record<string, unknown>;
    if ((typeof part.filename === 'string' && part.filename) || part.mimeType === 'message/rfc822')
      continue;
    if (Array.isArray(part.parts))
      queue.push(...part.parts.slice(0, 50).map((entry) => ({ value: entry, depth: depth + 1 })));
    if (!['text/plain', 'text/html'].includes(String(part.mimeType))) continue;
    const data = (part.body as { data?: unknown } | undefined)?.data;
    if (typeof data !== 'string' || data.length > 200_000 || !/^[a-zA-Z0-9_=-]*$/.test(data))
      continue;
    const text = Buffer.from(data, 'base64url').toString('utf8').replaceAll('&amp;', '&');
    for (const [link] of text.matchAll(/https?:\/\/[^\s"'<>()[\]{}\\]+/gi)) {
      links.add(link.replace(/[),.;!?]+$/, ''));
      if (links.size >= mostLinks) break;
    }
  }
  return [...links];
}

export function jobMailMessage(message: Message): JobMailMessage | null {
  if (message.labelIds?.some((label) => skipped.has(label))) return null;
  const headers = (name: string) =>
    message.payload.headers
      .filter((header) => header.name.toLowerCase() === name)
      .map((header) => header.value);
  const from = headers('from');
  const single = from.length === 1 && (from[0]!.match(/</g) ?? []).length <= 1;
  const first = headers('authentication-results')[0];
  const authentication =
    first && /^\s*mx\.google\.com\s*;/i.test(first)
      ? withoutComments(first.replace(/"(?:\\.|[^"\\])*"/g, '""'))
      : '';
  const results = authentication.split(';').slice(1);
  const passing = (method: string) =>
    results.filter((entry) => new RegExp(`^\\s*${method}=pass\\b`, 'i').test(entry));
  const authenticatedDomain =
    passing('dmarc')
      .map((entry) => /\bheader\.from=([a-z0-9.-]+)(?:\s|$)/i.exec(entry)?.[1])
      .find(Boolean)
      ?.toLowerCase() ?? null;
  const signatures = headers('dkim-signature').map((value) => {
    const tags = new Map(
      value
        .replace(/\s+/g, '')
        .split(';')
        .flatMap((part) => {
          const at = part.indexOf('=');
          return at > 0 ? [[part.slice(0, at).toLowerCase(), part.slice(at + 1)] as const] : [];
        }),
    );
    return {
      domain: (tags.get('d') ?? '').toLowerCase(),
      selector: (tags.get('s') ?? '').toLowerCase(),
      signature: tags.get('b') ?? '',
      coversTo: (tags.get('h') ?? '').toLowerCase().split(':').includes('to'),
    };
  });
  const signedDomains = passing('dkim').flatMap((entry) => {
    const domain = (
      /\bheader\.d=([a-z0-9.-]+)(?:\s|$)/i.exec(entry)?.[1] ??
      /\bheader\.i=[^\s@]*@([a-z0-9.-]+)(?:\s|$)/i.exec(entry)?.[1] ??
      ''
    ).toLowerCase();
    const selector = /\bheader\.s=(\S+)/i.exec(entry)?.[1]?.toLowerCase();
    const prefix = /\bheader\.b=(\S+)/i.exec(entry)?.[1];
    const matched = signatures.filter(
      (signature) =>
        signature.domain &&
        (domain === signature.domain || domain.endsWith(`.${signature.domain}`)) &&
        (!selector || signature.selector === selector) &&
        (!prefix || signature.signature.startsWith(prefix)),
    );
    return matched.length && matched.every((signature) => signature.coversTo)
      ? [matched[0]!.domain]
      : [];
  });
  return {
    id: message.id,
    receivedAt: Number(message.internalDate),
    sender: single ? (mailbox(from[0]!) ?? null) : null,
    recipients:
      headers('to').length === 1
        ? headers('to')[0]!
            .split(',')
            .flatMap((value) => mailbox(value) ?? [])
            .slice(0, 100)
        : [],
    senderName: single
      ? (/^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(from[0]!)?.[1]?.trim() ?? '')
      : '',
    subject: headers('subject')[0]?.slice(0, 1000) ?? '',
    authenticatedDomain,
    signedDomains,
    text: (messageText(message.payload) ?? '').slice(0, 64_000),
    links: linksIn(message.payload),
  };
}

export function jobMailReader(client: Client): JobMailReader {
  return {
    async list(accountId, query, max, signal) {
      const get = gmail(client, accountId, signal);
      const ids: string[] = [];
      let page: string | undefined;
      do {
        const list = idList.parse(
          await get('messages', [
            ['q', query],
            ['maxResults', Math.min(100, max - ids.length)],
            ['includeSpamTrash', 'false'],
            ['fields', 'messages/id,nextPageToken'],
            ...(page ? [['pageToken', page] as [string, string]] : []),
          ]),
        );
        ids.push(...list.messages.map((entry) => entry.id));
        page = list.nextPageToken;
      } while (page && ids.length < max);
      return { ids: ids.slice(0, max), more: Boolean(page) };
    },
    async read(accountId, ids, signal) {
      const get = gmail(client, accountId, signal);
      const messages: JobMailMessage[] = [];
      for (let start = 0; start < ids.length; start += 8) {
        const batch = await Promise.all(
          ids.slice(start, start + 8).map(async (id) => {
            const parsed = messageSchema.safeParse(
              await get(`messages/${id}`, [['format', 'full']]),
            );
            return parsed.success && parsed.data.id === id ? jobMailMessage(parsed.data) : null;
          }),
        );
        for (const message of batch) if (message) messages.push(message);
      }
      return messages;
    },
  };
}
