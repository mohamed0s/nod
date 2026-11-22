import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appRunning,
  checkPlanKey,
  electronEnvironment,
  electronPath,
  readPlan,
  readVaultKey,
  stagedFiles,
} from './shared.ts';

const helper = fileURLToPath(new URL('vault-key-electron.mjs', import.meta.url));
const electronTimeoutMs = 90_000;

export function runElectron(electron: string, args: string[], timeoutMs = electronTimeoutMs) {
  const env = electronEnvironment();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [helper, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Electron could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(output).toString().trim();
      if (timedOut)
        return reject(
          new Error(
            `The Electron key helper did not finish within ${timeoutMs / 1000} seconds and was stopped. The desktop settings were not changed unless it said so above.${text ? ` Output: ${text}` : ''}`,
          ),
        );
      if (code === 0) return resolve(text);
      const reason = Buffer.concat(errors)
        .toString()
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith('['))
        .join('\n')
        .slice(-2000);
      reject(new Error(reason || `The Electron key helper exited with code ${code}.`));
    });
  });
}

export async function setVaultKey(options: { staging: string; env: string; electron?: string }) {
  const plan = await readPlan(options.staging);
  await stagedFiles(plan, options.staging);
  const { key } = await readVaultKey(options.env);
  checkPlanKey(plan, key);
  if (await appRunning(plan.userData)) throw new Error('Quit Nod first, then run this again.');
  for (const path of [join(plan.userData, 'Local State'), join(plan.profileRoot, 'settings.json')])
    await stat(path).catch(() => {
      throw new Error(
        `${path} is missing. Open Nod once with this NOD_DESKTOP_USER_DATA, let it finish starting, then quit it.`,
      );
    });
  const electron = electronPath(options.electron);
  const args = [
    `--user-data-dir=${plan.userData}`,
    '--user-data',
    plan.userData,
    '--staging',
    options.staging,
    '--env',
    options.env,
  ];
  return [
    await runElectron(electron, ['set', ...args]),
    await runElectron(electron, ['verify', ...args]),
  ];
}
