import { cp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appRunning, type Plan, profileOwner, readPlan, run } from './shared.ts';

type Docker = (args: string[], options?: Parameters<typeof run>[2]) => Promise<string>;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const restoreScript = [
  'set -eo pipefail',
  '{ printf "BEGIN;\\nDROP SCHEMA IF EXISTS pgboss CASCADE;\\nDROP SCHEMA IF EXISTS public CASCADE;\\nCREATE SCHEMA public;\\n"; pg_restore --no-owner --no-acl -f -; printf "COMMIT;\\n"; } | psql -X -q -v ON_ERROR_STOP=1 -U nod -d nod',
].join('\n');

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

export function countQuery(tables: Record<string, number>) {
  return `${Object.keys(tables)
    .map((name) => {
      const [schema, ...rest] = name.split('.');
      return `SELECT '${name.replaceAll("'", "''")}', count(*) FROM ${quote(schema!)}.${quote(rest.join('.'))}`;
    })
    .join('\nUNION ALL\n')};\n`;
}

export async function importData(options: {
  plan: Plan;
  staging: string;
  docker: Docker;
  log?: (line: string) => void;
}) {
  const { plan, staging, docker } = options;
  const log = options.log ?? console.log;
  const { containers, volumes } = desktopNames(plan.identity);
  if (!/^sk-[a-f0-9]{24}$/.test(plan.browserNamespace))
    throw new Error('The browser folder name in the plan is invalid.');
  let states: string[];
  try {
    states = (
      await docker([
        'inspect',
        '--format',
        '{{.Name}}|{{.Image}}|{{.State.Running}}',
        ...Object.values(containers),
      ])
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
  try {
    await docker(['volume', 'inspect', '--format', '{{.Name}}', ...Object.values(volumes)]);
  } catch (error) {
    throw new Error(`The desktop app’s data volumes are missing. ${(error as Error).message}`);
  }

  log('Restoring the database…');
  await docker(['start', containers.postgres]);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await docker(['exec', containers.postgres, 'pg_isready', '-U', 'nod', '-d', 'nod']);
        break;
      } catch (error) {
        if (attempt > 60)
          throw new Error(`The desktop database did not start: ${(error as Error).message}`);
        await new Promise((done) => setTimeout(done, 1000));
      }
    }
    await docker(['exec', '-i', containers.postgres, 'sh', '-c', restoreScript], {
      input: { file: join(staging, 'database.dump') },
    });
    const found = new Map(
      (
        await docker(
          [
            'exec',
            '-i',
            containers.postgres,
            'psql',
            '-X',
            '-A',
            '-t',
            '-F',
            '\t',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            'nod',
            '-d',
            'nod',
            '-f',
            '-',
          ],
          { input: countQuery(plan.tables) },
        )
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name, count] = line.split('\t');
          return [name, Number(count)] as const;
        }),
    );
    const wrong = Object.entries(plan.tables).filter(([name, count]) => found.get(name) !== count);
    if (wrong.length)
      throw new Error(
        `The restored database does not match the conversion: ${wrong
          .map(([name, count]) => `${name} expected ${count}, found ${found.get(name) ?? 'none'}`)
          .join('; ')}`,
      );
  } finally {
    await docker(['stop', containers.postgres]);
  }

  const extract = (volume: string, script: string, archive: string) =>
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
      { input: { file: join(staging, archive) } },
    );
  if (plan.archives.workspace) {
    log('Copying workspace files…');
    await extract(
      volumes.workspace,
      'tar -x -f - -C /target --no-same-owner && chown -R 1000:1000 /target',
      'workspace.tar',
    );
  }
  if (plan.archives.tools) {
    log('Copying installed tools…');
    await extract(
      volumes.tools,
      'tar -x -f - -C /target --no-same-owner && chown -R 1000:1000 /target',
      'tools.tar',
    );
  }
  if (plan.archives.browser) {
    log('Copying browser sign-ins…');
    await extract(
      volumes.browser,
      `rm -rf /target/${plan.browserNamespace} && tar -x -f - -C /target --no-same-owner && chown -R 1000:1000 /target/${plan.browserNamespace}`,
      'browser.tar',
    );
  }
}

export async function copyProfile(staging: string, profileRoot: string) {
  await cp(join(staging, 'profile'), profileRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function wsl() {
  if (!process.env.SYSTEMROOT) throw new Error('This step runs on Windows only.');
  return join(process.env.SYSTEMROOT, 'System32', 'wsl.exe');
}

async function distributions(running: boolean) {
  return (
    await run(wsl(), ['--list', '--quiet', ...(running ? ['--running'] : [])]).catch(() => '')
  )
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export async function checkDesktop(plan: Plan, staging: string) {
  if ((await profileOwner(plan.profileRoot)) !== plan.ownerId)
    throw new Error('The desktop profile changed since the conversion. Run convert again.');
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
  const sizes: Record<string, number> = {};
  for (const name of [
    'database.dump',
    ...Object.entries(plan.archives)
      .filter(([, made]) => made)
      .map(([archive]) => `${archive}.tar`),
  ])
    sizes[name] = await stat(join(staging, name)).then(
      (file) => file.size,
      () => {
        throw new Error(`The staging folder is missing ${name}. Run convert again.`);
      },
    );
  return sizes;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { staging: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });
  if (!values.staging) {
    console.error('Usage: import.ts --staging <folder from convert> [--dry-run]');
    process.exit(2);
  }
  try {
    const staging = values.staging;
    const plan = await readPlan(staging);
    const sizes = await checkDesktop(plan, staging);
    const { containers, volumes } = desktopNames(plan.identity);
    console.log(
      [
        `Profile: ${plan.profileRoot} (owner ${plan.ownerId})`,
        `Private computer: ${plan.distribution}`,
        `Database: replace everything in ${containers.postgres} with database.dump (${sizes['database.dump']} bytes), then check ${Object.keys(plan.tables).length} table counts`,
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
    const guest = ['--distribution', plan.distribution, '--user', 'root', '--exec'];
    console.log('Starting the private computer…');
    await run(
      wsl(),
      [...guest, '/usr/bin/python3', '/usr/local/lib/nod/windows-guest.py', 'start'],
      { input: JSON.stringify({ identity: plan.identity }), timeoutMs: 900_000 },
    );
    try {
      await importData({
        plan,
        staging,
        docker: (args, options) =>
          run(wsl(), [...guest, '/usr/local/bin/docker', ...args], options),
      });
      console.log('Copying profile files…');
      await copyProfile(staging, plan.profileRoot);
    } finally {
      await run(wsl(), ['--terminate', plan.distribution]).catch(() => {});
    }
    console.log('Done. Open Nod with the same NOD_DESKTOP_USER_DATA.');
  } catch (error) {
    console.error(`Import failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
