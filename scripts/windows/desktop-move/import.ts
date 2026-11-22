import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  appRunning,
  type Plan,
  profileOwner,
  readPlan,
  run,
  sha256,
  stagedFiles,
} from './shared.ts';
import { setVaultKey } from './vault-key.ts';

export type Docker = (
  args: string[],
  options: Parameters<typeof run>[2] & { label: string },
) => Promise<string>;

export const importMarker = 'desktop-move-import.json';

export const restoreScript = [
  'set -eo pipefail',
  'trap \'rm -f "$3"\' EXIT',
  '{ printf "BEGIN;\\nDROP SCHEMA IF EXISTS pgboss CASCADE;\\nDROP SCHEMA IF EXISTS public CASCADE;\\nCREATE SCHEMA public;\\n"; pg_restore --no-owner --no-acl -f -; cat "$3"; printf "COMMIT;\\n"; } | psql -X -q -v ON_ERROR_STOP=1 -U "$1" -d "$2"',
].join('\n');

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function countCheck(tables: Record<string, number>) {
  const rows = Object.entries(tables).map(([name, count]) => {
    const dot = name.indexOf('.');
    return `(${literal(name.slice(0, dot))}, ${literal(name.slice(dot + 1))}, ${Number(count)}::bigint)`;
  });
  if (!rows.length) return '';
  return `DO $nod_move$
DECLARE
  wrong text := '';
  found bigint;
  item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES ${rows.join(', ')}) AS expected(schema_name, table_name, rows) LOOP
    IF to_regclass(format('%I.%I', item.schema_name, item.table_name)) IS NULL THEN
      wrong := wrong || format('%s.%s is missing; ', item.schema_name, item.table_name);
    ELSE
      EXECUTE format('SELECT count(*) FROM %I.%I', item.schema_name, item.table_name) INTO found;
      IF found <> item.rows THEN
        wrong := wrong || format('%s.%s expected %s, found %s; ', item.schema_name, item.table_name, item.rows, found);
      END IF;
    END IF;
  END LOOP;
  IF wrong <> '' THEN
    RAISE EXCEPTION 'The restored database does not match the conversion: %', wrong;
  END IF;
END
$nod_move$;
`;
}

export async function restoreDatabase(options: {
  docker: Docker;
  container: string;
  dump: string;
  tables: Record<string, number>;
  user?: string;
  database?: string;
}) {
  const { docker, container } = options;
  const check = `/tmp/nod-move-check-${randomBytes(6).toString('hex')}.sql`;
  await docker(['exec', '-i', container, 'sh', '-c', 'cat > "$1"', 'sh', check], {
    input: countCheck(options.tables),
    label: 'Preparing the database check',
  });
  await docker(
    [
      'exec',
      '-i',
      container,
      'sh',
      '-c',
      restoreScript,
      'sh',
      options.user ?? 'nod',
      options.database ?? 'nod',
      check,
    ],
    { input: { file: options.dump }, label: 'Replacing the desktop database' },
  );
}

export function desktopNames(identity: string) {
  if (!/^[a-f0-9]{12}$/.test(identity)) throw new Error('The desktop identity is invalid.');
  return {
    containers: {
      postgres: `nod-postgres-${identity}`,
      workspace: `nod-workspace-${identity}`,
      browser: `nod-browser-${identity}`,
    },
    volumes: {
      postgres: `nod-postgres-${identity}`,
      workspace: `nod-workspace-${identity}`,
      browser: `nod-browser-${identity}`,
      tools: `nod-tools-${identity}`,
    },
  };
}

async function withDatabase<T>(docker: Docker, container: string, work: () => Promise<T>) {
  await docker(['start', container], { label: 'Starting the desktop database' });
  let failed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await docker(['exec', container, 'pg_isready', '-U', 'nod', '-d', 'nod'], {
          label: 'Waiting for the desktop database',
        });
        break;
      } catch (error) {
        if (attempt > 60) throw error;
        await new Promise((done) => setTimeout(done, 1000));
      }
    }
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await docker(['stop', container], { label: 'Stopping the desktop database' });
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

export async function importData(options: {
  plan: Plan;
  staging: string;
  backup: string;
  docker: Docker;
  log?: (line: string) => void;
}) {
  const { plan, staging, backup, docker } = options;
  const log = options.log ?? console.log;
  const { containers, volumes } = desktopNames(plan.identity);
  if (!/^sk-[a-f0-9]{24}$/.test(plan.browserNamespace))
    throw new Error('The browser folder name in the plan is invalid.');
  let states: string[];
  try {
    states = (
      await docker(
        [
          'inspect',
          '--format',
          '{{.Name}}|{{.Image}}|{{.State.Running}}',
          ...Object.values(containers),
        ],
        { label: 'Checking the desktop containers' },
      )
    ).split(/\r?\n/);
  } catch (error) {
    throw new Error(
      `The desktop app’s containers are missing. Open Nod once with this profile, let it finish starting, then quit it. ${(error as Error).message}`,
    );
  }
  const running = states.filter((line) => line.endsWith('|true'));
  if (running.length)
    throw new Error(
      `Quit Nod first: ${running.map((line) => line.split('|')[0]).join(', ')} is running.`,
    );
  const image = states.find((line) => line.startsWith(`/${containers.workspace}|`))?.split('|')[1];
  if (!image) throw new Error('The desktop workspace container has no image.');
  await docker(['volume', 'inspect', '--format', '{{.Name}}', ...Object.values(volumes)], {
    label: 'Checking the desktop data volumes',
  });
  await mkdir(backup, { recursive: true });

  await withDatabase(docker, containers.postgres, async () => {
    log('Saving the current desktop database…');
    await docker(
      ['exec', containers.postgres, 'pg_dump', '--format=custom', '-U', 'nod', '-d', 'nod'],
      {
        output: join(backup, 'database.dump'),
        label: 'Saving the current desktop database',
      },
    );
    log('Replacing the desktop database…');
    await restoreDatabase({
      docker,
      container: containers.postgres,
      dump: join(staging, 'database.dump'),
      tables: plan.tables,
    });
  });

  const inVolume = (volume: string, script: string, label: string, io: Parameters<typeof run>[2]) =>
    docker(
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--user',
        '0:0',
        '--mount',
        `type=volume,source=${volume},target=/target`,
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        script,
      ],
      { ...io, label },
    );
  const steps = [
    { archive: 'workspace', volume: volumes.workspace, folder: '.', name: 'workspace files' },
    { archive: 'tools', volume: volumes.tools, folder: '.', name: 'installed tools' },
    {
      archive: 'browser',
      volume: volumes.browser,
      folder: plan.browserNamespace,
      name: 'browser sign-ins',
    },
  ] as const;
  for (const step of steps) {
    if (!plan.archives[step.archive]) continue;
    log(`Copying ${step.name}…`);
    await inVolume(
      step.volume,
      `if [ -e /target/${step.folder} ]; then tar -c -f - -C /target ${step.folder}; fi`,
      `Saving the current desktop ${step.name}`,
      { output: join(backup, `${step.archive}.tar`) },
    );
    await inVolume(
      step.volume,
      `${step.folder === '.' ? '' : `rm -rf /target/${step.folder} && `}tar -x -f - -C /target --no-same-owner && chown -R 1000:1000 /target/${step.folder}`,
      `Copying ${step.name}`,
      { input: { file: join(staging, `${step.archive}.tar`) } },
    );
  }
}

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}

export async function copyProfile(options: {
  staging: string;
  profileRoot: string;
  backup: string;
  ownerId: string;
}) {
  const staged = join(options.staging, 'profile');
  const aside = join(options.backup, 'profile');
  for (const path of await files(staged)) {
    const target = join(options.profileRoot, relative(staged, path));
    if (!(await stat(target).catch(() => undefined))) continue;
    await mkdir(dirname(join(aside, relative(staged, path))), { recursive: true });
    await cp(target, join(aside, relative(staged, path)), { preserveTimestamps: true });
  }
  const identity = join('integration-identity', sha256(options.ownerId));
  let removed = 0;
  if (!(await stat(join(staged, `${identity}.encrypted`)).catch(() => undefined)))
    for (const extension of ['encrypted', 'public']) {
      const current = join(options.profileRoot, `${identity}.${extension}`);
      if (!(await stat(current).catch(() => undefined))) continue;
      await mkdir(join(aside, 'integration-identity'), { recursive: true });
      await cp(current, join(aside, `${identity}.${extension}`), { preserveTimestamps: true });
      await rm(current);
      removed++;
    }
  await cp(staged, options.profileRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  return { removed };
}

function wsl() {
  if (!process.env.SYSTEMROOT) throw new Error('This step runs on Windows only.');
  return join(process.env.SYSTEMROOT, 'System32', 'wsl.exe');
}

async function distributions(running: boolean) {
  return (
    await run(wsl(), ['--list', '--quiet', ...(running ? ['--running'] : [])], {
      label: running ? 'Listing running WSL distributions' : 'Listing WSL distributions',
    }).catch((error: Error) => {
      if (running && /no running distributions/i.test(error.message)) return '';
      throw error;
    })
  )
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export async function checkDesktop(plan: Plan, staging: string) {
  if ((await profileOwner(plan.profileRoot)) !== plan.ownerId)
    throw new Error('The desktop profile changed since the conversion. Run convert again.');
  const sizes = await stagedFiles(plan, staging);
  if (await appRunning(plan.userData)) throw new Error('Quit Nod first, then run this again.');
  if (!(await distributions(false)).includes(plan.distribution))
    throw new Error(
      `The desktop app’s private computer ${plan.distribution} is missing. Open Nod once with this profile, let it finish starting, then quit it.`,
    );
  let saved: { distribution?: string };
  try {
    saved = JSON.parse(
      await readFile(join(plan.profileRoot, 'desktop-runtime', 'state.json'), 'utf8'),
    );
  } catch (error) {
    throw new Error(
      `The desktop runtime state could not be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
  if (saved.distribution !== plan.distribution)
    throw new Error('The desktop runtime belongs to another private computer. Run convert again.');
  if ((await distributions(true)).includes(plan.distribution))
    throw new Error(
      `${plan.distribution} is still running. Quit Nod; if it is already closed, run wsl --terminate ${plan.distribution}.`,
    );
  return sizes;
}

async function previousImport(profileRoot: string) {
  try {
    return JSON.parse(await readFile(join(profileRoot, importMarker), 'utf8')) as {
      importedAt?: string;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      staging: { type: 'string' },
      env: { type: 'string' },
      electron: { type: 'string' },
      'dry-run': { type: 'boolean' },
      again: { type: 'boolean' },
    },
  });
  if (!values.staging || !values.env) {
    console.error(
      'Usage: import.ts --staging <folder from convert> --env <nod\\.env> [--dry-run] [--again] [--electron <electron.exe>]',
    );
    process.exit(2);
  }
  let keyChanged = false;
  try {
    const staging = values.staging;
    const plan = await readPlan(staging);
    const sizes = await checkDesktop(plan, staging);
    const earlier = await previousImport(plan.profileRoot);
    if (earlier && !values.again)
      throw new Error(
        `This desktop profile already received an import on ${earlier.importedAt ?? 'an earlier run'}. Importing again replaces everything Nod did since. If you mean that, run this again with --again; the current desktop data is saved in the staging folder first.`,
      );
    const { containers, volumes } = desktopNames(plan.identity);
    const backup = join(staging, `before-import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    console.log(
      [
        `Profile: ${plan.profileRoot} (owner ${plan.ownerId})`,
        `Private computer: ${plan.distribution}`,
        'Vault key: the desktop profile switches to the source key, its old settings kept as settings.json.before-move',
        `Backup of the current desktop data: ${backup}`,
        `Database: replace everything in ${containers.postgres} with database.dump (${sizes['database.dump']} bytes), checking ${Object.keys(plan.tables).length} table counts before committing`,
        ...(plan.archives.workspace ? [`Workspace: workspace.tar into ${volumes.workspace}`] : []),
        ...(plan.archives.tools ? [`Tools: tools.tar into ${volumes.tools}`] : []),
        ...(plan.archives.browser
          ? [`Browser: browser.tar into ${volumes.browser}/${plan.browserNamespace}`]
          : []),
        `Files: ${join(staging, 'profile')} into ${plan.profileRoot}`,
      ].join('\n'),
    );
    if (values['dry-run']) {
      console.log('Dry run: nothing changed.');
      process.exit(0);
    }
    console.log('Giving the desktop profile the source Vault key…');
    for (const line of await setVaultKey({ staging, env: values.env, electron: values.electron }))
      if (line) console.log(line);
    keyChanged = true;
    const guest = ['--distribution', plan.distribution, '--user', 'root', '--exec'];
    console.log('Starting the private computer…');
    await run(
      wsl(),
      [...guest, '/usr/bin/python3', '/usr/local/lib/nod/windows-guest.py', 'start'],
      {
        input: JSON.stringify({ identity: plan.identity }),
        timeoutMs: 900_000,
        label: 'Starting the private computer',
      },
    );
    try {
      await importData({
        plan,
        staging,
        backup,
        docker: (args, options) =>
          run(wsl(), [...guest, '/usr/local/bin/docker', ...args], {
            ...options,
            label: `${options.label} (docker ${args[0]})`,
          }),
      });
      console.log('Copying profile files…');
      const { removed } = await copyProfile({
        staging,
        profileRoot: plan.profileRoot,
        backup,
        ownerId: plan.ownerId,
      });
      if (removed)
        console.log('Moved the desktop’s own app identity aside; Nod makes a new one on start.');
      await writeFile(
        join(plan.profileRoot, importMarker),
        `${JSON.stringify({ importedAt: new Date().toISOString(), conversion: plan.createdAt, backup }, null, 2)}\n`,
      );
    } finally {
      await run(wsl(), ['--terminate', plan.distribution], {
        label: 'Stopping the private computer',
      }).catch((error: Error) => console.error(error.message));
    }
    console.log('Done. Open Nod with the same NOD_DESKTOP_USER_DATA.');
  } catch (error) {
    console.error(`Import failed: ${(error as Error).message}`);
    if (keyChanged)
      console.error(
        'The desktop profile already uses the source Vault key, so it won’t open its old data. Run import again to finish, or copy settings.json.before-move over settings.json in the profile to undo the key change.',
      );
    process.exit(1);
  }
}
