import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { JobPosting } from '../shared/job-postings.ts';
import { fileBytes, fileName } from '../shared/files.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import type { ArtifactService } from './artifacts.ts';
import { logFailure } from './failure-log.ts';
import type { StartWork } from './job-companies.ts';
import { applyChatOf, failure, parse, rootedIn, type Query, type TurnRef } from './jobs-shared.ts';
import { afterCommit, transaction } from './transaction.ts';

export const jobApplyTables = `
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS tailored_cv_artifact_id uuid;
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS applied_at timestamptz;
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS application_ref text NOT NULL DEFAULT '';
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS apply_session_id uuid;
  ALTER TABLE job_companies ADD COLUMN IF NOT EXISTS apply_by text CHECK (apply_by IN ('owner','rule'));
  UPDATE job_companies SET apply_by='owner' WHERE apply_by IS NULL AND apply_session_id IS NOT NULL;
`;

export const applyActions = new Set(['cv_tailored']);

export type Automatic = {
  start: StartWork;
  lock: (client: PoolClient) => Promise<unknown>;
  ready?: () => boolean;
};

const folder = 'shared/career-ops';
const tailoredPath = (postingId: string) => `${folder}/output/tailored-${postingId}.pdf`;
const checkEvery = 10 * 60_000;
const settle = 3_000;
const toolInput = z.object({ action: z.literal('cv_tailored'), postingId: z.uuid() }).strict();

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

  async function pass() {
    const automatic = options.automatic;
    if (!automatic || !(automatic.ready?.() ?? true)) return [];
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

  function soon() {
    if (!watching || options.signal?.aborted) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      detect().catch((error: unknown) => logFailure('job_apply_start_failed', error));
    }, settle);
    pending.unref?.();
  }

  function watch() {
    if (watching || !options.automatic || options.signal?.aborted) return;
    watching = true;
    const timer = setInterval(soon, checkEvery);
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

  return { detect, soon, watch, handles, execute };
}
