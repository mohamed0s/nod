import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appRunning, checkPlanKey, readPlan, readVaultKey } from './shared.ts';

const helper = fileURLToPath(new URL('vault-key-electron.mjs', import.meta.url));

function electronPath(given?: string) {
  if (given) return given;
  const desktop = fileURLToPath(new URL('../../../desktop/package.json', import.meta.url));
  try {
    return createRequire(desktop)('electron') as string;
  } catch (error) {
    throw new Error(
      `Electron is not installed in desktop/node_modules. Run pnpm --dir desktop install first. ${(error as Error).message}`,
    );
  }
}

function runElectron(electron: string, args: string[]) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(electron, [helper, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', (error) => reject(new Error(`Electron could not start: ${error.message}`)));
    child.on('close', (code) => {
      const text = Buffer.concat(output).toString().trim();
      if (text) console.log(text);
      if (code === 0) return resolve();
      const reason = Buffer.concat(errors)
        .toString()
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith('['))
        .join('\n')
        .slice(-2000);
      reject(new Error(reason || `Electron exited with code ${code}.`));
    });
  });
}

export async function setVaultKey(options: { staging: string; env: string; electron?: string }) {
  const plan = await readPlan(options.staging);
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
  await runElectron(electron, ['set', ...args]);
  await runElectron(electron, ['verify', ...args]);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      staging: { type: 'string' },
      env: { type: 'string' },
      electron: { type: 'string' },
    },
  });
  if (!values.staging || !values.env) {
    console.error(
      'Usage: vault-key.ts --staging <folder from convert> --env <nod\\.env> [--electron <electron.exe>]',
    );
    process.exit(2);
  }
  try {
    await setVaultKey({ staging: values.staging, env: values.env, electron: values.electron });
  } catch (error) {
    console.error(`Vault key step failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
