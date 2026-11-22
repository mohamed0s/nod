import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

if (process.type !== 'browser') {
  process.stderr.write(
    'This helper must run as the Electron app, not as Node. ELECTRON_RUN_AS_NODE is set in this terminal; run it through import.ts, which clears it.\n',
  );
  process.exit(1);
}

const { app, safeStorage } = await import('electron');

function fail(message) {
  process.stderr.write(`${message}\n`);
  app.exit(1);
}
process.on('uncaughtException', (error) => fail(error.message));
process.on('unhandledRejection', (error) => fail(error?.message ?? String(error)));
setTimeout(
  () => fail('The Electron key helper stopped after 60 seconds without finishing.'),
  60_000,
);

const { values, positionals } = parseArgs({
  options: {
    staging: { type: 'string' },
    env: { type: 'string' },
    'user-data': { type: 'string' },
    'user-data-dir': { type: 'string' },
  },
  allowPositionals: true,
});
const mode = positionals[0];
const userData = values['user-data'];
if (!['set', 'verify'].includes(mode) || !values.staging || !values.env || !userData)
  fail(
    'Usage: vault-key-electron.mjs set|verify --staging <folder> --env <.env> --user-data <desktop folder>',
  );
else if (!isAbsolute(userData)) fail('The desktop folder must be an absolute path.');
else {
  app.setPath('userData', userData);
  app.setName('Nod');
  app.disableHardwareAcceleration();
  start().catch((error) => fail(error.message));
}

async function write(path, text) {
  const temporary = `${path}.${randomUUID()}.pending`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function start() {
  const { appRunning, checkPlanKey, readPlan, readVaultKey } = await import('./shared.ts');
  const { createSettingsStore } = await import('../../../desktop/main/settings.mjs');
  const plan = await readPlan(values.staging);
  if (plan.userData !== userData)
    throw new Error('The desktop folder does not match the staging plan.');
  if (await appRunning(userData)) throw new Error('Quit Nod first, then run this again.');
  if (!app.requestSingleInstanceLock()) throw new Error('Quit Nod first, then run this again.');
  await app.whenReady();
  const profileRoot = join(app.getPath('userData'), 'profiles', 'local');
  if (profileRoot !== plan.profileRoot)
    throw new Error(
      `Electron places this profile at ${profileRoot}, but the conversion used ${plan.profileRoot}. Run convert again with --user-data set to the same text as NOD_DESKTOP_USER_DATA.`,
    );
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Windows encryption (DPAPI) is unavailable for this profile.');
  const { key, encoded } = await readVaultKey(values.env);
  checkPlanKey(plan, key);
  const path = join(plan.profileRoot, 'settings.json');
  await createSettingsStore(path, safeStorage).get();
  if (mode === 'verify') {
    const { NOD_VAULT_KEY } = await createSettingsStore(path, safeStorage).environment();
    if (NOD_VAULT_KEY !== encoded)
      throw new Error('The desktop profile does not unlock to the source Vault key.');
    process.stdout.write('The desktop profile now unlocks with the source Vault key.\n');
    return app.quit();
  }
  const original = await readFile(path, 'utf8');
  const value = JSON.parse(original);
  if (value.secrets.vaultKey) {
    let current;
    try {
      current = safeStorage.decryptString(Buffer.from(value.secrets.vaultKey, 'base64'));
    } catch (error) {
      throw new Error(
        `The desktop profile’s saved Vault key does not open with the Windows key in ${join(userData, 'Local State')} (${error.message}). This helper isn’t using the same key store as Nod, so nothing was changed. Check that NOD_DESKTOP_USER_DATA is ${userData} and that you are signed in as the Windows user who set up the desktop app.`,
      );
    }
    if (current === encoded) {
      process.stdout.write('The desktop profile already uses the source Vault key.\n');
      return app.quit();
    }
  }
  await copyFile(path, `${path}.before-move`, constants.COPYFILE_EXCL).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await write(
    path,
    JSON.stringify({
      ...value,
      secrets: {
        ...value.secrets,
        vaultKey: safeStorage.encryptString(encoded).toString('base64'),
      },
    }),
  );
  let saved;
  try {
    saved = (await createSettingsStore(path, safeStorage).environment()).NOD_VAULT_KEY;
  } catch {}
  if (saved !== encoded) {
    await write(path, original);
    throw new Error('The new desktop key did not read back, so the old settings were restored.');
  }
  process.stdout.write('Saved the source Vault key in the desktop profile.\n');
  return app.quit();
}
