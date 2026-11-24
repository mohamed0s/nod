import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { isEnterKey } from '../shared/browser-keys.ts';
import type { JobPosting } from '../shared/job-postings.ts';
import { fileBytes, fileName } from '../shared/files.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import type { ArtifactService } from './artifacts.ts';
import { logFailure } from './failure-log.ts';
import type { StartWork } from './job-companies.ts';
import {
  applyChatOf,
  companyLabel,
  failure,
  parse,
  rootedIn,
  type Query,
  type TurnRef,
} from './jobs-shared.ts';
import { afterCommit, transaction } from './transaction.ts';

export const jobApplyTables = `
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS tailored_cv_artifact_id uuid;
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS applied_at timestamptz;
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS application_ref text NOT NULL DEFAULT '';
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS apply_session_id uuid;
  ALTER TABLE job_companies ADD COLUMN IF NOT EXISTS apply_by text CHECK (apply_by IN ('owner','rule'));
  UPDATE job_companies SET apply_by='owner' WHERE apply_by IS NULL AND apply_session_id IS NOT NULL;
  ALTER TABLE job_companies ADD COLUMN IF NOT EXISTS apply_origins text[] NOT NULL DEFAULT '{}';
  ALTER TABLE job_companies ADD COLUMN IF NOT EXISTS apply_resume_at timestamptz;
  CREATE INDEX IF NOT EXISTS job_companies_apply_chat ON job_companies(owner_id,apply_session_id)
    WHERE apply_session_id IS NOT NULL;
`;

export const applySiteAction = 'NOD_job_apply_site';

export const applyActions = new Set(['cv_tailored']);

export type Automatic = {
  start: StartWork;
  lock: (client: PoolClient) => Promise<unknown>;
  ready?: () => boolean;
  paused?: () => Promise<boolean>;
};

type SiteStep = {
  step: { action: string; key?: string };
  page: { origin: string; url: string; controls?: Array<{ role: string }> };
  subagent: boolean;
};

const folder = 'shared/career-ops';
const tailoredPath = (postingId: string) => `${folder}/output/tailored-${postingId}.pdf`;
const checkEvery = 10 * 60_000;
const settle = 3_000;
const toolInput = z.object({ action: z.literal('cv_tailored'), postingId: z.uuid() }).strict();
const tenantHosts = [
  '.myworkdayjobs.com',
  '.icims.com',
  '.taleo.net',
  '.bamboohr.com',
  '.recruitee.com',
  '.teamtailor.com',
  '.breezy.hr',
  '.applytojob.com',
];
const greenhouseHosts = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);
const notTenants = new Set(['embed', 'j']);
const plainControls = new Set(['button', 'link', 'tab']);
const entryActions = new Set([
  'fill',
  'type',
  'select',
  'check',
  'uncheck',
  'upload',
  'drag',
  'evaluate',
]);
const siteInput = z
  .object({
    companyId: z.uuid(),
    site: z
      .string()
      .max(300)
      .regex(/^https?:\/\/[^/\s`]+(?:\/[^/\s`]+)?$/),
  })
  .strict();

export function applySite(url: string) {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return null;
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return null;
  const host = page.hostname.toLowerCase();
  if (tenantHosts.some((suffix) => host.endsWith(suffix))) return page.origin;
  const first = page.pathname.split('/').find(Boolean)?.toLowerCase();
  if (greenhouseHosts.has(host) && first === 'embed') {
    const tenant = page.searchParams.get('for')?.toLowerCase();
    return tenant && /^[a-z0-9_-]{1,100}$/.test(tenant) ? `${page.origin}/${tenant}` : null;
  }
  if (first && notTenants.has(first)) return null;
  return first ? `${page.origin}/${first}` : page.origin;
}

export function entryStep(request: Pick<SiteStep, 'step' | 'page'>) {
  const { action, key } = request.step;
  if (entryActions.has(action)) return true;
  if (action === 'press') return !isEnterKey(key);
  if (action !== 'click') return false;
  const controls = request.page.controls ?? [];
  return !(controls.length === 1 && plainControls.has(controls[0]!.role));
}

function plainName(value: string) {
  return value
    .replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
}

export function createJobApply(options: {
  pool: Pool;
  ownerId: string;
  automatic?: Automatic;
  lock: (client: Query) => Promise<void>;
  startAutomatic: (client: PoolClient, start: StartWork) => Promise<string[]>;
  posting: (client: Query, id: string) => Promise<JobPosting>;
  profileName: (client: Query) => Promise<string>;
  artifacts: Pick<ArtifactService, 'retainArtifacts' | 'storeArtifact'>;
  workspace?: {
    write(threadId: string, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
    read(threadId: string, path: string, maxBytes: number): Promise<Uint8Array>;
  };
  turnWrite: <T>(
    turn: TurnRef,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  changed: () => void;
  signal?: AbortSignal;
}) {
  const { pool, ownerId } = options;
  let chain: Promise<unknown> = Promise.resolve();
  let watching = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let failing: string | undefined;

  async function pass() {
    const automatic = options.automatic;
    if (!automatic || !(automatic.ready?.() ?? true) || (await automatic.paused?.())) return [];
    return transaction(async (client) => {
      await automatic.lock(client);
      await options.lock(client);
      const started = await options.startAutomatic(client, automatic.start);
      if (started.length) afterCommit(client, options.changed);
      return started;
    }, pool);
  }

  function detect() {
    const run = chain.then(pass, pass);
    chain = run.catch(() => undefined);
    return run;
  }

  function attempt() {
    detect().then(
      () => {
        failing = undefined;
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason !== failing) logFailure('job_apply_start_failed', error);
        failing = reason;
      },
    );
  }

  function soon() {
    if (!watching || failing !== undefined || options.signal?.aborted) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      attempt();
    }, settle);
    pending.unref?.();
  }

  function watch() {
    if (watching || !options.automatic || options.signal?.aborted) return;
    watching = true;
    const timer = setInterval(() => {
      if (!options.signal?.aborted) attempt();
    }, checkEvery);
    timer.unref?.();
    options.signal?.addEventListener(
      'abort',
      () => {
        clearInterval(timer);
        if (pending) clearTimeout(pending);
      },
      { once: true },
    );
    soon();
  }

  async function writer(client: Query, turn: TurnRef, companyId: string | null) {
    if ((await rootedIn(client, ownerId, turn)) === 'owner') return;
    const chat = await applyChatOf(client, ownerId, turn);
    if (!chat || chat.companyId !== companyId)
      throw failure(
        "Only work started by an owner message, or the company's own apply chat, can save a tailored CV for its postings.",
        403,
      );
  }

  async function companyOf(client: Query, postingId: string) {
    const row = (
      await client.query<{ company_id: string | null }>(
        'SELECT company_id FROM job_postings WHERE owner_id=$1 AND id=$2',
        [ownerId, postingId],
      )
    ).rows[0];
    if (!row) throw failure('Posting not found.', 404);
    return row.company_id;
  }

  async function saveTailored(turn: TurnRef, postingId: string, signal?: AbortSignal) {
    const workspace = options.workspace;
    if (!workspace) throw failure('The workspace is unavailable.', 503);
    await writer(pool, turn, await companyOf(pool, postingId));
    const path = tailoredPath(postingId);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await workspace.read(turn.threadId, path, fileBytes));
    } catch (error) {
      throw failure(
        `Nod couldn't read /workspace/${turn.threadId}/${path}: ${error instanceof Error ? error.message : String(error)} Make the tailored PDF at that path first.`,
      );
    }
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw failure(`/workspace/${turn.threadId}/${path} is not a PDF.`);
    const before = await options.posting(pool, postingId);
    const owner = plainName(await options.profileName(pool));
    const label = plainName(before.company || before.title);
    const stored = await options.artifacts.storeArtifact(
      bytes,
      fileName(`${[owner || 'CV', label].filter(Boolean).join(' - ')}.pdf`),
      'application/pdf',
      undefined,
      undefined,
      undefined,
      true,
    );
    const saved = await options.turnWrite(
      turn,
      async (client) => {
        await options.lock(client);
        await writer(client, turn, await companyOf(client, postingId));
        const previous = (
          await client.query<{ tailored_cv_artifact_id: string | null }>(
            'SELECT tailored_cv_artifact_id FROM job_postings WHERE owner_id=$1 AND id=$2 FOR UPDATE',
            [ownerId, postingId],
          )
        ).rows[0]?.tailored_cv_artifact_id;
        await options.artifacts.retainArtifacts([stored.id], client);
        if (previous && previous !== stored.id)
          await client.query(
            `UPDATE artifacts a SET expires_at=clock_timestamp() WHERE a.owner_id=$1 AND a.id=$2 AND a.deleting_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM job_cvs c WHERE c.owner_id=$1 AND (c.artifact_id=a.id OR c.pdf_artifact_id=a.id))
               AND NOT EXISTS (SELECT 1 FROM job_postings p WHERE p.owner_id=$1 AND p.id<>$3 AND p.tailored_cv_artifact_id=a.id)`,
            [ownerId, previous, postingId],
          );
        await client.query(
          `UPDATE job_postings SET tailored_cv_artifact_id=$3,revision=revision+1,updated_at=now()
           WHERE owner_id=$1 AND id=$2`,
          [ownerId, postingId, stored.id],
        );
        return options.posting(client, postingId);
      },
      signal,
    );
    const upload = `${folder}/apply/${postingId}/${fileName(`${owner ? `${owner} ` : ''}CV.pdf`)}`;
    await workspace.write(turn.threadId, upload, bytes, signal);
    return { posting: saved, uploadFile: `/workspace/${turn.threadId}/${upload}` };
  }

  async function siteStep(
    turn: TurnRef,
    request: SiteStep,
    ask: (args: { companyId: string; site: string }) => Promise<unknown>,
  ) {
    const chat = await applyChatOf(pool, ownerId, turn);
    if (!chat) return undefined;
    const company = (
      await pool.query<{ name: string; apply_origins: string[] }>(
        'SELECT name,apply_origins FROM job_companies WHERE owner_id=$1 AND id=$2',
        [ownerId, chat.companyId],
      )
    ).rows[0];
    if (!company) return undefined;
    const site = applySite(request.page.url);
    if (!site)
      throw failure(
        `Nod can't tell from ${request.page.origin}'s address which company this page belongs to, so it enters nothing there. Open the company's own job page, whose address names the company, and try again.`,
        403,
      );
    if (company.apply_origins.includes(site)) return undefined;
    const declined = await pool.query(
      `SELECT 1 FROM approvals a JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id
       WHERE a.owner_id=$1 AND u.session_id=$2 AND a.action=$3 AND a.status='declined'
         AND a.args->>'companyId'=$4 AND a.args->>'site'=$5 LIMIT 1`,
      [ownerId, chat.sessionId, applySiteAction, chat.companyId, site],
    );
    if (declined.rowCount)
      throw failure(
        `The owner said no to applying at ${companyLabel(company.name)} on ${site}. Enter nothing on that site for this company: find the job on the company's own careers site, or stop and say why.`,
        403,
      );
    if (request.subagent) return 'refused' as const;
    return ask({ companyId: chat.companyId, site });
  }

  async function siteQuestion(raw: unknown) {
    const { companyId, site } = parse(siteInput, raw, 'The careers site');
    const name = (
      await pool.query<{ name: string }>(
        'SELECT name FROM job_companies WHERE owner_id=$1 AND id=$2',
        [ownerId, companyId],
      )
    ).rows[0]?.name;
    if (name === undefined) throw failure('Company not found.', 404);
    const company = companyLabel(name);
    return {
      question: `Apply at ${company} on \`${site}\`? Nod would enter your details and upload your CV on that site. Say yes only if it is ${company}'s own careers site.`,
      action: 'Apply on this site',
    };
  }

  async function approveSite(raw: unknown, turn: TurnRef, client: PoolClient) {
    const { companyId, site } = parse(siteInput, raw, 'The careers site');
    await options.lock(client);
    const chat = await applyChatOf(client, ownerId, turn);
    if (chat?.companyId !== companyId)
      throw Object.assign(
        failure("Only this company's own apply chat can approve a careers site for it.", 403),
        { notRun: true },
      );
    await client.query(
      `UPDATE job_companies SET apply_origins=CASE WHEN $3=ANY(apply_origins) THEN apply_origins
         ELSE array_append(apply_origins,$3) END,updated_at=now() WHERE owner_id=$1 AND id=$2`,
      [ownerId, companyId, site],
    );
    afterCommit(client, options.changed);
    return {
      approved: site,
      next: 'The owner approved this site for this company. Do the step again; it still goes through the trust check.',
    };
  }

  function handles(raw: unknown) {
    const action =
      raw && typeof raw === 'object' ? (raw as { action?: unknown }).action : undefined;
    return typeof action === 'string' && applyActions.has(action);
  }

  async function execute(turn: TurnRef, raw: unknown, signal?: AbortSignal) {
    const request = parse(toolInput, raw, 'The jobs request');
    const value = await saveTailored(turn, request.postingId, signal);
    options.changed();
    return untrustedBlock('job search records', JSON.stringify(value));
  }

  const isApplyChat = async (turn: TurnRef) => Boolean(await applyChatOf(pool, ownerId, turn));

  return {
    detect,
    soon,
    watch,
    handles,
    execute,
    isApplyChat,
    siteStep,
    siteQuestion,
    approveSite,
  };
}
