import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, join, win32 } from 'node:path';
import { finished } from 'node:stream/promises';
import { parseEnv } from 'node:util';
import { parseCredentialKey } from '../../../src/providers/environment/key-store.ts';
import { openVaultValue } from '../../../src/server/vault-crypto.ts';

export const sourceOwner = 'local-development';
export const planVersion = 1;
export const keyCheckBinding = ['nod-desktop-move-key-check-v1'];
const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Plan = {
  version: number;
  createdAt: string;
  sourceOwner: string;
  ownerId: string;
  userData: string;
  profileRoot: string;
  distribution: string;
  identity: string;
  browserNamespace: string;
  keyCheck: string;
  tables: Record<string, number>;
  archives: { workspace: boolean; browser: boolean; tools: boolean };
};

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function browserNamespace(dataRoot: string) {
  return `sk-${sha256(win32.resolve(dataRoot)).slice(0, 24)}`;
}

export function desktopProfile(userData: string) {
  if (!win32.isAbsolute(userData))
    throw new Error(
      'The desktop folder must be an absolute path, the same value you give NOD_DESKTOP_USER_DATA.',
    );
  const root = win32.resolve(win32.join(userData, 'profiles', 'local'));
  const distribution = `nod-${sha256(root.toLowerCase()).slice(0, 12)}`;
  return {
    userData,
    root,
    distribution,
    identity: distribution.slice(4),
    browserNamespace: browserNamespace(root),
  };
}

export async function profileOwner(profileRoot: string) {
  let value: { ownerId?: unknown };
  try {
    value = JSON.parse(await readFile(join(profileRoot, 'profile.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `The desktop profile has no profile.json in ${profileRoot}. Open the desktop app once with this NOD_DESKTOP_USER_DATA, let it finish starting, then quit it.`,
      );
    throw new Error(`The desktop profile.json could not be read: ${(error as Error).message}`);
  }
  if (typeof value.ownerId !== 'string' || !ownerPattern.test(value.ownerId))
    throw new Error('The desktop profile.json does not hold a valid owner ID.');
  return value.ownerId;
}

export async function readVaultKey(envPath: string) {
  let text: string;
  try {
    text = await readFile(envPath, 'utf8');
  } catch (error) {
    throw new Error(`The source .env could not be read: ${(error as NodeJS.ErrnoException).code}`);
  }
  const value = parseEnv(text).NOD_VAULT_KEY;
  if (!value) throw new Error('The source .env has no NOD_VAULT_KEY line.');
  try {
    return { key: parseCredentialKey(value), encoded: value.trim() };
  } catch (error) {
    throw new Error(`NOD_VAULT_KEY in the source .env is invalid: ${(error as Error).message}`);
  }
}

export function checkPlanKey(plan: Plan, key: Buffer) {
  try {
    openVaultValue(key, [...keyCheckBinding, plan.ownerId], plan.keyCheck);
  } catch {
    throw new Error(
      'This NOD_VAULT_KEY is not the key the conversion used. Point --env at the source install’s .env.',
    );
  }
}

export async function readPlan(staging: string) {
  let plan: Plan;
  try {
    plan = JSON.parse(await readFile(join(staging, 'plan.json'), 'utf8'));
  } catch (error) {
    throw new Error(
      `The staging folder has no readable plan.json, so the conversion did not finish: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
  if (plan.version !== planVersion)
    throw new Error(
      `The staging folder was made by another version of this move (${plan.version}).`,
    );
  const profile = desktopProfile(plan.userData);
  if (
    profile.root !== plan.profileRoot ||
    profile.distribution !== plan.distribution ||
    profile.browserNamespace !== plan.browserNamespace
  )
    throw new Error('The staging plan does not match its desktop folder. Run convert again.');
  return plan;
}

export async function appRunning(userData: string) {
  try {
    const file = await open(join(userData, 'lockfile'), 'r+');
    await file.close();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true;
    throw error;
  }
}

function decoded(bytes: Buffer) {
  const text =
    bytes.length > 1 && bytes.subarray(0, 200).includes(0)
      ? bytes.toString('utf16le')
      : bytes.toString('utf8');
  return text.replaceAll('﻿', '').replaceAll('\0', '');
}

export function run(
  command: string,
  args: string[],
  options: {
    input?: string | { file: string };
    output?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
) {
  const label = `${basename(command)} ${args.find((arg) => !arg.startsWith('-')) ?? ''}`.trim();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.kill(), options.timeoutMs);
    const writing = options.output
      ? finished(child.stdout.pipe(createWriteStream(options.output, { flags: 'wx' })))
      : Promise.resolve();
    if (!options.output) child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes > 65_536) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });
    child.stdin.on('error', () => {});
    if (typeof options.input === 'string') child.stdin.end(options.input);
    else if (options.input) {
      const source = createReadStream(options.input.file);
      source.on('error', (error) => {
        child.kill();
        reject(new Error(`${label} input could not be read: ${error.message}`));
      });
      source.pipe(child.stdin);
    } else child.stdin.end();
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      writing.then(
        () => {
          if (code === 0) return resolve(decoded(Buffer.concat(stdout)).trim());
          const reason = decoded(Buffer.concat(stderr)).trim().slice(-2000);
          reject(
            new Error(
              `${label} failed (${signal ? `signal ${signal}` : `exit ${code}`})${reason ? `: ${reason}` : '.'}`,
            ),
          );
        },
        (error: Error) => reject(new Error(`${label} output could not be saved: ${error.message}`)),
      );
    });
  });
}
