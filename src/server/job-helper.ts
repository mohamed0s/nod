import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { jobPersonStatuses, type JobNoLuckResult } from '../shared/job-companies.ts';
import { languageTag } from '../shared/jobs.ts';
import type {
  JobHelperAccepted,
  JobHelperCompany,
  JobHelperPairing,
  JobHelperView,
} from '../shared/job-helper.ts';
import { linkedInPerson, type JobCompaniesHelper } from './job-companies.ts';
import { clean } from './jobs-parsers.ts';
import { failure, parse, type Query } from './jobs-shared.ts';
import { validateRequestText } from './request-text.ts';

export const jobHelperTables = `
  CREATE TABLE IF NOT EXISTS job_helper_tokens (
    id uuid PRIMARY KEY, owner_id text NOT NULL, token_hash text NOT NULL, origin text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_helper_tokens_hash ON job_helper_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS job_helper_tokens_owner ON job_helper_tokens(owner_id,created_at);
  CREATE TABLE IF NOT EXISTS job_helper_uses (
    id uuid PRIMARY KEY, owner_id text NOT NULL, token_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('apply','company')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS job_helper_uses_owner ON job_helper_uses(owner_id,kind,created_at);
`;

export const helperOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
export const pairingIterations = 210_000;
export const dailyApplyChats = 5;
export const dailyCompanies = 30;

const codeLetters = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const pairingMinutes = 10;
const pairingTries = 5;
const clockSkew = 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const slugShape = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u;
const derive = promisify(pbkdf2);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest();
const mac = (key: Buffer, parts: string[]) =>
  createHmac('sha256', key).update(parts.join('\n')).digest('base64url');
const same = (actual: string, expected: string) => {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

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
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'needs 32 random bytes in base64url');
const extensionId = z
  .string()
  .regex(/^[a-p]{32}$/, 'needs the browser extension id, 32 letters from a to p');

async function pairingKeys(code: string, clientNonce: string, serverNonce: string) {
  const root = await derive(
    code,
    `nod-helper-pairing\n${clientNonce}\n${serverNonce}`,
    pairingIterations,
    32,
    'sha256',
  );
  const key = (label: string) => createHmac('sha256', root).update(label).digest();
  return { proof: key('proof'), encrypt: key('encrypt'), mac: key('mac') };
}

export const helperRoutes = new Set([
  '/api/helper-pairing/start',
  '/api/helper-pairing/finish',
  '/api/helper/hello',
  '/api/helper/company',
  '/api/helper/invites',
  '/api/helper/accepted',
  '/api/helper/people/:id/status',
  '/api/helper/profile',
  '/api/helper/connections',
  '/api/helper/cv',
  '/api/helper/companies/:id/no-luck',
]);

export function helperKeys(base: Buffer) {
  const key = (label: string) => createHmac('sha256', base).update(label).digest();
  return { mac: key('nod-helper-mac'), encrypt: key('nod-helper-encrypt') };
}

function seal(key: Buffer, plain: Buffer, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ iv: iv.toString('base64url'), data: data.toString('base64url') });
}

const envelope = z
  .object({
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    data: z
      .string()
      .regex(/^[A-Za-z0-9_-]{22,}$/)
      .max(120_000),
  })
  .strict();

function open(key: Buffer, value: unknown, context: string) {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) return null;
  const data = Buffer.from(parsed.data.data, 'base64url');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.data.iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  } catch {
    return null;
  }
}

export function createJobHelper(options: {
  pool: Pool;
  ownerId: string;
  companies: JobCompaniesHelper;
  inviteLimits: (client: Query) => Promise<{ daily: number; weekly: number }>;
  mainCv: () => Promise<{ name: string; bytes: Uint8Array }>;
  owned: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
}) {
  const { pool, ownerId, companies } = options;
  type Signed = {
    id: string;
    keys: ReturnType<typeof helperKeys>;
    signature: string;
    time: string;
  };
  const signed = new WeakMap<FastifyRequest, Signed>();
  const authentic = new WeakSet<FastifyRequest>();
  const verified = new WeakSet<FastifyRequest>();
  const bodies = new WeakMap<FastifyRequest, string>();
  const replays = new Map<string, number>();
  const windows = new Map<string, { count: number; reset: number }>();
  const challenges = new Map<
    string,
    { clientNonce: string; extensionId: string; expires: number }
  >();
  let pairing: { code: string; expires: number; tries: number } | null = null;
  let applying: Promise<unknown> = Promise.resolve();

  const routeKind = (request: FastifyRequest) =>
    (request.routeOptions.config as { helper?: unknown } | undefined)?.helper;

  const busy = (message: string) => failure(message, 429);

  function limit(name: string, max: number) {
    const now = Date.now();
    if (windows.size > 1000)
      for (const [key, value] of windows) if (value.reset <= now) windows.delete(key);
    if (windows.size > 5000) throw busy('Nod is getting too many helper requests. Wait a minute.');
    const window = windows.get(name);
    if (!window || window.reset <= now) windows.set(name, { count: 1, reset: now + 60_000 });
    else if (++window.count > max)
      throw busy('Nod is getting too many helper requests. Wait a minute.');
  }

  const requestContext = (request: FastifyRequest, time: string) =>
    ['nod-helper-request', request.method, request.headers.host ?? '', request.url, time].join(
      '\n',
    );

  async function exempt(request: FastifyRequest) {
    const kind = routeKind(request);
    if (kind !== 'pairing' && kind !== 'paired') return false;
    if (!helperRoutes.has(request.routeOptions.url ?? '')) return false;
    if (request.method !== 'POST') throw failure('Helper routes take only POST requests.', 405);
    const socket = request.raw.socket;
    if (
      socket.localAddress !== '127.0.0.1' ||
      request.headers.host !== `127.0.0.1:${socket.localPort}`
    )
      throw failure(
        'Helper requests must reach Nod at its 127.0.0.1 address, by that address.',
        403,
      );
    limit(`remote:${request.ip}`, 1200);
    if (kind === 'pairing') {
      const site = request.headers['sec-fetch-site'];
      if (request.headers.origin !== undefined || (site !== undefined && site !== 'none'))
        throw failure('Pairing takes requests only from the pairing script, not a browser.', 403);
      return true;
    }
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !helperOrigin.test(origin))
      throw failure('Helper requests must come from a paired extension.', 403);
    const id = request.headers['x-nod-helper'];
    const time = request.headers['x-nod-time'];
    const signature = request.headers['x-nod-signature'];
    if (
      typeof id !== 'string' ||
      !uuid.test(id) ||
      typeof time !== 'string' ||
      !/^\d{13}$/.test(time) ||
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      throw failure(
        'This helper request is not signed. Pair the helper again on the Jobs page.',
        401,
      );
    limit(`key:${id}`, 600);
    if (Math.abs(Date.now() - Number(time)) > clockSkew)
      throw failure(
        "This helper request's time is more than a minute away from Nod's clock. Check the computer's time.",
        401,
      );
    const row = (
      await pool.query<{ id: string; token_hash: string; origin: string }>(
        'SELECT id,token_hash,origin FROM job_helper_tokens WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL',
        [ownerId, id],
      )
    ).rows[0];
    if (!row || row.origin !== origin)
      throw failure(
        'This helper is not paired, or its pairing was revoked. Pair it again on the Jobs page.',
        401,
      );
    signed.set(request, {
      id: row.id,
      keys: helperKeys(Buffer.from(row.token_hash, 'hex')),
      signature,
      time,
    });
    return true;
  }

  async function checkSignature(request: FastifyRequest) {
    if (routeKind(request) !== 'paired') return;
    const pending = signed.get(request);
    if (!pending)
      throw failure('This helper is not paired. Pair it again on the Jobs page, Helper tab.', 401);
    const context = requestContext(request, pending.time);
    const expected = mac(pending.keys.mac, [
      context,
      sha256(bodies.get(request) ?? '').toString('hex'),
    ]);
    if (!same(pending.signature, expected))
      throw failure(
        "This helper request's signature doesn't match. Pair the helper again on the Jobs page.",
        401,
      );
    authentic.add(request);
    const now = Date.now();
    if (replays.size > 1000)
      for (const [signature, expires] of replays) if (expires < now) replays.delete(signature);
    if (replays.size > 10_000)
      throw busy('Nod is getting too many helper requests. Wait a minute.');
    if (replays.has(pending.signature))
      throw failure('This helper request was already received once.', 401);
    replays.set(pending.signature, now + 2 * clockSkew);
    const plain = open(pending.keys.encrypt, request.body, context);
    if (!plain) throw failure("This helper request's body couldn't be decrypted.", 400);
    let body: unknown;
    try {
      body = JSON.parse(plain.toString('utf8'));
    } catch {
      throw failure("This helper request's body isn't JSON.", 400);
    }
    validateRequestText(body);
    request.body = body;
    verified.add(request);
    await pool.query(
      `UPDATE job_helper_tokens SET last_used_at=now()
       WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')`,
      [pending.id],
    );
  }

  function sealReply(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
    const pending = signed.get(request);
    if (!pending || !authentic.has(request)) return payload;
    const body =
      typeof payload === 'string'
        ? Buffer.from(payload)
        : Buffer.isBuffer(payload)
          ? payload
          : payload === null || payload === undefined
            ? Buffer.alloc(0)
            : null;
    if (body === null) return payload;
    const header = (name: string) => {
      const value = reply.getHeader(name);
      return value === undefined ? '' : String(value);
    };
    const sealed = seal(
      pending.keys.encrypt,
      Buffer.from(
        JSON.stringify({
          type: header('content-type'),
          disposition: header('content-disposition'),
          retryAfter: header('retry-after'),
          body: body.toString('base64'),
        }),
      ),
      `nod-helper-response\n${pending.signature}`,
    );
    reply.removeHeader('content-disposition');
    reply.removeHeader('retry-after');
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header(
      'x-nod-signature',
      mac(pending.keys.mac, [
        'nod-helper-response',
        pending.signature,
        String(reply.statusCode),
        sha256(sealed).toString('hex'),
      ]),
    );
    return sealed;
  }

  function helperOf(request: FastifyRequest) {
    const pending = signed.get(request);
    if (!pending || !verified.has(request))
      throw failure('This helper is not paired. Pair it again on the Jobs page, Helper tab.', 401);
    return pending.id;
  }

  async function capped(
    client: Query,
    reply: FastifyReply,
    kind: 'apply' | 'company',
    max: number,
    message: string,
    tokenId?: string,
  ) {
    const { rows } = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM job_helper_uses
       WHERE owner_id=$1 AND kind=$2 AND ($3::uuid IS NULL OR token_id=$3)
         AND created_at>now()-interval '1 day' ORDER BY created_at`,
      [ownerId, kind, tokenId ?? null],
    );
    if (rows.length < max) return;
    const frees = rows[rows.length - max]!.created_at.getTime() + 86_400_000;
    reply.header('retry-after', String(Math.max(1, Math.ceil((frees - Date.now()) / 1000))));
    throw failure(message, 429);
  }

  const use = (client: Query, kind: 'apply' | 'company', tokenId: string) =>
    client.query('INSERT INTO job_helper_uses(id,owner_id,token_id,kind) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      ownerId,
      tokenId,
      kind,
    ]);

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

  const noCode = () =>
    failure(
      'No pairing code is waiting. On the Jobs page, open Helper, select Pair a helper, then run the pairing script again.',
      410,
    );

  function waiting() {
    if (!pairing || pairing.expires <= Date.now()) {
      pairing = null;
      throw noCode();
    }
    return pairing;
  }

  function startPairing(raw: unknown) {
    const input = parse(
      z.object({ extensionId, clientNonce: nonce }).strict(),
      raw,
      'The pairing request',
    );
    waiting();
    const now = Date.now();
    for (const [key, value] of challenges) if (value.expires < now) challenges.delete(key);
    while (challenges.size >= 5) challenges.delete(challenges.keys().next().value!);
    const serverNonce = randomBytes(32).toString('base64url');
    challenges.set(serverNonce, { ...input, expires: now + 2 * 60_000 });
    return { serverNonce };
  }

  async function finishPairing(raw: unknown) {
    const input = parse(
      z.object({ extensionId, clientNonce: nonce, serverNonce: nonce, proof: nonce }).strict(),
      raw,
      'The pairing request',
    );
    const current = waiting();
    const challenge = challenges.get(input.serverNonce);
    challenges.delete(input.serverNonce);
    if (
      !challenge ||
      challenge.expires < Date.now() ||
      challenge.clientNonce !== input.clientNonce ||
      challenge.extensionId !== input.extensionId
    )
      throw failure(
        'This pairing attempt expired or was already used. Run the pairing script again.',
        409,
      );
    const keys = await pairingKeys(current.code, input.clientNonce, input.serverNonce);
    if (pairing !== current) throw noCode();
    const proof = mac(keys.proof, [input.extensionId, input.clientNonce, input.serverNonce]);
    if (!same(input.proof, proof)) {
      current.tries += 1;
      const left = pairingTries - current.tries;
      if (left <= 0) pairing = null;
      throw failure(
        left > 0
          ? `That pairing code is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'That pairing code is wrong, and that was the last try. Make a new code on the Jobs page.',
        403,
      );
    }
    pairing = null;
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const origin = `chrome-extension://${input.extensionId}`;
    await options.owned(async (client) => {
      await client.query(
        'UPDATE job_helper_tokens SET revoked_at=now() WHERE owner_id=$1 AND origin=$2 AND revoked_at IS NULL',
        [ownerId, origin],
      );
      await client.query(
        'INSERT INTO job_helper_tokens(id,owner_id,token_hash,origin) VALUES($1,$2,$3,$4)',
        [id, ownerId, sha256(token).toString('hex'), origin],
      );
    });
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', keys.encrypt, iv);
    const sealed = Buffer.concat([
      cipher.update(JSON.stringify({ id, token }), 'utf8'),
      cipher.final(),
    ]).toString('base64');
    const ivText = iv.toString('base64');
    return { iv: ivText, sealed, mac: mac(keys.mac, [input.extensionId, ivText, sealed]) };
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onRoute', (route) => {
      if (
        (route.config as { helper?: unknown } | undefined)?.helper !== undefined &&
        !(route.method === 'POST' && helperRoutes.has(route.url))
      )
        throw new Error(
          `Only the job search helper's own routes may skip the owner key, not ${String(route.method)} ${route.url}.`,
        );
    });
    app.get('/api/jobs/helper', view);
    app.post('/api/jobs/helper/pairing', async (): Promise<JobHelperPairing> => {
      const code = Array.from({ length: 8 }, () => codeLetters[randomInt(codeLetters.length)]).join(
        '',
      );
      const expires = Date.now() + pairingMinutes * 60_000;
      pairing = { code, expires, tries: 0 };
      challenges.clear();
      return {
        code: `${code.slice(0, 4)}-${code.slice(4)}`,
        expiresAt: new Date(expires).toISOString(),
      };
    });
    app.delete('/api/jobs/helper/pairing', async () => {
      pairing = null;
      challenges.clear();
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

    app.register(async (scope) => {
      const json = scope.getDefaultJsonParser('error', 'error');
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (request, body, done) => {
          bodies.set(request, body as string);
          json(request, body as string, done);
        },
      );
      scope.addHook('preValidation', checkSignature);
      scope.addHook('onSend', async (request, reply, payload) =>
        sealReply(request, reply, payload),
      );

      const pairingRoute = {
        bodyLimit: 2048,
        config: {
          helper: 'pairing',
          rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: () => 'helper-pairing' },
        },
      };
      scope.post('/api/helper-pairing/start', pairingRoute, async (request) =>
        startPairing(request.body),
      );
      scope.post('/api/helper-pairing/finish', pairingRoute, (request) =>
        finishPairing(request.body),
      );

      const helperRoute = {
        bodyLimit: 160 * 1024,
        config: {
          helper: 'paired',
          rateLimit: {
            max: 240,
            timeWindow: '1 minute',
            hook: 'preHandler' as const,
            keyGenerator: (request: FastifyRequest) => signed.get(request)?.id ?? ownerId,
          },
        },
      };
      scope.post('/api/helper/hello', helperRoute, async (request) => {
        helperOf(request);
        parse(empty, request.body ?? {}, 'The request');
        return { ok: true };
      });
      scope.post('/api/helper/company', helperRoute, async (request): Promise<JobHelperCompany> => {
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
      scope.post('/api/helper/invites', helperRoute, async (request, reply) => {
        const token = helperOf(request);
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
        return options.owned(async (client) => {
          const known = await companies.find(client, input.company);
          if (!known)
            await capped(
              client,
              reply,
              'company',
              dailyCompanies,
              `The helper added ${dailyCompanies} new companies in the last day. It can save this invite once the limit frees up; add the company in Nod's chat to save it sooner.`,
            );
          const result = await companies.invites(client, input.company, input.people);
          if (!known) await use(client, 'company', token);
          return result;
        });
      });
      scope.post(
        '/api/helper/accepted',
        helperRoute,
        async (request): Promise<JobHelperAccepted> => {
          helperOf(request);
          parse(empty, request.body ?? {}, 'The request');
          return {
            people: await companies.accepted(pool),
            languages: await companies.languages(pool),
          };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/helper/people/:id/status',
        helperRoute,
        async (request) => {
          helperOf(request);
          const { revision, ...change } = parse(
            z
              .object({
                status: z.enum(jobPersonStatuses).optional(),
                language: z.union([languageTag, z.literal('')]).optional(),
                revision: z.int().min(0),
              })
              .strict()
              .refine((value) => value.status !== undefined || value.language !== undefined, {
                message: 'Send a status, a language or both.',
              }),
            request.body,
            'The status change',
          );
          return companies.updatePerson(request.params.id, change, revision);
        },
      );
      scope.post('/api/helper/profile', helperRoute, async (request) => {
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
      scope.post('/api/helper/connections', helperRoute, async (request) => {
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
      scope.post('/api/helper/cv', helperRoute, async (request, reply) => {
        helperOf(request);
        parse(empty, request.body ?? {}, 'The request');
        const { name, bytes } = await options.mainCv();
        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
          .send(Buffer.from(bytes));
      });
      scope.post<{ Params: { id: string } }>(
        '/api/helper/companies/:id/no-luck',
        helperRoute,
        async (request, reply): Promise<JobNoLuckResult> => {
          const token = helperOf(request);
          const { noLuck, revision } = parse(
            z
              .object({ noLuck: z.boolean().nullable(), revision: z.int().min(0).optional() })
              .strict()
              .refine((value) => value.noLuck === true || value.revision !== undefined, {
                message:
                  "Unticking or handing the choice back to Nod needs the company's revision.",
              }),
            request.body,
            'The no-luck choice',
          );
          const run = applying.then(async () => {
            if (noLuck === true)
              await capped(
                pool,
                reply,
                'apply',
                dailyApplyChats,
                `This helper started ${dailyApplyChats} apply chats in the last day. Tick the company on Nod's Jobs page to start more.`,
                token,
              );
            const result = await companies.markNoLuck(request.params.id, noLuck, revision);
            if (result.apply?.state === 'started') await use(pool, 'apply', token);
            return result;
          });
          applying = run.catch(() => {});
          return run;
        },
      );
    });
  }

  return { exempt, registerRoutes };
}
