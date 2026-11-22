import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parts(version) {
  return version.split('.').map(Number);
}

function compare(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function forkVersion(base, tags, { requested = '', automatic = false } = {}) {
  if (!versionPattern.test(base)) throw new Error(`n8n's desktop version "${base}" is not X.Y.Z.`);
  const [major, minor, patch] = parts(base);
  const first = (patch + 1) * 100;
  const range = `${major}.${minor}.${first} to ${major}.${minor}.${first + 99}`;
  const inRange = (version) => {
    const [x, y, z] = parts(version);
    return x === major && y === minor && z >= first && z < first + 100;
  };
  const released = tags
    .filter((tag) => tag.startsWith('nod-v') && versionPattern.test(tag.slice(5)))
    .map((tag) => tag.slice(5))
    .sort(compare);
  const builds = released.filter(inRange);
  if (automatic && builds.length) return { covered: builds.at(-1) };
  const next = builds.length ? parts(builds.at(-1))[2] - first + 1 : 0;
  if (!requested && next > 99)
    throw new Error(`n8n's Nod ${base} already has 100 fork builds (${range}).`);
  const version = requested || `${major}.${minor}.${first + next}`;
  if (!versionPattern.test(version))
    throw new Error(`Use a version like ${major}.${minor}.${first}, not "${version}".`);
  if (!inRange(version))
    throw new Error(`Builds of n8n's Nod ${base} use ${range}, so ${version} can't be used.`);
  if (parts(version).some((part) => part > 65535))
    throw new Error(
      `Windows allows at most 65535 in each part of a version, so ${version} can't be used.`,
    );
  const highest = released.at(-1);
  if (highest && compare(version, highest) <= 0)
    throw new Error(
      `${version} must be higher than nod-v${highest}, the highest version tag on this fork.`,
    );
  return { version };
}

function github(path, query) {
  return execFileSync('gh', ['api', '--paginate', path, '--jq', query], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 ** 2,
  })
    .split('\n')
    .filter(Boolean);
}

async function plan() {
  const repository = process.env.GITHUB_REPOSITORY;
  const base = JSON.parse(await readFile('desktop/package.json', 'utf8')).version;
  const tags = github(`repos/${repository}/git/matching-refs/tags/nod-v`, '.[].ref').map((ref) =>
    ref.replace(/^refs\/tags\//, ''),
  );
  const { version, covered } = forkVersion(base, tags, {
    requested: process.env.NOD_FORK_VERSION?.trim(),
    automatic: process.env.GITHUB_EVENT_NAME === 'push',
  });
  const outputs = { base, release_needed: String(Boolean(version)) };
  let summary = `nod-v${covered} already covers n8n's Nod ${base}, so nothing was built. Run the workflow by hand to build another one.`;
  if (version) {
    const { fingerprint } = JSON.parse(
      execFileSync(process.execPath, ['desktop/scripts/runtime-inputs.mjs'], {
        encoding: 'utf8',
        env: { ...process.env, NOD_DESKTOP_TARGET: 'win32-x64' },
      }),
    );
    const wanted = [`runtime-win32-x64-${fingerprint}.json`, 'nod-Runtime-win32-x64.tar.gz'];
    const reusable = github(
      `repos/${repository}/releases?per_page=100`,
      '.[] | {tag_name, draft, prerelease, assets: [.assets[] | {name, state, digest}]}',
    )
      .map((line) => JSON.parse(line))
      .find(
        (release) =>
          !release.draft &&
          !release.prerelease &&
          release.tag_name.startsWith('nod-v') &&
          wanted.every((name) =>
            release.assets.some(
              (asset) =>
                asset.name === name &&
                asset.state === 'uploaded' &&
                /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''),
            ),
          ),
      );
    Object.assign(outputs, {
      version,
      runtime_fingerprint: fingerprint,
      runtime_tag: reusable?.tag_name ?? '',
      runtime_refresh: process.env.NOD_RUNTIME_REFRESH || 'local',
    });
    summary = `Building nod-v${version} from n8n's Nod ${base}. ${reusable ? `The Windows runtime comes from ${reusable.tag_name}.` : 'The Windows runtime is built fresh.'}`;
  } else console.log(`::notice title=No fork release needed::${summary}`);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await plan();
