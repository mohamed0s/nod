import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { jobPersonStatuses, type JobNoLuckResult } from '../shared/job-companies.ts';
import type {
  JobHelperAccepted,
  JobHelperCompany,
  JobHelperPairing,
  JobHelperView,
} from '../shared/job-helper.ts';
import { linkedInPerson, type JobCompaniesHelper } from './job-companies.ts';
import { clean } from './jobs-parsers.ts';
import { failure, parse, type Query } from './jobs-shared.ts';

export const jobHelperTables = `
  CREATE TABLE IF NOT EXISTS job_helper_tokens (
    id uuid PRIMARY KEY, owner_id text NOT NULL, token_hash text NOT NULL, origin text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_helper_tokens_hash ON job_helper_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS job_helper_tokens_owner ON job_helper_tokens(owner_id,created_at);
`;

export const helperOrigin = /^chrome-extension:\/\/[a-p]{32}$/;

const codeLetters = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const pairingMinutes = 10;
const pairingTries = 5;
const digest = (value: string) => createHash('sha256').update(value).digest();
const slugShape = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u;

function strictProfile(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'www.linkedin.com' &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/in\/[^/]+\/?$/.test(url.pathname) &&
    linkedInPerson(value) !== null
  );
}

const slug = z
  .string()
  .max(100, 'is too long for a LinkedIn company')
  .regex(slugShape, 'needs the company part of a linkedin.com/company/<name> address')
  .transform((value) => value.toLowerCase());
const companyName = z
  .string()
  .max(200, 'is too long for a company name')
  .transform((value) => clean(value, 160))
  .pipe(z.string().min(1, 'needs the company name'));
const profileUrl = z
  .string()
  .max(300, 'is too long for a profile link')
  .refine(strictProfile, 'needs a link of the form https://www.linkedin.com/in/<name>');
const memberUrn = z.string().regex(/^ACoAA[A-Za-z0-9_-]{10,120}$/, "isn't a LinkedIn member id");
const seenPerson = z
  .object({
    profileUrl,
    memberUrn: memberUrn.optional(),
    name: z
      .string()
      .max(200, 'is too long for a name')
      .transform((value) => clean(value, 160))
      .pipe(z.string().min(1, 'needs the name shown on the card')),
    headline: z
      .string()
      .max(400, 'is too long for a headline')
      .transform((value) => clean(value, 300))
      .default(''),
  })
  .strict();
const empty = z.object({}).strict();

export function createJobHelper(options: {
  pool: Pool;
  ownerId: string;
  companies: JobCompaniesHelper;
  inviteLimits: (client: Query) => Promise<{ daily: number; weekly: number }>;
  mainCv: () => Promise<{ name: string; bytes: Uint8Array }>;
  owned: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
}) {
  const { pool, ownerId, companies } = options;
  const paired = new WeakMap<FastifyRequest, string>();
  let pairing: { hash: Buffer; expires: number; tries: number } | null = null;

  async function verify(request: FastifyRequest) {
    const origin = request.headers.origin;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '')?.[1];
    if (typeof origin !== 'string' || !helperOrigin.test(origin) || !token) return false;
    const row = (
      await pool.query<{ id: string; origin: string }>(
        'SELECT id,origin FROM job_helper_tokens WHERE owner_id=$1 AND token_hash=$2 AND revoked_at IS NULL',
        [ownerId, digest(token).toString('hex')],
      )
    ).rows[0];
    if (!row || row.origin !== origin) return false;
    paired.set(request, row.id);
    await pool.query(
      `UPDATE job_helper_tokens SET last_used_at=now()
       WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')`,
      [row.id],
    );
    return true;
  }

  function helperOf(request: FastifyRequest) {
    if (!paired.has(request))
      throw failure('This helper is not paired. Pair it again on the Jobs page, Helper tab.', 401);
  }

  async function view(): Promise<JobHelperView> {
    const { rows } = await pool.query<{
      id: string;
      origin: string;
      created_at: Date;
      last_used_at: Date | null;
    }>(
      `SELECT id,origin,created_at,last_used_at FROM job_helper_tokens
       WHERE owner_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [ownerId],
    );
    if (pairing && pairing.expires <= Date.now()) pairing = null;
    return {
      helpers: rows.map((row) => ({
        id: row.id,
        extensionId: row.origin.slice('chrome-extension://'.length),
        pairedAt: row.created_at.toISOString(),
        lastUsedAt: row.last_used_at?.toISOString() ?? null,
      })),
      pairing: pairing ? { expiresAt: new Date(pairing.expires).toISOString() } : null,
    };
  }

  async function redeem(raw: unknown) {
    const input = parse(
      z
        .object({
          code: z.string().max(32, 'is too long for a pairing code'),
          extensionId: z
            .string()
            .regex(/^[a-p]{32}$/, 'needs the Edge extension id, 32 letters from a to p'),
        })
        .strict(),
      raw,
      'The pairing request',
    );
    if (!pairing || pairing.expires <= Date.now()) {
      pairing = null;
      throw failure(
        'No pairing code is waiting. On the Jobs page, open Helper, select Pair the Edge panel, then run the script again.',
        410,
      );
    }
    if (!timingSafeEqual(digest(input.code.toUpperCase().replace(/[\s-]/g, '')), pairing.hash)) {
      pairing.tries += 1;
      const left = pairingTries - pairing.tries;
      if (left <= 0) pairing = null;
      throw failure(
        left > 0
          ? `That pairing code is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'That pairing code is wrong, and that was the last try. Make a new code on the Jobs page.',
        403,
      );
    }
    pairing = null;
    const token = randomBytes(32).toString('base64url');
    const origin = `chrome-extension://${input.extensionId}`;
    await options.owned(async (client) => {
      await client.query(
        'UPDATE job_helper_tokens SET revoked_at=now() WHERE owner_id=$1 AND origin=$2 AND revoked_at IS NULL',
        [ownerId, origin],
      );
      await client.query(
        'INSERT INTO job_helper_tokens(id,owner_id,token_hash,origin) VALUES($1,$2,$3,$4)',
        [randomUUID(), ownerId, digest(token).toString('hex'), origin],
      );
    });
    return { token, origin };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/jobs/helper', view);
    app.post('/api/jobs/helper/pairing', async (): Promise<JobHelperPairing> => {
      const code = Array.from({ length: 8 }, () => codeLetters[randomInt(codeLetters.length)]).join(
        '',
      );
      const expires = Date.now() + pairingMinutes * 60_000;
      pairing = { hash: digest(code), expires, tries: 0 };
      return {
        code: `${code.slice(0, 4)}-${code.slice(4)}`,
        expiresAt: new Date(expires).toISOString(),
      };
    });
    app.delete('/api/jobs/helper/pairing', async () => {
      pairing = null;
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/api/jobs/helper/:id/revoke', async (request) => {
      const id = parse(z.uuid(), request.params.id, 'The helper id');
      const revoked = await options.owned((client) =>
        client.query(
          'UPDATE job_helper_tokens SET revoked_at=now() WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL',
          [ownerId, id],
        ),
      );
      if (!revoked.rowCount) throw failure('That helper is not paired.', 404);
      return { ok: true };
    });
    app.post(
      '/api/helper-pairing',
      { bodyLimit: 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      (request) => redeem(request.body),
    );

    const helperRoute = {
      bodyLimit: 64 * 1024,
      config: {
        rateLimit: {
          max: 240,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => paired.get(request) ?? ownerId,
        },
      },
    };
    app.post('/api/helper/company', helperRoute, async (request): Promise<JobHelperCompany> => {
      helperOf(request);
      const page = parse(
        z.object({ slug: slug.optional(), name: companyName.optional() }).strict(),
        request.body ?? {},
        'The company page',
      );
      const [company, counts, limits] = await Promise.all([
        page.slug || page.name ? companies.company(pool, page) : null,
        companies.inviteCounts(pool),
        options.inviteLimits(pool),
      ]);
      return { company, invites: { ...counts, ...limits } };
    });
    app.post('/api/helper/invites', helperRoute, async (request) => {
      helperOf(request);
      const input = parse(
        z
          .object({
            company: z.object({ slug, name: companyName }).strict(),
            people: z.array(seenPerson).min(1).max(20),
          })
          .strict(),
        request.body,
        'The invites',
      );
      return options.owned((client) => companies.invites(client, input.company, input.people));
    });
    app.post('/api/helper/accepted', helperRoute, async (request): Promise<JobHelperAccepted> => {
      helperOf(request);
      parse(empty, request.body ?? {}, 'The request');
      return { people: await companies.accepted(pool) };
    });
    app.post<{ Params: { id: string } }>(
      '/api/helper/people/:id/status',
      helperRoute,
      async (request) => {
        helperOf(request);
        const input = parse(
          z.object({ status: z.enum(jobPersonStatuses), revision: z.int().min(0) }).strict(),
          request.body,
          'The status change',
        );
        return companies.updatePerson(request.params.id, { status: input.status }, input.revision);
      },
    );
    app.post('/api/helper/profile', helperRoute, async (request) => {
      helperOf(request);
      const input = parse(
        z.object({ profileUrl, memberUrn }).strict(),
        request.body,
        'The profile page',
      );
      if (!(await companies.profileTracked(pool, input.profileUrl, input.memberUrn)))
        return { person: null };
      return {
        person: await options.owned((client) =>
          companies.pairProfile(client, input.profileUrl, input.memberUrn),
        ),
      };
    });
    app.post('/api/helper/connections', helperRoute, async (request) => {
      helperOf(request);
      const input = parse(
        z.object({ people: z.array(z.object({ profileUrl }).strict()).min(1).max(100) }).strict(),
        request.body,
        'The connections',
      );
      return {
        accepted: await options.owned((client) =>
          companies.markAccepted(
            client,
            input.people.map((person) => person.profileUrl),
          ),
        ),
      };
    });
    app.post('/api/helper/cv', helperRoute, async (request, reply) => {
      helperOf(request);
      parse(empty, request.body ?? {}, 'The request');
      const { name, bytes } = await options.mainCv();
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(Buffer.from(bytes));
    });
    app.post<{ Params: { id: string } }>(
      '/api/helper/companies/:id/no-luck',
      helperRoute,
      async (request): Promise<JobNoLuckResult> => {
        helperOf(request);
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
        return companies.markNoLuck(request.params.id, noLuck, revision);
      },
    );
  }

  return { verify, registerRoutes };
}
