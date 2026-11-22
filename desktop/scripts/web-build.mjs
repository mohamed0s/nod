import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'vite';

const index = join(process.cwd(), 'dist', 'web', 'index.html');
const send = (message) => process.parentPort?.postMessage(message);
const previous = await readFile(index, 'utf8').catch(() => '');
let first = true;
let failed = false;
const watcher = await build({
  logLevel: 'silent',
  build: { watch: {}, emptyOutDir: false },
});
watcher.on('event', async (event) => {
  if (event.code === 'START') failed = false;
  if (event.code === 'ERROR') {
    failed = true;
    send({ type: 'nod-web-build-failed', message: event.error?.message ?? String(event.error) });
  }
  if (event.code !== 'END' || failed) return;
  const reload = !first || (await readFile(index, 'utf8').catch(() => '')) !== previous;
  first = false;
  send({ type: 'nod-web-built', reload });
});
