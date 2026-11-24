import { createHash } from 'node:crypto';

const tracking =
  /^(?:utm_.*|gh_src|fbclid|gclid|yclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|trk|trkinfo|trackingid|refid|ref|referrer|src|source|lever-origin|lever-source|rltr|language|lang|locale|campaign|eid|midtoken|midsig|lipi)$/i;
const greenhouseHosts =
  /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$|^boards-api\.greenhouse\.io$/;
const legalForms = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'llc',
  'llp',
  'lp',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'bv',
  'nv',
  'ab',
  'as',
  'oy',
  'pty',
  'pvt',
  'sae',
  'sal',
  'fze',
  'fzco',
  'fzllc',
  'wll',
]);

function parsed(raw: string) {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return url;
  } catch {
    return null;
  }
}

function linkedInJob(url: URL) {
  if (!/(?:^|\.)linkedin\.com$/.test(url.hostname)) return null;
  const path = /^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d+)\/?$/.exec(url.pathname);
  if (path) return path[1]!;
  const current = url.searchParams.get('currentJobId');
  return current && /^\d+$/.test(current) ? current : null;
}

function indeedJob(url: URL) {
  if (!/(?:^|\.)indeed\.[a-z.]+$/.test(url.hostname)) return null;
  const key = url.searchParams.get('jk') ?? url.searchParams.get('vjk');
  return key && /^[\w-]+$/.test(key) ? key : null;
}

function greenhouseJob(url: URL) {
  const path = greenhouseHosts.test(url.hostname)
    ? /\/jobs\/(\d+)\/?$/.exec(url.pathname)?.[1]
    : undefined;
  const query = url.searchParams.get('gh_jid');
  return path ?? (query && /^\d+$/.test(query) ? query : null);
}

function cleaned(url: URL, key: boolean) {
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !tracking.test(name))
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const fragment = /^#\/jobs?\/[^/?#]+/i.exec(url.hash)?.[0];
  url.search = '';
  for (const [name, value] of kept) url.searchParams.append(name, value);
  if (key && fragment) url.searchParams.append('_fragment', fragment);
  url.hash = !key && fragment ? fragment : '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

export function jobUrl(raw: string) {
  const url = parsed(raw);
  if (!url) return null;
  const linkedIn = linkedInJob(url);
  return linkedIn ? `https://www.linkedin.com/jobs/view/${linkedIn}` : cleaned(url, false).href;
}

export function jobUrlKey(raw: string) {
  const url = parsed(raw);
  if (!url) return null;
  const linkedIn = linkedInJob(url);
  if (linkedIn) return `linkedin.com:${linkedIn}`;
  const indeed = indeedJob(url);
  if (indeed) return `indeed:${indeed}`;
  const greenhouse = greenhouseJob(url);
  if (greenhouse) return `greenhouse:${greenhouse}`;
  const clean = cleaned(url, true);
  const host = clean.hostname.replace(/^www\./, '');
  const path = clean.pathname.length > 1 ? clean.pathname : '';
  return `${host}${path}${clean.search}`;
}

export function siteOf(raw: string) {
  const host = parsed(raw)?.hostname.replace(/^www\./, '');
  if (!host) return '';
  const labels = host.split('.');
  const short = labels.length > 2 && /^(?:co|com|org|net|gov|edu|ac)$/.test(labels.at(-2)!);
  return labels.slice(short ? -3 : -2).join('.');
}

const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function companyKey(company: string) {
  const words = fold(company).split(' ').filter(Boolean);
  while (words.length > 1 && legalForms.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

export function jobFingerprint(company: string, title: string, location: string) {
  const name = companyKey(company);
  const role = fold(title);
  if (!name || !role) return null;
  const place = fold(location.split(/[,|/(·•–—]|\s-\s/)[0] ?? '');
  return createHash('sha256')
    .update(JSON.stringify([name, role, place]))
    .digest('hex')
    .slice(0, 32);
}
