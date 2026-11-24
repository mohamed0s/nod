import { isPublicIpv4Address } from './public-address.ts';

export const pageBytes = 2 * 1024 * 1024;
export const keptPageVersions = 10;
export const pageTitleLength = 120;

export function pageTitle(value: string) {
  return [
    ...value
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, pageTitleLength)
    .join('')
    .trim();
}

const namedEntities: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  sol: '/',
  colon: ':',
  quest: '?',
  equals: '=',
  num: '#',
  percnt: '%',
  period: '.',
};

function withoutEntities(text: string) {
  return text.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));?/gi,
    (match, decimal?: string, hex?: string, name?: string) => {
      const code = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : undefined;
      if (code !== undefined) return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      return namedEntities[name!.toLowerCase()] ?? match;
    },
  );
}

function privateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return !/^\[[23][0-9a-f]{3}:/.test(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPublicIpv4Address(host);
  return !host.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(host);
}

export function pageLink(href: string, source: string, origin: string) {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.origin === origin ||
    privateHost(url.hostname)
  )
    return null;
  const decoded = withoutEntities(source);
  return [source, decoded, source.replaceAll('\\/', '/'), decoded.replaceAll('\\/', '/')].some(
    (text) => written(text, href),
  )
    ? url.href
    : null;
}

function written(text: string, address: string) {
  for (let at = text.indexOf(address); at !== -1; at = text.indexOf(address, at + 1)) {
    const before = text[at - 1];
    const after = text[at + address.length];
    if (
      (before === undefined || /[\s"'`=([{,>]/.test(before)) &&
      (after === undefined || /[\s"'`<)\]},]/.test(after))
    )
      return true;
  }
  return false;
}

export type PageSource =
  | { kind: 'schedule'; id: string; title: string | null }
  | { kind: 'task'; id: string; title: string }
  | { kind: 'chat'; current: boolean }
  | { kind: 'owner' };

export interface PageFile {
  id: string;
  url: string;
  size: number;
}

export interface PageView {
  id: string;
  title: string;
  revision: number;
  file: PageFile | null;
  source: PageSource;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PageVersion {
  revision: number;
  file: PageFile | null;
  source: PageSource;
  createdAt: string;
}
