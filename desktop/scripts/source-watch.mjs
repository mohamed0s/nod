import { statSync, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeSources } from './runtime-inputs.mjs';

const engineSources = ['src', 'desktop/main/engine.mjs', 'desktop/main/system-certificates.mjs'];
const webSources = ['src/web'];
const docsSources = ['docs/src/content/docs'];
const appSources = ['desktop/main', 'desktop/preload', 'desktop/ui', 'desktop/runtime'];
const engineFiles = /\.(?:[cm]?[jt]s|tsx|json|md|svg)$/;
const scriptFiles = /\.(?:[cm]?[jt]s|tsx)$/;
const editorFiles = /^\.#|~$|\.sw[a-p]x?$|___jb_(?:tmp|old)___$|^\.DS_Store$|^4913$/;

function within(path, sources) {
  return sources.some((source) => path === source || path.startsWith(`${source}/`));
}

function named(paths) {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

export function sortChanges(paths, runtime) {
  const changes = { engine: [], docs: [], app: [], images: [] };
  for (const path of [...new Set(paths)].sort()) {
    const name = posix.basename(path);
    if (editorFiles.test(name) || (name.startsWith('.') && !runtime.includes(path))) continue;
    if (within(path, runtime)) changes.images.push(path);
    if (within(path, docsSources)) changes.docs.push(path);
    if (within(path, appSources) && path !== 'desktop/main/engine.mjs') changes.app.push(path);
    if (within(path, engineSources) && !within(path, webSources) && engineFiles.test(name))
      changes.engine.push(path);
  }
  return changes;
}

export async function syntaxError(root, paths) {
  const { transform } = await import('esbuild');
  for (const path of paths) {
    if (!scriptFiles.test(path) && !path.endsWith('.json')) continue;
    const source = await readFile(join(root, path), 'utf8').catch(() => undefined);
    if (source === undefined) continue;
    try {
      if (path.endsWith('.json')) JSON.parse(source);
      else
        await transform(source, {
          loader: path.endsWith('.tsx') ? 'tsx' : /\.[cm]?ts$/.test(path) ? 'ts' : 'js',
          sourcefile: path,
          logLevel: 'silent',
        });
    } catch (error) {
      const [first] = error.errors ?? [];
      if (!first) return `${path}: ${error.message}`;
      const at = first.location ? `:${first.location.line}:${first.location.column + 1}` : '';
      return `${path}${at}: ${first.text}`;
    }
  }
}

export function sourceChanges({
  root,
  runtime,
  restart,
  log = console,
  take = () => [],
  closed = () => false,
  pollMs = 5000,
}) {
  async function files(paths) {
    const checked = await Promise.all(
      paths.map(async (path) =>
        (await stat(join(root, path)).catch(() => undefined))?.isDirectory() ? undefined : path,
      ),
    );
    return checked.filter(Boolean);
  }
  async function sorted(paths) {
    const changes = sortChanges(await files(paths), runtime);
    if (changes.images.length)
      log.warn(
        `Nod: the runtime images include ${named(changes.images)}, so the running runtime keeps the old version. Prepare a new runtime (pnpm run ${process.platform === 'win32' ? 'desktop:windows:prepare' : 'desktop:prepare'}) and reopen Nod to use the change.`,
      );
    if (changes.app.length)
      log.warn(
        `Nod: ${named(changes.app)} changed. Quit Nod and start it again to use the change.`,
      );
    if (changes.docs.length)
      log.log(
        `Nod: ${named(changes.docs)} changed. Pi's docs search picks it up at the next engine restart.`,
      );
    return changes.engine;
  }
  return async function apply(paths) {
    const engine = new Set(await sorted(paths));
    let waiting;
    while (engine.size && !closed()) {
      for (const path of await sorted(take())) engine.add(path);
      const changed = named([...engine].sort());
      const broken = await syntaxError(root, [...engine]);
      if (broken) {
        log.error(
          `Nod: ${broken}. The engine keeps running the previous version until you save a fix.`,
        );
        return;
      }
      let result;
      try {
        result = await restart();
      } catch (error) {
        log.error(`Nod could not restart the engine after ${changed} changed: ${error.message}`);
        return;
      }
      if (result?.outcome === 'waiting') {
        const message = Number.isInteger(result.running)
          ? `Nod: ${changed} changed. The engine restarts when ${result.running === 1 ? 'the running reply or task finishes' : `the ${result.running} running replies and tasks finish`}.`
          : `Nod: ${changed} changed, but Nod could not check for running work (${result.reason}). The engine restarts once it can confirm nothing is running.`;
        if (message !== waiting) log.log(message);
        waiting = message;
        await delay(pollMs);
        continue;
      }
      if (result?.outcome !== 'restarted')
        log.warn(`Nod: ${changed} changed, but the engine is not running, so nothing restarted.`);
      else if (result.status?.phase === 'error')
        log.error(
          `Nod: the engine did not start again after ${changed} changed: ${result.status.error || result.status.message}`,
        );
      else log.log(`Nod: restarted the engine for ${changed}.`);
      return;
    }
  };
}

export function createChangeQueue({ flush, delay: settle = 1500 }) {
  let batch = new Set();
  let timer;
  let running;
  let closed = false;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, settle);
  }
  function run() {
    timer = undefined;
    if (closed || running || !batch.size) return;
    const paths = [...batch];
    batch = new Set();
    running = Promise.resolve()
      .then(() => flush(paths))
      .finally(() => {
        running = undefined;
        if (batch.size && !closed) schedule();
      });
  }
  return {
    add(path) {
      if (closed) return;
      batch.add(path);
      if (!running) schedule();
    },
    take() {
      const paths = [...batch];
      batch = new Set();
      return paths;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      return running;
    },
  };
}

function isDirectory(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory();
  } catch {
    return undefined;
  }
}

export async function watchSources({ root, restart, log = console }) {
  const { sources: runtime } = await runtimeSources(
    process.platform === 'win32' ? 'win32-x64' : undefined,
  );
  let closed = false;
  const watchers = new Set();
  const queue = createChangeQueue({
    flush: sourceChanges({
      root,
      runtime,
      restart,
      log,
      take: () => queue.take(),
      closed: () => closed,
    }),
  });
  const directories = new Map();
  for (const source of [...engineSources, ...docsSources, ...appSources, ...runtime]) {
    const directory = isDirectory(join(root, source));
    if (directory === undefined) continue;
    const path = directory ? source : posix.dirname(source);
    directories.set(path, directories.get(path) === true || directory);
  }
  function open(path, recursive) {
    if (closed) return;
    let watcher;
    try {
      watcher = watch(join(root, path), { recursive }, (_event, name) => {
        if (name) queue.add(posix.join(path, String(name).replaceAll('\\', '/')));
      });
    } catch {
      setTimeout(() => open(path, recursive), 2000);
      return;
    }
    watchers.add(watcher);
    watcher.on('error', (error) => {
      watchers.delete(watcher);
      watcher.close();
      log.warn(`Nod: watching ${path} stopped (${error.code || error.message}). Retrying.`);
      setTimeout(() => open(path, recursive), 2000);
    });
  }
  for (const [path, recursive] of directories)
    if (![...directories].some(([other, deep]) => deep && path.startsWith(`${other}/`)))
      open(path, recursive);
  return () => {
    closed = true;
    for (const watcher of watchers) watcher.close();
    return queue.close();
  };
}
