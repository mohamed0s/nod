import { parse } from 'parse5';
import type { TelegramPost } from '../ports/job-sources.ts';
import { jobUrl, jobUrlKey, siteOf } from './job-urls.ts';

export type JobCandidate = {
  url: string;
  title: string;
  company?: string;
  location?: string;
  postedAt?: string | null;
  excerpt?: string;
  detail: string;
};

export type AlertEmail = {
  id?: string | null;
  from?: string | null;
  subject?: string | null;
  date?: string | null;
  html?: string | null;
  text?: string | null;
};

type Node = {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
  parentNode?: Node | null;
};

const blocks = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'center',
  'dd',
  'div',
  'dl',
  'dt',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'ol',
  'p',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'tr',
  'ul',
]);
const hidden = new Set(['head', 'script', 'style', 'template', 'title', 'noscript']);
const notJobs =
  /(?:^|\.)(?:facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net|t\.me|telegram\.me|telegram\.org|whatsapp\.com|wa\.me|play\.google\.com|apps\.apple\.com|itunes\.apple\.com)$/i;
const notJobPaths =
  /\/(?:unsubscribe|unsub|settings|preferences|mypreferences|notifications?|help|support|privacy|legal|terms|cookies?|account|login|signin|sign-in|feedback|email)(?:[/?.]|$)/i;
const knownJob = [
  /(?:^|\.)linkedin\.com$/i,
  /(?:^|\.)indeed\.[a-z.]+$/i,
  /(?:^|\.)glassdoor\.[a-z.]+$/i,
  /(?:^|\.)wuzzuf\.net$/i,
  /(?:^|\.)bayt\.com$/i,
];
const vacancyPath =
  /\/(?:jobs?|vacanc\w*|positions?|openings?|careers?|apply|postings?|offers?|stellen\w*|empleo\w*)(?:[/-]|$).*(?:\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\/j\/[A-Za-z0-9]{6,})|\/(?:jobs?|p)\/[^/]*\d{3,}|\/job-listing\/|joblisting|viewjob|\/jobs\/p\//i;
const boilerplate =
  /^(?:view (?:the )?job|see (?:the )?job|see (?:all|more) jobs|view (?:all|more)(?: jobs)?|apply(?: now)?|easy apply|quick apply|show more|learn more|read more|details|more details|search (?:other|more) jobs|promoted|actively (?:recruiting|hiring)|be an early applicant|new|\d+\s+(?:\w+\s+)?(?:applicants?|connections?|alumni)\b.*|\d+\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago|posted .*|(?:today|yesterday|just now)|view job:?.*)$/i;
const workplace =
  /^(?:remote|hybrid|on-?site|onsite|anywhere|worldwide)\b|\((?:remote|hybrid|on-?site)\)/i;
const legalTail = /,\s*(?:inc|llc|ltd|limited|corp|co|gmbh|plc|s\.?a\.?e?)\.?$/i;
const locationish = (line: string) =>
  workplace.test(line) || (/,\s*\p{L}/u.test(line) && !legalTail.test(line));

export const clean = (text: string, max: number) =>
  [
    ...text
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
    .trim();

function attribute(node: Node, name: string) {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

function textLines(node: Node) {
  const parts: string[] = [];
  const visit = (current: Node) => {
    if (current.nodeName === '#text') {
      parts.push(current.value ?? '');
      return;
    }
    if (hidden.has(current.nodeName)) return;
    const block = blocks.has(current.nodeName);
    if (block) parts.push('\n');
    for (const child of current.childNodes ?? []) visit(child);
    if (block) parts.push('\n');
  };
  visit(node);
  return parts
    .join('')
    .split('\n')
    .map((line) => clean(line, 300))
    .filter(Boolean);
}

function unwrap(raw: string, depth = 0): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim().replaceAll('&amp;', '&'));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (depth < 3)
    for (const value of url.searchParams.values())
      if (/^https?:\/\//i.test(value)) {
        const inner = unwrap(value, depth + 1);
        if (inner && jobLink(inner)) return inner;
      }
  return url.href;
}

function jobLink(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (notJobs.test(url.hostname) || notJobPaths.test(url.pathname)) return false;
  if (/(?:^|\.)linkedin\.com$/i.test(url.hostname))
    return jobUrlKey(url.href)?.startsWith('linkedin.com:') ?? false;
  if (/(?:^|\.)indeed\.[a-z.]+$/i.test(url.hostname))
    return Boolean(url.searchParams.get('jk') ?? url.searchParams.get('vjk'));
  return (
    vacancyPath.test(`${url.pathname}${url.search}`) ||
    (knownJob.some((host) => host.test(url.hostname)) && /\d{5,}/.test(url.pathname))
  );
}

function splitPair(line: string) {
  for (const separator of [' · ', ' • ', ' | ', ' – ', ' — ', ' - '])
    if (line.includes(separator)) {
      const [first, ...rest] = line.split(separator);
      return [first!.trim(), rest.join(separator).trim()] as const;
    }
  return null;
}

function fields(lines: string[], title?: string) {
  const useful = lines.filter(
    (line) =>
      !boilerplate.test(line) &&
      !/https?:\/\//i.test(line) &&
      line.length <= 200 &&
      line.toLowerCase() !== title?.toLowerCase(),
  );
  const name = title ?? useful.shift() ?? '';
  let company = '';
  let location = '';
  for (const line of useful) {
    if (!company) {
      const pair = splitPair(line);
      if (pair && !locationish(pair[0])) {
        [company, location] = pair;
        break;
      }
      if (!locationish(line)) {
        company = line;
        continue;
      }
    }
    if (!location) location = line;
    if (company && location) break;
  }
  if (!company) {
    const at = /^(.{2,}?)\s+(?:at|@)\s+(.{2,})$/i.exec(name);
    if (at) return { title: at[1]!, company: at[2]!, location };
  }
  return { title: name, company, location };
}

function candidate(
  link: string,
  found: { title: string; company: string; location: string },
  extra: Partial<JobCandidate>,
): JobCandidate | null {
  const url = jobUrl(link);
  const title = clean(found.title, 200);
  if (!url || !title) return null;
  return {
    url,
    title,
    company: clean(found.company, 160),
    location: clean(found.location, 160),
    detail: siteOf(url),
    ...extra,
  };
}

function fromHtml(html: string, extra: Partial<JobCandidate>) {
  const document = parse(html) as unknown as Node;
  const anchors: Array<{ node: Node; key: string; url: string }> = [];
  const visit = (node: Node) => {
    if (node.nodeName === 'a') {
      const href = attribute(node, 'href');
      const url = href && unwrap(href);
      const key = url && jobLink(url) && jobUrlKey(url);
      if (url && key) anchors.push({ node, key, url });
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  const keys = new WeakMap<Node, Set<string>>();
  const keysIn = (node: Node): Set<string> => {
    const known = keys.get(node);
    if (known) return known;
    const found = new Set<string>();
    if (node.nodeName === 'a') {
      const entry = anchors.find((anchor) => anchor.node === node);
      if (entry) found.add(entry.key);
    }
    for (const child of node.childNodes ?? []) for (const key of keysIn(child)) found.add(key);
    keys.set(node, found);
    return found;
  };
  const groups = new Map<string, { url: string; nodes: Node[] }>();
  for (const anchor of anchors) {
    const group = groups.get(anchor.key) ?? { url: anchor.url, nodes: [] };
    group.nodes.push(anchor.node);
    groups.set(anchor.key, group);
  }
  const results: JobCandidate[] = [];
  for (const { url, nodes } of groups.values()) {
    const title = nodes
      .map((node) => textLines(node)[0] ?? '')
      .find((text) => text.length > 1 && !boilerplate.test(text) && !/https?:\/\//i.test(text));
    let card = nodes[0]!;
    while (
      card.parentNode &&
      card.parentNode.nodeName !== 'body' &&
      card.parentNode.nodeName !== '#document' &&
      keysIn(card.parentNode).size === 1
    )
      card = card.parentNode;
    const found = candidate(url, fields(textLines(card), title), extra);
    if (found) results.push(found);
  }
  return results;
}

function fromText(text: string, extra: Partial<JobCandidate>) {
  const lines = text.replaceAll('&amp;', '&').split(/\r?\n/);
  const seen = new Set<string>();
  const results: JobCandidate[] = [];
  lines.forEach((line, index) => {
    for (const [match] of line.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      const url = unwrap(match.replace(/[),.;!?]+$/, ''));
      const key = url && jobLink(url) && jobUrlKey(url);
      if (!url || !key || seen.has(key)) continue;
      seen.add(key);
      const before = clean(line.slice(0, line.indexOf(match)).replace(/[:\-–—|]\s*$/, ''), 300);
      const above: string[] = [];
      for (let at = index - 1; at >= 0 && above.length < 4; at--) {
        const value = clean(lines[at]!, 300);
        if (!value) {
          if (above.length) break;
          continue;
        }
        if (/https?:\/\//i.test(value) || /^[-=_*]{3,}$/.test(value)) break;
        if (/^(?:from|to|subject|date|reply-to|cc)\s*:/i.test(value)) break;
        if (boilerplate.test(value)) continue;
        above.unshift(value);
      }
      if (before && !boilerplate.test(before)) above.push(before);
      if (!above.length) continue;
      const found = candidate(url, fields(above), extra);
      if (found) results.push(found);
    }
  });
  return results;
}

export function isoDate(value: string | null | undefined) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function alertPostings(email: AlertEmail): JobCandidate[] {
  const extra = { postedAt: isoDate(email.date) };
  const html = email.html?.trim() ? fromHtml(email.html, extra) : [];
  return html.length ? html : fromText(email.text ?? '', extra);
}

const labels = {
  company:
    /^[^\p{L}\p{N}]*(?:company|employer|organi[sz]ation|hiring company|الشركة|اسم الشركة|شركة)\s*[:：\-–]\s*(.{2,120})$/iu,
  location:
    /^[^\p{L}\p{N}]*(?:location|city|country|based in|place|الموقع|المكان|مكان العمل|المدينة|الدولة)\s*[:：\-–]\s*(.{2,120})$/iu,
  title:
    /^[^\p{L}\p{N}]*(?:job title|title|position|role|vacancy|job|المسمى الوظيفي|الوظيفة|المنصب)\s*[:：\-–]\s*(.{2,160})$/iu,
};
const hiringPrefix =
  /^(?:we(?:'|’)?re hiring|we are hiring|hiring|now hiring|job opening|job alert|new job|vacancy|urgent(?:ly)? hiring|مطلوب|وظيفة|فرصة عمل)\s*[:!\-–—]*\s*/iu;
const leading = /^[^\p{L}\p{N}]+/u;
const stripped = (line: string) =>
  line.replace(leading, '').replace(hiringPrefix, '').replace(leading, '');

export function telegramPostings(channel: string, post: TelegramPost): JobCandidate | null {
  const lines = post.text
    .split('\n')
    .map((line) => clean(line, 300))
    .filter((line) => line && !/^(?:#\S+\s*)+$/u.test(line));
  if (!lines.length || !/\p{L}{3}/u.test(post.text)) return null;
  const labelled = (pattern: RegExp) => {
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match) return clean(match[1]!, 160);
    }
    return '';
  };
  let company = labelled(labels.company);
  const location =
    labelled(labels.location) ||
    clean(lines.find((line) => line.startsWith('📍'))?.replace(/^📍\s*/u, '') ?? '', 160);
  let title = labelled(labels.title);
  if (!title) {
    const first = lines.find(
      (line) =>
        !/https?:\/\//i.test(line) &&
        !labels.company.test(line) &&
        !labels.location.test(line) &&
        stripped(line).length > 1,
    );
    title = clean(stripped(first ?? ''), 200);
  }
  if (!company) {
    const at = /^(.{2,}?)\s+(?:at|@|\|)\s+(.{2,})$/i.exec(title);
    const is = /^(.{2,80}?)\s+is\s+(?:hiring|looking for)\s+(?:an?\s+)?(.{2,})$/i.exec(title);
    if (at) [title, company] = [at[1]!, at[2]!];
    else if (is) [company, title] = [is[1]!, is[2]!];
  }
  const link = post.links
    .map((value) => unwrap(value))
    .find((value): value is string => Boolean(value) && !notJobs.test(new URL(value!).hostname));
  const url = (link && jobUrl(link)) || `https://t.me/${channel}/${post.id}`;
  if (!clean(title, 200)) return null;
  return {
    url,
    title: clean(title.replace(/[\s:\-–—|]+$/, ''), 200),
    company: clean(company, 160),
    location,
    postedAt: post.date,
    excerpt: clean(post.text, 600),
    detail: channel,
  };
}

const historyColumns = [
  'url',
  'first_seen',
  'portal',
  'title',
  'company',
  'status',
  'location',
  'fingerprint',
  'posted_at',
] as const;

export function scanHistoryPostings(text: string, since: Date) {
  const rows: JobCandidate[] = [];
  let old = 0;
  let other = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split('\t').map((cell) => cell.replace(/^'(?='*[=+\-@])/, ''));
    if (cells[0] === 'url') continue;
    if (cells.length < 6) throw new Error('a row has fewer than six tab-separated columns');
    const row = Object.fromEntries(historyColumns.map((name, index) => [name, cells[index] ?? '']));
    if (row.status !== 'added') {
      other++;
      continue;
    }
    const seen = Date.parse(`${row.first_seen}T00:00:00Z`);
    if (!Number.isNaN(seen) && seen < since.getTime()) {
      old++;
      continue;
    }
    rows.push({
      url: row.url!,
      title: row.title!,
      company: row.company,
      location: row.location,
      postedAt: isoDate(row.posted_at || undefined),
      detail: row.portal ?? '',
    });
  }
  return { rows, old, other };
}
