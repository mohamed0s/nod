import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { create } from 'tar';
import {
  appRunning,
  desktopNames,
  desktopProfile,
  distributions,
  type Docker,
  dumpDatabase,
  electronEnvironment,
  electronPath,
  inVolume,
  privateComputer,
  profileOwner,
  protectFolder,
  run,
  withDatabase,
} from './desktop-move/shared.ts';

const desktopDirectory = fileURLToPath(new URL('../../desktop', import.meta.url));

const profileEntries = [
  'sessions',
  'pi',
  'objects',
  'artifacts',
  'integration-identity',
  'settings.json',
  'profile.json',
  'preferences.json',
  'chat-read-cursors.json',
  'desktop-move-import.json',
];

const backupReadme = `Nod desktop app backup

database.dump   The desktop database (pg_dump, custom format).
profile.tgz     Profile files: Pi sessions and settings, attachments, memory imports,
                the app identity, settings.json, profile.json and preferences.
volume-*.tgz    The private computer's workspace files, installed tools and browser sign-ins.
backup.log      What this backup did.

Keep this folder private. It holds your chats, files and browser sign-ins.

The Vault key in settings.json is protected by this Windows user, so only this
Windows user on this PC can open it. If you saved your own copy of the key (the
NOD_VAULT_KEY from a source install), it unlocks the saved logins too. Never
print that key, paste it into a chat or store it in this folder.
`;

const volumeArchive =
  'tar --warning=no-file-changed --warning=no-file-removed -czf - -C /target . || [ $? -eq 1 ]';

function electronInstance(userData: string, args: string[]) {
  return {
    command: electronPath(),
    args: [desktopDirectory, ...args],
    env: electronEnvironment({ NOD_DESKTOP_USER_DATA: userData }),
  };
}

async function show(userData: string) {
  if (!(await appRunning(userData))) return 'Nod is not running.';
  const instance = electronInstance(userData, []);
  spawn(instance.command, instance.args, {
    env: instance.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  return 'Asked Nod to show its window.';
}

async function quit(userData: string, waitSeconds: number) {
  if (!(await appRunning(userData))) return { stopped: true, message: 'Nod is not running.' };
  const instance = electronInstance(userData, ['--quit']);
  await run(instance.command, instance.args, {
    env: instance.env,
    timeoutMs: 60_000,
    label: 'Asking Nod to quit',
  });
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (!(await appRunning(userData)))
      return {
        stopped: true,
        message: 'Nod has quit. Start it again with the Nod shortcut or by signing in to Windows.',
      };
    await new Promise((done) => setTimeout(done, 1000));
  }
  return {
    stopped: false,
    message: `Nod is still closing after ${waitSeconds} seconds. If it shows a question, answer it. Otherwise choose Quit Nod from its icon at the right of the taskbar.`,
  };
}

async function containerStates(docker: Docker, names: string[]) {
  let lines: string[];
  try {
    lines = (
      await docker(['inspect', '--format', '{{.Name}}|{{.Image}}|{{.State.Running}}', ...names], {
        label: 'Checking the desktop containers',
      })
    ).split(/\r?\n/);
  } catch (error) {
    throw new Error(
      `The desktop app's containers are missing. Open Nod once with this folder and let it finish starting. ${(error as Error).message}`,
    );
  }
  return new Map(
    lines.map((line) => {
      const [name = '', image = '', running = ''] = line.split('|');
      return [name.replace(/^\//, ''), { image, running: running === 'true' }];
    }),
  );
}

async function backup(userData: string, out: string, log: (line: string) => void) {
  const profile = desktopProfile(userData);
  await profileOwner(profile.root);
  await mkdir(out, { recursive: true });
  await protectFolder(out);
  if (!(await distributions(false)).includes(profile.distribution))
    throw new Error(
      `The desktop app's private computer ${profile.distribution} is missing, so there is nothing to back up.`,
    );
  const open = await appRunning(userData);
  const guestRunning = (await distributions(true)).includes(profile.distribution);
  if (open && !guestRunning)
    throw new Error(
      'Nod is open, but its private computer is not running. Back up again once Nod has finished starting.',
    );
  const computer = privateComputer(profile.distribution, profile.identity);
  const { containers, volumes } = desktopNames(profile.identity);
  const failures: string[] = [];
  try {
    if (!open) {
      log('Nod is closed, so the backup starts its private computer.');
      await computer.start();
    }
    const states = await containerStates(computer.docker, [
      containers.postgres,
      containers.workspace,
    ]);
    const postgres = states.get(containers.postgres);
    const image = states.get(containers.workspace)?.image;
    if (!postgres || !image) throw new Error('The desktop containers could not be read.');
    const dump = join(out, 'database.dump');
    const save = () =>
      dumpDatabase(computer.docker, containers.postgres, dump, 'Saving the desktop database');
    if (postgres.running) await save();
    else if (open)
      throw new Error(
        "Nod's database is not running. Back up again once Nod has finished starting.",
      );
    else await withDatabase(computer.docker, containers.postgres, save, () => appRunning(userData));
    log('Saved the database.');

    for (const [name, volume] of [
      ['workspace', volumes.workspace],
      ['tools', volumes.tools],
      ['browser', volumes.browser],
    ] as const) {
      try {
        await inVolume(computer.docker, {
          image,
          volume,
          readOnly: true,
          script: volumeArchive,
          label: `Saving the ${name} volume`,
          output: join(out, `volume-${name}.tgz`),
          timeoutMs: 3_600_000,
        });
        log(`Saved the ${name} volume.`);
      } catch (error) {
        failures.push(`the ${name} volume`);
        log(`Could not save the ${name} volume: ${(error as Error).message}`);
      }
    }
  } finally {
    if (!guestRunning && !(await appRunning(userData)))
      await computer.stop().catch((error: Error) => log(error.message));
  }

  const present: string[] = [];
  for (const name of profileEntries)
    if (await stat(join(profile.root, name)).catch(() => undefined)) present.push(name);
  try {
    await create(
      { cwd: profile.root, file: join(out, 'profile.tgz'), gzip: true, portable: true },
      present,
    );
    log(`Saved the profile files (${present.join(', ')}).`);
  } catch (error) {
    failures.push('the profile files');
    log(`Could not save the profile files: ${(error as Error).message}`);
  }
  await writeFile(join(out, 'README.txt'), backupReadme.replaceAll('\n', '\r\n'));
  if (failures.length) throw new Error(`The backup is missing ${failures.join(', ')}.`);
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'user-data': { type: 'string' },
      out: { type: 'string' },
      wait: { type: 'string', default: '180' },
    },
  });
  const [command] = positionals;
  const userData = values['user-data'];
  const wait = Number(values.wait);
  if (
    !userData ||
    !['running', 'show', 'quit', 'backup'].includes(command ?? '') ||
    (command === 'backup' && !values.out) ||
    !Number.isInteger(wait) ||
    wait < 1
  ) {
    console.error(
      'Usage: desktop-app.ts running|show|quit|backup --user-data <folder> [--out <backup folder>] [--wait <seconds>]',
    );
    process.exit(2);
  }
  try {
    desktopProfile(userData);
    if (command === 'running') console.log((await appRunning(userData)) ? 'running' : 'stopped');
    else if (command === 'show') console.log(await show(userData));
    else if (command === 'quit') {
      const result = await quit(userData, wait);
      console.log(result.message);
      if (!result.stopped) process.exit(1);
    } else await backup(userData, values.out!, (line) => console.log(line));
  } catch (error) {
    console.error(
      command === 'backup'
        ? `Backup failed: ${(error as Error).message}`
        : (error as Error).message,
    );
    process.exit(1);
  }
}
