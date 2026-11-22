import { statSync, watch } from 'node:fs';
import { join, posix } from 'node:path';
import { runtimeSources } from '../scripts/runtime-inputs.mjs';

const engineSources = [
  'src',
  'docs/src/content/docs',
  'desktop/main/engine.mjs',
  'desktop/main/system-certificates.mjs',
];
const webSources = ['src/web'];
const appSources = ['desktop/main', 'desktop/preload', 'desktop/ui', 'desktop/runtime'];

function within(path, sources) {
  return sources.some((source) => path === source || path.startsWith(`${source}/`));
}

function isDirectory(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory();
  } catch {
    return undefined;
  }
}

function named(paths) {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

export function createChangeQueue({ flush, delay = 500 }) {
  let batch = new Set();
  let timer;
  let running;
  let closed = false;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }
  function run() {
    timer = undefined;
    if (closed || running || !batch.size) return;
    const paths = batch;
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
    close() {
      closed = true;
      clearTimeout(timer);
      return running;
    },
  };
}

export async function watchSources({ root, restart, log = console }) {
  const { sources: runtime } = await runtimeSources(
    process.platform === 'win32' ? 'win32-x64' : undefined,
  );
  const directories = new Map();
  for (const source of [...engineSources, ...appSources, ...runtime]) {
    const directory = isDirectory(join(root, source));
    if (directory === undefined) continue;
    const path = directory ? source : posix.dirname(source);
    directories.set(path, directories.get(path) === true || directory);
  }
  const queue = createChangeQueue({
    flush: async (paths) => {
      const changed = [...paths].sort();
      const images = changed.filter((path) => within(path, runtime));
      const app = changed.filter(
        (path) => within(path, appSources) && path !== 'desktop/main/engine.mjs',
      );
      const engine = changed.filter(
        (path) => within(path, engineSources) && !within(path, webSources),
      );
      if (images.length)
        log.warn(
          `Nod: the runtime images include ${named(images)}, so the running runtime keeps the old version. Prepare a new runtime (pnpm run ${process.platform === 'win32' ? 'desktop:windows:prepare' : 'desktop:prepare'}) and reopen Nod to use the change.`,
        );
      if (app.length)
        log.warn(`Nod: ${named(app)} changed. Quit Nod and start it again to use the change.`);
      if (!engine.length) return;
      log.log(`Nod: ${named(engine)} changed. Restarting the engine.`);
      try {
        const result = await restart();
        if (!result) log.warn('Nod: the engine is not running, so it was not restarted.');
        else if (result.phase === 'error')
          log.error(`Nod: the engine did not start again: ${result.error || result.message}`);
      } catch (error) {
        log.error(`Nod could not restart the engine: ${error.message}`);
      }
    },
  });
  const watchers = [...directories]
    .filter(
      ([path]) =>
        ![...directories].some(([other, recursive]) => recursive && path.startsWith(`${other}/`)),
    )
    .map(([path, recursive]) => {
      const watcher = watch(join(root, path), { recursive }, (_event, name) => {
        if (!name) return;
        const file = posix.join(path, String(name).replaceAll('\\', '/'));
        if (!isDirectory(join(root, file))) queue.add(file);
      });
      watcher.on('error', (error) => {
        log.error(`Nod stopped watching ${path}: ${error.message}`);
        watcher.close();
      });
      return watcher;
    });
  return () => {
    for (const watcher of watchers) watcher.close();
    return queue.close();
  };
}
