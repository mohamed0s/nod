import { parse } from 'parse5';
import type { TelegramChannels, TelegramPost } from '../../ports/job-sources.ts';
import { publicUrl, type AddressResolver } from '../agent-browser/network.ts';
import { requestPublicPreview, type PreviewRequest } from './link-preview.ts';

type Node = {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
};

const pageBytes = 1024 * 1024;
const textLimit = 4096;

const attribute = (node: Node, name: string) =>
  node.attrs?.find((entry) => entry.name === name)?.value;
const hasClass = (node: Node, name: string) =>
  (attribute(node, 'class') ?? '').split(/\s+/).includes(name);

function find(node: Node, test: (node: Node) => boolean, found: Node[] = []) {
  if (test(node)) found.push(node);
  for (const child of node.childNodes ?? []) find(child, test, found);
  return found;
}

function text(node: Node) {
  const parts: string[] = [];
  const visit = (current: Node) => {
    if (current.nodeName === '#text') parts.push(current.value ?? '');
    else if (current.nodeName === 'br') parts.push('\n');
    else {
      const start = parts.length;
      for (const child of current.childNodes ?? []) visit(child);
      const href = current.nodeName === 'a' ? (attribute(current, 'href') ?? '') : '';
      const shown = parts.slice(start).join('').trim();
      const bare = href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      if (
        /^https?:\/\//i.test(href) &&
        !/^https?:\/\/(?:t\.me|telegram\.me)\//i.test(href) &&
        shown !== href &&
        shown.replace(/^https?:\/\//i, '').replace(/\/$/, '') !== bare
      )
        parts.push(` ${href}`);
    }
  };
  visit(node);
  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, textLimit);
}

export function telegramChannelPosts(html: string): TelegramPost[] {
  const document = parse(html) as unknown as Node;
  return find(
    document,
    (node) => hasClass(node, 'js-widget_message') && Boolean(attribute(node, 'data-post')),
  ).flatMap((message): TelegramPost[] => {
    const id = Number(/\/(\d+)$/.exec(attribute(message, 'data-post') ?? '')?.[1]);
    if (!Number.isSafeInteger(id) || id < 1) return [];
    const body = find(message, (node) => hasClass(node, 'js-message_text'))[0];
    const time = find(
      message,
      (node) => node.nodeName === 'time' && Boolean(attribute(node, 'datetime')),
    )[0];
    const stamp = time && Date.parse(attribute(time, 'datetime')!);
    const links = [
      ...(body ? find(body, (node) => node.nodeName === 'a') : []),
      ...find(message, (node) => hasClass(node, 'tgme_widget_message_link_preview')),
    ]
      .map((node) => attribute(node, 'href') ?? '')
      .filter((href) => /^https?:\/\//i.test(href));
    return [
      {
        id,
        date: stamp && !Number.isNaN(stamp) ? new Date(stamp).toISOString() : null,
        text: body ? text(body) : '',
        links: [...new Set(links)].slice(0, 20),
      },
    ];
  });
}

export function createTelegramChannels(
  options: { resolver?: AddressResolver; request?: PreviewRequest } = {},
): TelegramChannels {
  const request = options.request ?? requestPublicPreview;
  return {
    async read(channel, { before, signal }) {
      if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(channel))
        throw new Error(`${channel} isn't a valid public channel name.`);
      const address = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
      signal.throwIfAborted();
      const resolved = await publicUrl(address, options.resolver);
      const response = await request({
        ...resolved,
        signal,
        maxBytes: pageBytes,
        metadata: false,
      });
      if ([301, 302, 303, 307, 308].includes(response.status))
        throw new Error(
          `t.me has no public web preview for ${channel}: the channel is private, turned its preview off or doesn't exist.`,
        );
      if (response.status !== 200)
        throw new Error(`t.me answered HTTP ${response.status} for the channel ${channel}.`);
      if (response.body.byteLength > pageBytes)
        throw new Error(
          `The t.me page for ${channel} is larger than ${pageBytes / 1024 / 1024} MB, so Nod didn't read it.`,
        );
      if (!/^text\/html/i.test(response.headers['content-type'] ?? ''))
        throw new Error(
          `t.me sent ${response.headers['content-type'] || 'no content type'} for the channel ${channel}, not a web page.`,
        );
      const html = Buffer.from(response.body).toString('utf8');
      const posts = telegramChannelPosts(html);
      if (!posts.length && !html.includes('tgme_channel_info'))
        throw new Error(
          `The t.me page for ${channel} has no posts Nod can read; the page layout may have changed.`,
        );
      return posts;
    },
  };
}
