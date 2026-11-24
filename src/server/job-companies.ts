import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  jobCompanyFilters,
  jobPersonStatuses,
  type JobCompaniesView,
  type JobCompany,
  type JobCompanyFilter,
  type JobCompanyView,
  type JobNoLuck,
  type JobNoLuckChoice,
  type JobNoLuckResult,
  type JobPerson,
  type JobPersonStatus,
  type JobWaves,
} from '../shared/job-companies.ts';
import type { JobPosting } from '../shared/job-postings.ts';
import { languageTag, type JobProfile } from '../shared/jobs.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import { tailoringRules, type JobDrafts } from './job-drafts.ts';
import { companyKey, linkedInMessageUrl, linkedInProfileUrl } from './job-urls.ts';
import { clean } from './jobs-parsers.ts';
import { failure, parse, rootedIn, type Query, type TurnRef } from './jobs-shared.ts';

export const jobCompanyTables = `
  CREATE TABLE IF NOT EXISTS job_companies (
    id uuid PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL, key text NOT NULL,
    linkedin_slug text, careers_url text,
    status text NOT NULL DEFAULT 'auto' CHECK (status IN ('auto','no_luck','keep_trying')),
    no_luck_at timestamptz, no_luck_by text CHECK (no_luck_by IN ('owner','rule')),
    apply_session_id uuid, apply_started_at timestamptz,
    revision integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_companies_key ON job_companies(owner_id,key);
  CREATE UNIQUE INDEX IF NOT EXISTS job_companies_slug ON job_companies(owner_id,linkedin_slug) WHERE linkedin_slug IS NOT NULL;
  CREATE TABLE IF NOT EXISTS job_people (
    id uuid PRIMARY KEY, owner_id text NOT NULL, company_id uuid NOT NULL REFERENCES job_companies(id),
    profile_key text NOT NULL, member_urn text,
    name text NOT NULL DEFAULT '', headline text NOT NULL DEFAULT '', language text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'invited'
      CHECK (status IN ('invited','accepted','asked','replied','referred','declined')),
    invited_at timestamptz, accepted_at timestamptz, asked_at timestamptz, replied_at timestamptz,
    referred_at timestamptz, declined_at timestamptz,
    draft text NOT NULL DEFAULT '', draft_revision integer NOT NULL DEFAULT 0,
    revision integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_people_profile ON job_people(owner_id,profile_key);
  CREATE UNIQUE INDEX IF NOT EXISTS job_people_member ON job_people(owner_id,member_urn) WHERE member_urn IS NOT NULL;
  CREATE INDEX IF NOT EXISTS job_people_company ON job_people(owner_id,company_id);
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES job_companies(id);
  CREATE INDEX IF NOT EXISTS job_postings_company ON job_postings(owner_id,company_id);
`;

export const companyActions = new Set([
  'companies',
  'company',
  'person_update',
  'draft_prepare',
  'draft_save',
]);

export const applyRequest = (companyId: string) =>
  `Apply for the company I marked no luck\nCompany id: ${companyId}. Ask me before you submit anything.`;

const day = 86_400_000;
const memberId = /^ACoAA[A-Za-z0-9_-]{10,120}$/;
const placeholderCompanies = new Set([
  'anonymous',
  'company confidential',
  'confidential',
  'confidential client',
  'hidden',
  'multiple companies',
  'n a',
  'na',
  'none',
  'not disclosed',
  'not specified',
  'private',
  'tba',
  'tbd',
  'undisclosed',
  'unknown',
  'various',
  'various companies',
]);
const applyState = `CASE WHEN c.apply_session_id IS NULL THEN NULL
  WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.owner_id=c.owner_id AND t.id=c.apply_session_id) THEN 'open'
  WHEN c.apply_started_at>now()-interval '2 minutes' THEN 'starting' ELSE 'lost' END`;
const timeColumn: Record<JobPersonStatus, string> = {
  invited: 'invited_at',
  accepted: 'accepted_at',
  asked: 'asked_at',
  replied: 'replied_at',
  referred: 'referred_at',
  declined: 'declined_at',
};
const stage: Record<JobPersonStatus, number> = {
  invited: 0,
  accepted: 1,
  asked: 2,
  replied: 3,
  referred: 4,
  declined: 3,
};
const mergeOrder: JobPersonStatus[] = [
  'invited',
  'accepted',
  'asked',
  'replied',
  'declined',
  'referred',
];
const peopleOrder: Record<JobPersonStatus, number> = {
  accepted: 0,
  replied: 1,
  asked: 2,
  invited: 3,
  referred: 4,
  declined: 5,
};

export function linkedInPerson(raw: string) {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!/(?:^|\.)linkedin\.com$/.test(url.hostname.toLowerCase().replace(/\.$/, ''))) return null;
  const segment = /^\/in\/([^/]+)\/?/.exec(url.pathname)?.[1];
  if (!segment) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(segment).trim();
  } catch {
    return null;
  }
  if (memberId.test(slug)) return { key: slug, urn: slug };
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{1,99}$/u.test(slug)) return null;
  return { key: slug.toLowerCase(), urn: null };
}

export function memberUrn(raw: string) {
  const id = raw.trim().replace(/^urn:li:(?:fsd_profile|fs_miniProfile|fs_profile|member):/, '');
  return memberId.test(id) ? id : null;
}

const companyPage = (slug: string) =>
  `https://www.linkedin.com/company/${encodeURIComponent(slug)}/`;

type PersonState = {
  status: JobPersonStatus;
  invited_at: string | null;
  asked_at: string | null;
  declined_at: string | null;
};
type WaveSettings = Pick<JobProfile, 'noLuck' | 'waves' | 'inviteLimits'>;

function chanceEnd(person: PersonState, limits: JobProfile['noLuck']) {
  const after = (value: string | null, days: number) =>
    value ? Date.parse(value) + days * day : Number.NaN;
  if (person.status === 'invited') return after(person.invited_at, limits.noAcceptDays);
  if (person.status === 'asked') return after(person.asked_at, limits.noReplyDays);
  if (person.status === 'declined') return person.declined_at ? Date.parse(person.declined_at) : 0;
  return Number.NaN;
}

export function automaticNoLuck(
  people: PersonState[],
  limits: Pick<JobProfile, 'noLuck' | 'waves'>,
  now = Date.now(),
) {
  if (people.length < limits.waves.max || people.some((person) => person.status === 'referred'))
    return null;
  let since = 0;
  for (const person of people) {
    const end = chanceEnd(person, limits.noLuck);
    if (!(end <= now)) return null;
    since = Math.max(since, end);
  }
  return new Date(since);
}

export function companyWaves(
  people: PersonState[],
  settings: WaveSettings,
  invites: { today: number; week: number },
  now = Date.now(),
): JobWaves {
  const { size, max } = settings.waves;
  const { daily, weekly } = settings.inviteLimits;
  const invited = people.length;
  const ends = people.map((person) => chanceEnd(person, settings.noLuck));
  const within = ends.filter((end) => !(end <= now));
  const allowance = Math.max(0, Math.min(daily - invites.today, weekly - invites.week));
  const inWave = invited % size;
  const full = invited > 0 && inWave === 0;
  const wave = Math.max(1, Math.ceil(invited / size));
  const base = {
    invited,
    size,
    max,
    today: invites.today,
    week: invites.week,
    daily,
    weekly,
    over:
      invites.today > daily ? ('day' as const) : invites.week > weekly ? ('week' as const) : null,
    until: null,
    owed: people.filter(
      (person, index) =>
        !Number.isFinite(ends[index]!) &&
        (person.status === 'accepted' || person.status === 'replied'),
    ).length,
  };
  const closed = { wave, inWave: full ? size : inWave, left: 0, more: 0 };
  const room = (left: number) => ({ left, more: Math.min(left, allowance) });
  if (people.some((person) => person.status === 'referred'))
    return { ...base, ...closed, state: 'stopped' };
  if (!full && invited < max)
    return {
      ...base,
      state: 'open',
      wave: Math.floor(invited / size) + 1,
      inWave,
      ...room(Math.min(size - inWave, max - invited)),
    };
  if (within.length)
    return {
      ...base,
      ...closed,
      state: 'waiting',
      until: within.every(Number.isFinite) ? new Date(Math.max(...within)).toISOString() : null,
    };
  if (invited < max)
    return {
      ...base,
      state: 'next',
      wave: wave + 1,
      inWave: 0,
      ...room(Math.min(size, max - invited)),
    };
  return { ...base, ...closed, state: 'done' };
}

export function localDayStart(timeZone: string, at: Date, daysBack = 0) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const parts = (time: number) =>
    Object.fromEntries(
      format
        .formatToParts(time)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  const offset = (time: number) => {
    const local = parts(time);
    return (
      Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour % 24,
        local.minute,
        local.second,
      ) -
      Math.floor(time / 1000) * 1000
    );
  };
  const today = parts(at.getTime());
  const target = Date.UTC(today.year, today.month - 1, today.day - daysBack);
  return new Date(target - offset(target - offset(target)));
}

function keyOf(name: string) {
  const key = companyKey(clean(name, 160));
  return placeholderCompanies.has(key) ? '' : key;
}

export async function ensureCompany(client: Query, ownerId: string, name: string) {
  const display = clean(name, 160);
  const key = keyOf(display);
  if (!key) return null;
  const find = async () =>
    (
      await client.query<{ id: string }>(
        'SELECT id FROM job_companies WHERE owner_id=$1 AND key=$2',
        [ownerId, key],
      )
    ).rows[0]?.id;
  const known = await find();
  if (known) return known;
  const added = await client.query<{ id: string }>(
    `INSERT INTO job_companies(id,owner_id,name,key) VALUES($1,$2,$3,$4)
     ON CONFLICT (owner_id,key) DO NOTHING RETURNING id`,
    [randomUUID(), ownerId, display, key],
  );
  return added.rows[0]?.id ?? (await find()) ?? null;
}

export async function linkPostings(client: Query, ownerId: string) {
  const { rows } = await client.query<{ id: string; company: string }>(
    `SELECT id,company FROM job_postings WHERE owner_id=$1 AND company_id IS NULL AND company<>''
     ORDER BY first_seen_at,id`,
    [ownerId],
  );
  const groups = new Map<string, { name: string; ids: string[] }>();
  for (const row of rows) {
    const key = keyOf(row.company);
    if (!key) continue;
    const group = groups.get(key) ?? { name: row.company, ids: [] };
    group.ids.push(row.id);
    groups.set(key, group);
  }
  let linked = 0;
  for (const group of groups.values()) {
    const id = await ensureCompany(client, ownerId, group.name);
    if (!id) continue;
    const result = await client.query(
      'UPDATE job_postings SET company_id=$3 WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND company_id IS NULL',
      [ownerId, group.ids, id],
    );
    linked += result.rowCount ?? 0;
  }
  return linked;
}

const text = (max: number) =>
  z
    .string()
    .max(4000)
    .transform((value) => clean(value, max));
const companyName = z
  .string()
  .max(1000)
  .transform((value) => clean(value, 160))
  .pipe(z.string().min(1, 'needs a company name'));
const when = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const time = Date.parse(value);
    return time <= Date.now() + 5 * 60_000 && time >= Date.now() - 3 * 365 * day;
  },
  { message: 'needs a time in the last three years, not in the future' },
);
const personFields = {
  name: text(160).optional(),
  headline: text(300).optional(),
  language: z.union([languageTag, z.literal('')]).optional(),
  status: z.enum(jobPersonStatuses).optional(),
};
const personEntry = z
  .object({
    id: z.uuid().optional(),
    profileUrl: z.string().trim().min(1).max(2048).optional(),
    memberUrn: z.string().trim().min(1).max(200).optional(),
    company: companyName.optional(),
    companyId: z.uuid().optional(),
    at: when.optional(),
    ...personFields,
  })
  .strict()
  .refine((entry) => entry.id !== undefined || entry.profileUrl !== undefined, {
    message: 'Each person needs profileUrl, or their id from jobs company.',
  })
  .refine((entry) => entry.company === undefined || entry.companyId === undefined, {
    message: 'Give company or companyId, not both.',
  });
type PersonEntry = z.infer<typeof personEntry>;
type LinkedInCompany = { slug?: string; name?: string };
type SeenPerson = { profileUrl: string; memberUrn?: string; name: string; headline: string };

const toolInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('companies'),
      filter: z.enum(jobCompanyFilters).optional(),
      search: z.string().trim().min(1).max(80).optional(),
      limit: z.int().min(1).max(200).optional(),
    })
    .strict(),
  z.object({ action: z.literal('company'), id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal('person_update'),
      people: z.array(personEntry).min(1).max(50),
    })
    .strict(),
  z
    .object({
      action: z.literal('draft_prepare'),
      personId: z.uuid(),
      postingId: z.uuid().optional(),
      programme: text(160).optional(),
      track: text(160).optional(),
      role: text(160).optional(),
      language: z.union([languageTag, z.literal('')]).optional(),
      replace: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('draft_save'),
      personId: z.uuid(),
      text: z.string().max(8000),
      changes: z.string().max(1000).optional(),
      revision: z.int().min(0),
    })
    .strict(),
]);
type DraftRequest = Extract<z.infer<typeof toolInput>, { action: 'draft_prepare' }>;

type CompanyRow = {
  id: string;
  name: string;
  linkedin_slug: string | null;
  careers_url: string | null;
  status: JobNoLuckChoice;
  no_luck_at: Date | null;
  no_luck_by: 'owner' | 'rule' | null;
  apply_session_id: string | null;
  apply_state: 'open' | 'starting' | 'lost' | null;
  revision: number;
  updated_at: Date;
  open: number;
  best: number | null;
  people: PersonState[];
  active: Date | null;
};
type PersonRow = {
  id: string;
  company_id: string;
  profile_key: string;
  member_urn: string | null;
  name: string;
  headline: string;
  language: string;
  status: JobPersonStatus;
  draft: string;
  draft_revision: number;
  draft_state: NonNullable<JobPerson['draftInfo']>['state'] | null;
  draft_reason: string;
  draft_note: string;
  draft_language: string;
  draft_language_by: NonNullable<JobPerson['draftInfo']>['languageBy'];
  draft_template_revision: number | null;
  draft_missing: string[];
  draft_inputs: Record<string, string>;
  draft_at: Date | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
} & Record<`${JobPersonStatus}_at`, Date | null>;
type Show = Awaited<ReturnType<JobDrafts['viewer']>>;
type Summary = { company: JobCompany; filters: Set<JobCompanyFilter>; active: number };

function noLuckOf(row: CompanyRow, rule: Date | null): JobNoLuck {
  if (row.status === 'no_luck')
    return {
      value: true,
      by: row.no_luck_by ?? 'owner',
      since: row.no_luck_at?.toISOString() ?? null,
      choice: 'no_luck',
    };
  if (row.status === 'auto' && rule)
    return { value: true, by: 'rule', since: rule.toISOString(), choice: 'auto' };
  return { value: false, by: null, since: null, choice: row.status };
}

function personView(row: PersonRow, show: Show): JobPerson {
  const times = Object.fromEntries(
    jobPersonStatuses.flatMap((status) => {
      const at = row[`${status}_at`];
      return at ? [[status, at.toISOString()]] : [];
    }),
  ) as JobPerson['times'];
  const draftInfo = show(row);
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    headline: row.headline,
    language: row.language,
    profileKey: row.profile_key,
    profileUrl: linkedInProfileUrl(row.profile_key),
    messageUrl: row.member_urn ? linkedInMessageUrl(row.member_urn) : null,
    status: row.status,
    statusAt: times[row.status] ?? null,
    times,
    draft: draftInfo?.text ?? row.draft,
    draftRevision: row.draft_revision,
    draftInfo,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  };
}

const toolPerson = ({ profileUrl: _profile, messageUrl: _message, ...person }: JobPerson) => person;

const byActivity = (a: Summary, b: Summary) =>
  b.active - a.active ||
  (b.company.bestScore ?? -1) - (a.company.bestScore ?? -1) ||
  b.company.openPostings - a.company.openPostings ||
  a.company.name.localeCompare(b.company.name);

export function createJobCompanies(options: {
  pool: Pool;
  ownerId: string;
  settings: (client: Query) => Promise<WaveSettings>;
  timeZone: () => Promise<string>;
  drafts: JobDrafts;
  postings: (client: Query, companyId: string) => Promise<JobPosting[]>;
  startChat?: (text: string, attachments: [], sessionId: string) => Promise<unknown>;
  turnWrite: <T>(
    turn: TurnRef,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  owned: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
  changed: () => void;
}) {
  const { pool, ownerId } = options;

  async function inviteCounts(client: Query) {
    const zone = await options.timeZone();
    const now = new Date();
    const { rows } = await client.query<{ today: number; week: number }>(
      `SELECT count(*) FILTER (WHERE invited_at>=$2)::int AS today,
         count(*) FILTER (WHERE invited_at>=$3)::int AS week
       FROM job_people WHERE owner_id=$1`,
      [ownerId, localDayStart(zone, now), localDayStart(zone, now, 6)],
    );
    return rows[0] ?? { today: 0, week: 0 };
  }

  async function summaries(client: Query, filter: { id?: string; search?: string } = {}) {
    const settings = await options.settings(client);
    const invites = await inviteCounts(client);
    const search = filter.search?.toLowerCase() ?? null;
    const { rows } = await client.query<CompanyRow>(
      `SELECT c.id,c.name,c.linkedin_slug,c.careers_url,c.status,c.no_luck_at,c.no_luck_by,c.apply_session_id,
         c.revision,c.updated_at,
         ${applyState} AS apply_state,
         p.open,p.best,COALESCE(f.people,'[]') AS people,f.active
       FROM job_companies c
       LEFT JOIN LATERAL (SELECT count(*)::int AS open,max(j.score) AS best FROM job_postings j
         WHERE j.owner_id=c.owner_id AND j.company_id=c.id AND j.status IN ('new','shortlisted')) p ON true
       LEFT JOIN LATERAL (SELECT json_agg(json_build_object('status',e.status,'invited_at',e.invited_at,
           'asked_at',e.asked_at,'declined_at',e.declined_at)) AS people,max(e.updated_at) AS active
         FROM job_people e WHERE e.owner_id=c.owner_id AND e.company_id=c.id) f ON true
       WHERE c.owner_id=$1 AND ($2::uuid IS NULL OR c.id=$2)
         AND ($3::text IS NULL OR strpos(lower(c.name),$3)>0 OR ($4<>'' AND strpos(c.key,$4)>0))`,
      [ownerId, filter.id ?? null, search, search ? companyKey(search) : ''],
    );
    const now = Date.now();
    const list = rows.map((row): Summary => {
      const rule = row.status === 'auto' ? automaticNoLuck(row.people, settings, now) : null;
      const noLuck = noLuckOf(row, rule);
      const waves = companyWaves(row.people, settings, invites, now);
      const statuses = new Set(row.people.map((person) => person.status));
      const filters = new Set<JobCompanyFilter>();
      if (row.people.length || row.open || row.status !== 'auto') filters.add('all');
      if (noLuck.value) filters.add('no_luck');
      else {
        if (statuses.has('invited')) filters.add('waiting');
        if (statuses.has('accepted')) filters.add('to_ask');
        if (statuses.has('asked')) filters.add('asked');
        if (waves.state === 'next') filters.add('next_wave');
      }
      const count = (from: number) =>
        row.people.filter((person) => stage[person.status] >= from).length;
      const active = Math.max(
        row.active?.getTime() ?? 0,
        row.status === 'auto' ? 0 : row.updated_at.getTime(),
      );
      return {
        filters,
        active,
        company: {
          id: row.id,
          name: row.name,
          linkedinUrl: row.linkedin_slug ? companyPage(row.linkedin_slug) : null,
          careersUrl: row.careers_url,
          openPostings: row.open,
          bestScore: row.best,
          counts: {
            invited: row.people.length,
            accepted: count(1),
            asked: count(2),
            replied: count(3),
            referred: row.people.filter((person) => person.status === 'referred').length,
          },
          noLuck,
          applyChat:
            row.apply_session_id && row.apply_state
              ? { id: row.apply_session_id, state: row.apply_state }
              : null,
          waves,
          revision: row.revision,
          lastActivityAt: active ? new Date(active).toISOString() : null,
        },
      };
    });
    return {
      list,
      limits: { ...settings.noLuck, waves: settings.waves },
      invites: { ...invites, ...settings.inviteLimits },
    };
  }

  async function companies(
    client: Query,
    query: { filter?: JobCompanyFilter; search?: string; limit?: number },
  ): Promise<JobCompaniesView> {
    const { list, limits, invites } = await summaries(client, { search: query.search });
    const counts = Object.fromEntries(jobCompanyFilters.map((name) => [name, 0])) as Record<
      JobCompanyFilter,
      number
    >;
    for (const entry of list) for (const name of entry.filters) counts[name]++;
    const chosen = list.filter((entry) => entry.filters.has(query.filter ?? 'all'));
    chosen.sort(byActivity);
    return {
      companies: chosen.slice(0, query.limit ?? 100).map((entry) => entry.company),
      total: chosen.length,
      counts,
      limits,
      invites,
    };
  }

  async function personRows(client: Query, companyId: string) {
    const { rows } = await client.query<PersonRow>(
      'SELECT * FROM job_people WHERE owner_id=$1 AND company_id=$2',
      [ownerId, companyId],
    );
    return rows.sort(
      (a, b) =>
        peopleOrder[a.status] - peopleOrder[b.status] ||
        b.updated_at.getTime() - a.updated_at.getTime() ||
        a.id.localeCompare(b.id),
    );
  }

  async function company(client: Query, id: string): Promise<JobCompanyView> {
    const { list, limits } = await summaries(client, { id: parse(z.uuid(), id, 'The company id') });
    const found = list[0];
    if (!found) throw failure('Company not found.', 404);
    const show = await options.drafts.viewer(client);
    return {
      ...found.company,
      people: (await personRows(client, found.company.id)).map((row) => personView(row, show)),
      postings: await options.postings(client, found.company.id),
      limits,
    };
  }

  async function onePerson(client: Query, id: string) {
    const row = (
      await client.query<PersonRow>(
        'SELECT * FROM job_people WHERE owner_id=$1 AND id=$2 FOR UPDATE',
        [ownerId, parse(z.uuid(), id, 'The person id')],
      )
    ).rows[0];
    if (!row) throw failure('Person not found.', 404);
    return row;
  }

  async function companyFor(client: Query, entry: PersonEntry, label: string) {
    if (entry.companyId) {
      const found = await client.query('SELECT 1 FROM job_companies WHERE owner_id=$1 AND id=$2', [
        ownerId,
        entry.companyId,
      ]);
      if (!found.rowCount)
        throw failure(`${label}: no company has the id ${entry.companyId}.`, 404);
      return entry.companyId;
    }
    if (entry.company === undefined) return undefined;
    const id = await ensureCompany(client, ownerId, entry.company);
    if (!id)
      throw failure(
        `${label}: "${entry.company}" isn't a company name Nod can use. Ask the owner which company it is.`,
      );
    return id;
  }

  async function write<T>(
    label: string,
    keys: { profile: string; urn: string | null },
    run: () => Promise<T>,
  ) {
    try {
      return await run();
    } catch (error) {
      const { code, constraint } = error as { code?: unknown; constraint?: unknown };
      if (code === '23505')
        throw failure(
          `${label}: another person in the job search already has ${constraint === 'job_people_member' ? `the member id ${keys.urn}` : `the profile ${keys.profile}`}.`,
          409,
        );
      throw error;
    }
  }

  async function change(
    client: Query,
    current: PersonRow,
    next: Partial<Pick<PersonRow, 'company_id' | 'profile_key' | 'member_urn'>> & {
      name?: string;
      headline?: string;
      language?: string;
      status?: JobPersonStatus;
      at?: string;
    },
    label: string,
  ) {
    const status = next.status ?? current.status;
    const stamp = status !== current.status || next.at !== undefined;
    const fields = {
      company_id: next.company_id ?? current.company_id,
      profile_key: next.profile_key ?? current.profile_key,
      member_urn: next.member_urn ?? current.member_urn,
      name: next.name || current.name,
      headline: next.headline || current.headline,
      language: next.language ?? current.language,
    };
    const differs = Object.entries(fields).some(
      ([key, value]) => current[key as keyof typeof fields] !== value,
    );
    if (!stamp && !differs) return current;
    const column = timeColumn[status];
    return write(label, { profile: fields.profile_key, urn: fields.member_urn }, async () => {
      await client.query(
        `UPDATE job_people SET company_id=$3,profile_key=$4,member_urn=$5,name=$6,headline=$7,language=$8,status=$9,
           ${column}=CASE WHEN $10 THEN COALESCE($11::timestamptz,now()) ELSE ${column} END,
           revision=revision+1,updated_at=now()
         WHERE owner_id=$1 AND id=$2`,
        [
          ownerId,
          current.id,
          fields.company_id,
          fields.profile_key,
          fields.member_urn,
          fields.name,
          fields.headline,
          fields.language,
          status,
          stamp,
          next.at ?? null,
        ],
      );
      const after = await onePerson(client, current.id);
      if (after.status === 'accepted' && current.status !== 'accepted')
        await options.drafts.accepted(client, after.id);
      else if (
        after.language !== current.language &&
        (after.draft || after.draft_state || after.status === 'accepted')
      )
        await options.drafts.make(client, after.id);
      return onePerson(client, current.id);
    });
  }

  async function merge(
    client: Query,
    rows: PersonRow[],
    wanted: { key?: string; urn: string | null; id?: string },
    label: string,
  ) {
    const readable = new Set(
      [...rows.map((row) => row.profile_key), wanted.key ?? ''].filter(
        (key) => key && !memberId.test(key),
      ),
    );
    const urns = new Set(
      [
        ...rows.flatMap((row) => [
          row.member_urn,
          memberId.test(row.profile_key) ? row.profile_key : null,
        ]),
        wanted.urn,
      ].filter((urn): urn is string => Boolean(urn)),
    );
    if (readable.size > 1 || urns.size > 1) {
      const first =
        rows.find((row) => row.id === wanted.id) ??
        rows.find((row) => row.profile_key === wanted.key) ??
        rows[0]!;
      const other = rows.find((row) => row.id !== first.id)!;
      const clash =
        other.profile_key === wanted.key
          ? `the profile ${wanted.key}`
          : wanted.urn && (other.member_urn === wanted.urn || other.profile_key === wanted.urn)
            ? `the member id ${wanted.urn}`
            : `the profile ${other.profile_key}`;
      throw failure(
        `${label}: ${clash} belongs to another person (${other.id}), whose profile or member id differs from this one. Ask the owner which is right, then change one of them by its id.`,
        409,
      );
    }
    const [keep, drop] = [...rows].sort(
      (a, b) =>
        Number(memberId.test(a.profile_key)) - Number(memberId.test(b.profile_key)) ||
        a.created_at.getTime() - b.created_at.getTime(),
    ) as [PersonRow, PersonRow];
    const status =
      mergeOrder.indexOf(drop.status) > mergeOrder.indexOf(keep.status) ? drop.status : keep.status;
    await client.query(
      `UPDATE job_people k SET draft_state=d.draft_state,draft_reason=d.draft_reason,draft_note=d.draft_note,
         draft_language=d.draft_language,draft_language_by=d.draft_language_by,
         draft_template_revision=d.draft_template_revision,draft_missing=d.draft_missing,
         draft_inputs=d.draft_inputs,draft_at=d.draft_at
       FROM job_people d WHERE k.owner_id=$1 AND k.id=$2 AND d.owner_id=$1 AND d.id=$3
         AND k.draft='' AND k.draft_state IS NULL AND d.draft_state IS NOT NULL`,
      [ownerId, keep.id, drop.id],
    );
    await client.query(
      `INSERT INTO job_events(id,owner_id,kind,source,source_ref,person_id,detail,created_at)
       SELECT gen_random_uuid(),owner_id,kind,source,$2,$4::uuid,detail,created_at FROM job_events
       WHERE owner_id=$1 AND source IN ('draft','accept') AND source_ref=$3
       ON CONFLICT (owner_id,source,source_ref) DO NOTHING`,
      [ownerId, keep.id, drop.id, keep.id],
    );
    await client.query('DELETE FROM job_people WHERE owner_id=$1 AND id=$2', [ownerId, drop.id]);
    await client.query(
      `UPDATE job_people SET profile_key=$3,member_urn=$4,status=$5,
         invited_at=LEAST(invited_at,$6::timestamptz),accepted_at=LEAST(accepted_at,$7::timestamptz),
         asked_at=LEAST(asked_at,$8::timestamptz),replied_at=LEAST(replied_at,$9::timestamptz),
         referred_at=LEAST(referred_at,$10::timestamptz),declined_at=LEAST(declined_at,$11::timestamptz),
         name=CASE WHEN name='' THEN $12 ELSE name END,headline=CASE WHEN headline='' THEN $13 ELSE headline END,
         language=CASE WHEN language='' THEN $14 ELSE language END,
         draft_revision=CASE WHEN draft='' THEN $16 ELSE draft_revision END,
         draft=CASE WHEN draft='' THEN $15 ELSE draft END,
         created_at=LEAST(created_at,$17::timestamptz),revision=GREATEST(revision,$18)+1,updated_at=now()
       WHERE owner_id=$1 AND id=$2`,
      [
        ownerId,
        keep.id,
        [...readable][0] ?? keep.profile_key,
        [...urns][0] ?? null,
        status,
        ...jobPersonStatuses.map((name) => drop[`${name}_at`]),
        drop.name,
        drop.headline,
        drop.language,
        drop.draft,
        drop.draft_revision,
        drop.created_at,
        drop.revision,
      ],
    );
    return onePerson(client, keep.id);
  }

  async function savePerson(client: Query, entry: PersonEntry, label: string) {
    const profile = entry.profileUrl === undefined ? undefined : linkedInPerson(entry.profileUrl);
    if (profile === null)
      throw failure(
        `${label}: profileUrl needs a LinkedIn profile link such as https://www.linkedin.com/in/example-name.`,
      );
    const urn = entry.memberUrn === undefined ? undefined : memberUrn(entry.memberUrn);
    if (urn === null) throw failure(`${label}: memberUrn isn't a LinkedIn member id.`);
    const member = urn ?? profile?.urn ?? null;
    const byId = entry.id ? await onePerson(client, entry.id) : undefined;
    const matched = (
      await client.query<PersonRow>(
        `SELECT * FROM job_people WHERE owner_id=$1
           AND (profile_key=$2 OR ($3::text IS NOT NULL AND (member_urn=$3 OR profile_key=$3)))
         ORDER BY created_at,id FOR UPDATE`,
        [ownerId, profile?.key ?? null, member],
      )
    ).rows;
    const found = [
      ...new Map([...(byId ? [byId] : []), ...matched].map((row) => [row.id, row])).values(),
    ];
    if (found.length > 2)
      throw failure(
        `${label}: that profile and member id belong to different people (${found.map((row) => row.id).join(', ')}). Ask the owner which is right, then change them by their ids.`,
        409,
      );
    const current =
      found.length === 2
        ? await merge(client, found, { key: profile?.key, urn: member, id: entry.id }, label)
        : found[0];
    const companyId = await companyFor(client, entry, label);
    if (current) {
      const readable = !memberId.test(current.profile_key);
      return {
        created: false,
        row: await change(
          client,
          current,
          {
            ...(companyId ? { company_id: companyId } : {}),
            ...(profile && !(profile.urn && readable) ? { profile_key: profile.key } : {}),
            ...(member ? { member_urn: member } : {}),
            name: entry.name,
            headline: entry.headline,
            language: entry.language,
            status: entry.status,
            at: entry.at,
          },
          label,
        ),
      };
    }
    if (!companyId)
      throw failure(
        `${label}: a new person needs their company. Ask the owner which company they work at if it isn't clear.`,
      );
    const status = entry.status ?? 'invited';
    const id = randomUUID();
    await write(label, { profile: profile!.key, urn: member }, () =>
      client.query(
        `INSERT INTO job_people(id,owner_id,company_id,profile_key,member_urn,name,headline,language,status,${timeColumn[status]})
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz,now()))`,
        [
          id,
          ownerId,
          companyId,
          profile!.key,
          member,
          entry.name ?? '',
          entry.headline ?? '',
          entry.language ?? '',
          status,
          entry.at ?? null,
        ],
      ),
    );
    if (status === 'accepted') await options.drafts.accepted(client, id);
    return { created: true, row: await onePerson(client, id) };
  }

  async function updatePeople(turn: TurnRef, entries: PersonEntry[], signal?: AbortSignal) {
    return options.turnWrite(
      turn,
      async (client) => {
        if ((await rootedIn(client, ownerId, turn)) !== 'owner')
          throw failure(
            'Only work started by an owner message can add or change people in the job search.',
            403,
          );
        const saved = [];
        for (const [index, entry] of entries.entries()) {
          const { created, row: written } = await savePerson(client, entry, `people.${index}`);
          const row = await onePerson(client, written.id);
          const name = (
            await client.query<{ name: string }>(
              'SELECT name FROM job_companies WHERE owner_id=$1 AND id=$2',
              [ownerId, row.company_id],
            )
          ).rows[0]?.name;
          saved.push({
            ...toolPerson(personView(row, await options.drafts.viewer(client))),
            company: name ?? '',
            created,
          });
        }
        return { saved };
      },
      signal,
    );
  }

  async function ownerWork<T>(
    turn: TurnRef,
    what: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ) {
    return options.turnWrite(
      turn,
      async (client) => {
        if ((await rootedIn(client, ownerId, turn)) !== 'owner')
          throw failure(`Only work started by an owner message can ${what}.`, 403);
        return operation(client);
      },
      signal,
    );
  }

  async function draftResult(client: Query, id: string, extra: Record<string, unknown>) {
    const row = await onePerson(client, id);
    const view = personView(row, await options.drafts.viewer(client));
    const waves = (await summaries(client, { id: row.company_id })).list[0]?.company.waves;
    const draft = view.draftInfo;
    return {
      ...extra,
      person: toolPerson(view),
      draftRevision: row.draft_revision,
      ...(draft
        ? {
            state: draft.state,
            language: draft.language,
            text: draft.text,
            raw: draft.raw,
            ...(draft.reason ? { reason: draft.reason } : {}),
            ...(draft.note ? { note: draft.note } : {}),
          }
        : {}),
      waves,
    };
  }

  function prepareDraft(turn: TurnRef, request: DraftRequest, signal?: AbortSignal) {
    return ownerWork(
      turn,
      'prepare referral messages',
      async (client) => {
        const row = await onePerson(client, request.personId);
        if (row.draft_state === 'edited' && !request.replace)
          throw failure(
            'This message was edited after Nod made it. Ask the owner before replacing their version, then call draft_prepare again with replace: true.',
            409,
          );
        if (request.language !== undefined && request.language !== row.language)
          await client.query(
            'UPDATE job_people SET language=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2',
            [ownerId, row.id, request.language],
          );
        const made = await options.drafts.make(client, row.id, {
          inputs: {
            ...(request.postingId ? { postingId: request.postingId } : {}),
            ...(request.programme ? { programme: request.programme } : {}),
            ...(request.track ? { track: request.track } : {}),
            ...(request.role ? { role: request.role } : {}),
          },
        });
        return draftResult(client, row.id, {
          saved: made.saved,
          missing: made.missing,
          ...(made.missing.includes('template')
            ? {
                next: 'The owner has no saved message template. Ask them to save one on the Jobs page, Templates tab.',
              }
            : made.missing.length
              ? {
                  next: `Nothing was saved. Ask the owner for ${made.missing.map((name) => `{${name}}`).join(', ')}, then call draft_prepare again with them.`,
                }
              : made.state === 'tailoring'
                ? {
                    next: "Nod's small model is tailoring it now, and the result reaches the owner on the Jobs page and on their chat channel. Change it in this chat only when the owner asks, following rules, with draft_save against draftRevision.",
                    rules: tailoringRules,
                  }
                : { rules: tailoringRules }),
        });
      },
      signal,
    );
  }

  async function markNoLuck(
    id: string,
    choice: boolean | null,
    revision?: number,
  ): Promise<JobNoLuckResult> {
    const sessionId = randomUUID();
    if (choice === true && !options.startChat)
      throw failure('New chats are unavailable on this server.', 503);
    const start = await options.owned(async (client) => {
      const row = (
        await client.query<{
          id: string;
          status: JobNoLuckChoice;
          revision: number;
          apply_state: 'open' | 'starting' | 'lost' | null;
        }>(
          `SELECT c.id,c.status,c.revision,${applyState} AS apply_state
           FROM job_companies c WHERE c.owner_id=$1 AND c.id=$2 FOR UPDATE`,
          [ownerId, parse(z.uuid(), id, 'The company id')],
        )
      ).rows[0];
      if (!row) throw failure('Company not found.', 404);
      if (choice !== true && revision !== row.revision)
        throw failure(
          'This company changed since you loaded it. Reload it, then make your choice again.',
          409,
        );
      const status: JobNoLuckChoice =
        choice === true ? 'no_luck' : choice === false ? 'keep_trying' : 'auto';
      if (row.status !== status)
        await client.query(
          `UPDATE job_companies SET status=$3,
             no_luck_at=CASE WHEN $3='no_luck' THEN now() END,no_luck_by=CASE WHEN $3='no_luck' THEN 'owner' END,
             revision=revision+1,updated_at=now()
           WHERE owner_id=$1 AND id=$2`,
          [ownerId, row.id, status],
        );
      if (choice !== true || row.apply_state === 'open' || row.apply_state === 'starting')
        return null;
      await client.query(
        'UPDATE job_companies SET apply_session_id=$3,apply_started_at=now() WHERE owner_id=$1 AND id=$2',
        [ownerId, row.id, sessionId],
      );
      return row.id;
    });
    let apply: JobNoLuckResult['apply'] = choice === true ? { state: 'reused' } : null;
    if (start) {
      try {
        await options.startChat!(applyRequest(start), [], sessionId);
        apply = { state: 'started' };
      } catch (error) {
        await pool.query(
          `UPDATE job_companies SET apply_session_id=NULL,apply_started_at=NULL
           WHERE owner_id=$1 AND id=$2 AND apply_session_id=$3`,
          [ownerId, start, sessionId],
        );
        apply = { state: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
      options.changed();
    }
    return { company: await company(pool, id), apply };
  }

  function updatePerson(
    id: string,
    next: Parameters<typeof change>[2],
    revision: number,
  ): Promise<JobPerson> {
    return options.owned(async (client) => {
      const current = await onePerson(client, id);
      if (current.revision !== revision)
        throw failure(
          'This person changed since you loaded the company. Reload it, then make your change again.',
          409,
        );
      const row = await change(client, current, next, 'The person');
      return personView(row, await options.drafts.viewer(client));
    });
  }

  async function seenPerson(client: Query, key: string, urn: string | null, label: string) {
    const { rows } = await client.query<PersonRow>(
      `SELECT * FROM job_people WHERE owner_id=$1
         AND (profile_key=$2 OR ($3::text IS NOT NULL AND (member_urn=$3 OR profile_key=$3)))
       ORDER BY created_at,id FOR UPDATE`,
      [ownerId, key, urn],
    );
    if (rows.length > 1)
      throw failure(
        `${label}: the profile ${key} and the member id ${urn} belong to different people in the job search, so Nod changed neither.`,
        409,
      );
    const person = rows[0];
    if (!person) return undefined;
    if (urn && person.member_urn && person.member_urn !== urn)
      throw failure(
        `${label}: ${person.profile_key} already has another member id, so Nod kept it.`,
        409,
      );
    if (!memberId.test(key) && !memberId.test(person.profile_key) && person.profile_key !== key)
      throw failure(
        `${label}: the member id ${urn} belongs to ${person.profile_key}, not ${key}, so Nod changed neither.`,
        409,
      );
    return person;
  }

  async function onLinkedIn(client: Query, page: LinkedInCompany) {
    const bySlug = page.slug
      ? (
          await client.query<{ id: string }>(
            'SELECT id FROM job_companies WHERE owner_id=$1 AND linkedin_slug=$2',
            [ownerId, page.slug],
          )
        ).rows[0]?.id
      : undefined;
    if (bySlug) return bySlug;
    const key = page.name ? keyOf(page.name) : '';
    if (!key) return null;
    return (
      (
        await client.query<{ id: string }>(
          'SELECT id FROM job_companies WHERE owner_id=$1 AND key=$2',
          [ownerId, key],
        )
      ).rows[0]?.id ?? null
    );
  }

  async function pageCompany(client: Query, page: LinkedInCompany) {
    const id = await onLinkedIn(client, page);
    if (!id) return null;
    const { postings: _postings, ...view } = await company(client, id);
    return view;
  }

  async function logInvites(
    client: Query,
    page: LinkedInCompany & { name: string },
    people: SeenPerson[],
  ) {
    const companyId =
      (await onLinkedIn(client, page)) ?? (await ensureCompany(client, ownerId, page.name));
    if (!companyId)
      throw failure(`"${page.name}" isn't a company name Nod can use, so the invite wasn't saved.`);
    if (page.slug)
      await client.query(
        `UPDATE job_companies SET linkedin_slug=$3 WHERE owner_id=$1 AND id=$2 AND linkedin_slug IS NULL
           AND NOT EXISTS (SELECT 1 FROM job_companies o WHERE o.owner_id=$1 AND o.linkedin_slug=$3)`,
        [ownerId, companyId, page.slug],
      );
    const saved = [];
    for (const [index, person] of people.entries()) {
      const profile = linkedInPerson(person.profileUrl);
      if (!profile) throw failure(`people.${index}: profileUrl isn't a LinkedIn profile link.`);
      const urn = person.memberUrn ?? profile.urn;
      const known = await seenPerson(client, profile.key, urn, `people.${index}`);
      const { created, row } = await savePerson(
        client,
        known
          ? {
              id: known.id,
              profileUrl: person.profileUrl,
              ...(urn ? { memberUrn: urn } : {}),
              ...(known.name ? {} : { name: person.name }),
              ...(known.headline ? {} : { headline: person.headline }),
            }
          : {
              profileUrl: person.profileUrl,
              ...(urn ? { memberUrn: urn } : {}),
              name: person.name,
              headline: person.headline,
              companyId,
              status: 'invited',
            },
        `people.${index}`,
      );
      saved.push({ id: row.id, created, status: row.status, companyId: row.company_id });
    }
    return { companyId, saved };
  }

  async function acceptedPeople(client: Query) {
    const { rows } = await client.query<PersonRow & { company_name: string }>(
      `SELECT p.*,c.name AS company_name FROM job_people p
       JOIN job_companies c ON c.owner_id=p.owner_id AND c.id=p.company_id
       WHERE p.owner_id=$1 AND p.status='accepted'
       ORDER BY p.accepted_at DESC NULLS LAST,p.id LIMIT 50`,
      [ownerId],
    );
    if (!rows.length) return [];
    const show = await options.drafts.viewer(client);
    const waves = new Map(
      (await summaries(client)).list.map((entry) => [entry.company.id, entry.company.waves]),
    );
    return rows.flatMap((row) => {
      const company = waves.get(row.company_id);
      return company
        ? [{ ...personView(row, show), company: row.company_name, waves: company }]
        : [];
    });
  }

  async function profileTracked(client: Query, profileUrl: string, urn: string) {
    const profile = linkedInPerson(profileUrl);
    if (!profile || profile.urn)
      throw failure(
        'profileUrl needs the readable profile link, such as https://www.linkedin.com/in/example-name.',
      );
    return seenPerson(client, profile.key, urn, 'The profile');
  }

  async function pairProfile(client: Query, profileUrl: string, urn: string) {
    const known = await profileTracked(client, profileUrl, urn);
    if (!known) return null;
    const { row } = await savePerson(
      client,
      { id: known.id, profileUrl, memberUrn: urn },
      'The profile',
    );
    return row.id;
  }

  async function markAccepted(client: Query, profileUrls: string[], at?: string) {
    const keys = [
      ...new Set(
        profileUrls.flatMap((url) => {
          const profile = linkedInPerson(url);
          return profile ? [profile.key] : [];
        }),
      ),
    ];
    if (!keys.length) return [];
    const { rows } = await client.query<PersonRow>(
      `SELECT * FROM job_people WHERE owner_id=$1 AND status='invited'
         AND (profile_key=ANY($2::text[]) OR member_urn=ANY($2::text[]))
       ORDER BY created_at,id FOR UPDATE`,
      [ownerId, keys],
    );
    const accepted: string[] = [];
    for (const row of rows)
      accepted.push(
        (await change(client, row, { status: 'accepted', ...(at ? { at } : {}) }, 'The person')).id,
      );
    return accepted;
  }

  function handles(raw: unknown) {
    const action =
      raw && typeof raw === 'object' ? (raw as { action?: unknown }).action : undefined;
    return typeof action === 'string' && companyActions.has(action);
  }

  async function execute(turn: TurnRef, raw: unknown, signal?: AbortSignal) {
    const request = parse(toolInput, raw, 'The jobs request');
    const value = await (async (): Promise<unknown> => {
      switch (request.action) {
        case 'companies': {
          const view = await companies(pool, { ...request, limit: request.limit ?? 50 });
          return {
            ...view,
            companies: view.companies.map(({ linkedinUrl: _page, ...entry }) => entry),
          };
        }
        case 'company': {
          const { linkedinUrl: _page, people, ...view } = await company(pool, request.id);
          return { ...view, people: people.map(toolPerson) };
        }
        case 'person_update':
          return updatePeople(turn, request.people, signal);
        case 'draft_prepare':
          return prepareDraft(turn, request, signal);
        case 'draft_save':
          return ownerWork(
            turn,
            'change referral messages',
            async (client) => {
              await options.drafts.save(client, request.personId, {
                text: request.text,
                ...(request.changes !== undefined ? { changes: request.changes } : {}),
                revision: request.revision,
                actor: 'nod',
              });
              return draftResult(client, request.personId, { saved: true });
            },
            signal,
          );
      }
    })();
    if (request.action !== 'companies' && request.action !== 'company') options.changed();
    return untrustedBlock('job search records', JSON.stringify(value));
  }

  function registerRoutes(app: FastifyInstance) {
    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/api/jobs/companies',
      async (request) => {
        const query = parse(
          z
            .object({
              filter: z.enum(jobCompanyFilters).optional(),
              search: z.string().trim().min(1).max(80).optional(),
              limit: z.coerce.number().int().min(1).max(500).optional(),
            })
            .strict(),
          request.query,
          'The companies filter',
        );
        return companies(pool, query);
      },
    );
    app.get<{ Params: { id: string } }>('/api/jobs/companies/:id', (request) =>
      company(pool, request.params.id),
    );
    app.put<{ Params: { id: string } }>(
      '/api/jobs/companies/:id/no-luck',
      async (request): Promise<JobNoLuckResult> => {
        const { noLuck, revision } = parse(
          z
            .object({ noLuck: z.boolean().nullable(), revision: z.int().min(0).optional() })
            .strict()
            .refine((value) => value.noLuck === true || value.revision !== undefined, {
              message: "Unticking or handing the choice back to Nod needs the company's revision.",
            }),
          request.body,
          'The no-luck choice',
        );
        return markNoLuck(request.params.id, noLuck, revision);
      },
    );
    app.patch<{ Params: { id: string } }>('/api/jobs/people/:id', async (request) => {
      const { revision, ...next } = parse(
        z
          .object({ ...personFields, revision: z.int().min(0) })
          .strict()
          .refine(
            (value) =>
              value.status !== undefined ||
              value.name !== undefined ||
              value.headline !== undefined ||
              value.language !== undefined,
            { message: 'Send a status, name, headline or language.' },
          ),
        request.body,
        'The person change',
      );
      return updatePerson(request.params.id, next, revision);
    });
    app.post<{ Params: { id: string } }>('/api/jobs/people/:id/draft', async (request) => {
      const { draftRevision } = parse(
        z.object({ draftRevision: z.int().min(0) }).strict(),
        request.body,
        'The remake',
      );
      return options.owned(async (client) => {
        const current = await onePerson(client, request.params.id);
        if (current.draft_revision !== draftRevision)
          throw failure(
            'This message changed since you opened it. Reload the company, then remake it again.',
            409,
          );
        const made = await options.drafts.make(client, current.id);
        return {
          person: personView(
            await onePerson(client, current.id),
            await options.drafts.viewer(client),
          ),
          missing: made.missing,
        };
      });
    });
    app.put<{ Params: { id: string } }>('/api/jobs/people/:id/draft', async (request) => {
      const { text: body, draftRevision } = parse(
        z.object({ text: z.string().max(8000), draftRevision: z.int().min(0) }).strict(),
        request.body,
        'The message',
      );
      return options.owned(async (client) => {
        const current = await onePerson(client, request.params.id);
        await options.drafts.save(client, current.id, {
          text: body,
          revision: draftRevision,
          actor: 'owner',
        });
        return personView(await onePerson(client, current.id), await options.drafts.viewer(client));
      });
    });
  }

  return {
    handles,
    execute,
    registerRoutes,
    helper: {
      find: onLinkedIn,
      company: pageCompany,
      invites: logInvites,
      accepted: acceptedPeople,
      languages: (client: Query) => options.drafts.languages(client),
      inviteCounts,
      updatePerson,
      markNoLuck,
      profileTracked,
      pairProfile,
      markAccepted,
    },
  };
}

export type JobCompaniesHelper = ReturnType<typeof createJobCompanies>['helper'];
