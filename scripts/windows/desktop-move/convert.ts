import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, relative, win32 } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import pg from 'pg';
import { openVaultValue, sealVaultValue } from '../../../src/server/vault-crypto.ts';
import {
  browserNamespace,
  desktopProfile,
  inside,
  keyCheckBinding,
  type Plan,
  planVersion,
  profileOwner,
  protectFolder,
  readVaultKey,
  run,
  sha256,
  sourceOwner,
} from './shared.ts';

type Row = Record<string, any>;

export const sealedKinds = [
  {
    table: 'vault_entries',
    binding: (row: Row, owner: string) => ['nod-vault-v1', owner, row.origin, row.id],
  },
  {
    table: 'credential_account_selections',
    binding: (row: Row, owner: string) => ['nod-vault-v1', owner, row.origin, row.id],
  },
  {
    table: 'vault_cards',
    binding: (row: Row, owner: string) => ['nod-vault-card-v1', owner, row.id],
  },
  {
    table: 'vault_app_grants',
    binding: (row: Row, owner: string) => ['nod-app-grant-v1', owner, row.id],
  },
  {
    table: 'channel_settings',
    binding: (row: Row, owner: string) => ['nod-channel-settings-v1', owner, row.provider],
  },
  {
    table: 'channel_session_keys',
    binding: (row: Row, owner: string) => ['nod', 'channel-session', owner, 'whatsapp', row.slot],
  },
] as const;

export const contentColumns = [
  'public.messages.text',
  'public.messages.display_text',
  'public.messages.reply_quote',
  'public.messages.audio_caption',
  'public.turns.prompt',
  'public.turns.error',
  'public.turn_events.summary',
  'public.turn_events.detail',
  'public.turn_events.command',
  'public.tasks.title',
  'public.tasks.brief',
  'public.tasks.result',
  'public.tasks.now_text',
  'public.tasks.done_when',
  'public.tasks.steps',
  'public.schedules.title',
  'public.schedules.prompt',
  'public.schedule_runs.title',
  'public.channel_inbox.text',
  'public.private_objects.bytes',
  'public.job_cvs.markdown',
  'public.job_templates.body',
  'pgboss.job.output',
];

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const uuidName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Column = {
  schema: string;
  table: string;
  root: string;
  column: string;
  kind: 'text' | 'json' | 'jsonb' | 'array' | 'bytea';
  element: string | null;
};

async function columns(client: pg.ClientBase) {
  return (
    await client.query<Column>(`
      SELECT n.nspname AS schema, c.relname AS "table",
        COALESCE((SELECT r.relname FROM pg_class r WHERE r.oid = pg_partition_root(c.oid)), c.relname) AS root,
        a.attname AS "column",
        CASE WHEN t.typname IN ('text','varchar','bpchar') THEN 'text'
             WHEN t.typname IN ('json','jsonb') THEN t.typname
             WHEN t.typname = 'bytea' THEN 'bytea'
             WHEN e.typname IN ('text','varchar','bpchar') THEN 'array' END AS kind,
        e.typname AS element
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_type e ON t.typcategory = 'A' AND e.oid = t.typelem
      WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1, 2, a.attnum`)
  ).rows.filter((row) => row.kind);
}

export async function tableCounts(client: pg.ClientBase) {
  const tables = (
    await client.query<{ schema: string; table: string }>(
      `SELECT n.nspname AS schema, c.relname AS "table" FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1, 2`,
    )
  ).rows;
  const counts: Record<string, number> = {};
  for (const { schema, table } of tables)
    counts[`${schema}.${table}`] = (
      await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${quote(schema)}.${quote(table)}`,
      )
    ).rows[0]!.count;
  return counts;
}

const identifierColumn = /(?:^|_)(?:id|ids|key|keys|owner)$/;
const ownerKey = /^owner(?:_?id)?$/i;

export function rewriteJsonText(text: string, from: string, to: string): [string, boolean] {
  const replacement = JSON.stringify(to);
  const stack: { object: boolean; expectKey: boolean; key?: string }[] = [];
  let output = '';
  let changed = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character !== '"') {
      const top = stack.at(-1);
      if (character === '{') stack.push({ object: true, expectKey: true });
      else if (character === '[') stack.push({ object: false, expectKey: false });
      else if (character === '}' || character === ']') stack.pop();
      else if (character === ':' && top) top.expectKey = false;
      else if (character === ',' && top?.object) {
        top.expectKey = true;
        top.key = undefined;
      }
      output += character;
      index++;
      continue;
    }
    let end = index + 1;
    while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    const token = text.slice(index, end + 1);
    const value = JSON.parse(token) as string;
    const top = stack.at(-1);
    const key = top?.object && top.expectKey;
    if (key) top.key = value;
    if (value === from && (key || (top?.object && ownerKey.test(top.key ?? '')))) {
      output += replacement;
      changed = true;
    } else output += token;
    index = end + 1;
  }
  return [output, changed];
}

function opens(key: Buffer, binding: readonly string[], ciphertext: string) {
  try {
    openVaultValue(key, binding, ciphertext);
    return true;
  } catch {
    return false;
  }
}

export type DatabaseReport = {
  resealed: Record<string, number>;
  rewritten: Record<string, number>;
  content: Record<string, number>;
  otherOwners: Record<string, number>;
  artifacts: { moved: number; left: number };
};

export async function transformDatabase(
  client: pg.ClientBase,
  options: {
    key: Buffer;
    oldOwner?: string;
    newOwner: string;
    sourceRoot: string;
    profileRoot: string;
    identityKey?: string;
    artifactFiles?: Set<string>;
    allowContent?: Iterable<string>;
  },
): Promise<DatabaseReport> {
  const oldOwner = options.oldOwner ?? sourceOwner;
  const { key, newOwner } = options;
  if (oldOwner === newOwner) throw new Error('The desktop owner matches the source owner.');
  const sourceRoot = win32.resolve(options.sourceRoot);
  const report: DatabaseReport = {
    resealed: {},
    rewritten: {},
    content: {},
    otherOwners: {},
    artifacts: { moved: 0, left: 0 },
  };
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL session_replication_role = replica');
    const present = new Set(
      (
        await client.query<{ name: string }>(
          `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'`,
        )
      ).rows.map((row) => row.name),
    );
    const sealed: {
      table: string;
      binding: (row: Row, owner: string) => string[];
      row: Row;
      plaintext: string;
    }[] = [];
    for (const kind of sealedKinds) {
      if (!present.has(kind.table)) continue;
      const rows = (
        await client.query<Row>(
          `SELECT ctid::text AS nod_row, * FROM public.${quote(kind.table)}
           WHERE owner_id = $1 AND ciphertext IS NOT NULL AND ciphertext <> ''`,
          [oldOwner],
        )
      ).rows;
      for (const [index, row] of rows.entries()) {
        let plaintext: string;
        try {
          plaintext = openVaultValue(key, kind.binding(row, oldOwner), row.ciphertext);
        } catch {
          throw new Error(
            `Saved value ${index + 1} of ${rows.length} in ${kind.table} does not open with this Vault key and the source owner. Check that --env points at the source install’s .env. Nothing was written.`,
          );
        }
        sealed.push({ table: kind.table, binding: kind.binding, row, plaintext });
      }
      const others = (
        await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM public.${quote(kind.table)} WHERE owner_id <> $1`,
          [oldOwner],
        )
      ).rows[0]!.count;
      if (others) report.otherOwners[kind.table] = others;
    }
    if (present.has('vault_key_check'))
      for (const row of (
        await client.query<Row>(
          'SELECT ciphertext FROM public.vault_key_check WHERE owner_id = $1',
          [oldOwner],
        )
      ).rows)
        if (!opens(key, ['nod-vault-v1', oldOwner, 'nod:vault', 'key-check'], row.ciphertext))
          throw new Error(
            'The Vault key check in vault_key_check does not open with this key. Check that --env points at the source install’s .env. Nothing was written.',
          );
    const checkpoint = present.has('integration_identities')
      ? (
          await client.query<{ public_key: string }>(
            'SELECT public_key FROM public.integration_identities WHERE owner_id = $1',
            [oldOwner],
          )
        ).rows[0]?.public_key
      : undefined;
    if (checkpoint !== undefined && checkpoint !== options.identityKey)
      throw new Error(
        options.identityKey === undefined
          ? 'The database expects a saved app identity, but integration-identity has no file for the source owner. Restore the source data folder first. Nothing was written.'
          : 'The saved app identity file does not match the one the database expects. Nothing was written.',
      );

    for (const item of sealed) {
      const next = sealVaultValue(key, item.binding(item.row, newOwner), item.plaintext);
      if (
        openVaultValue(key, item.binding(item.row, newOwner), next) !== item.plaintext ||
        opens(key, item.binding(item.row, oldOwner), next)
      )
        throw new Error(
          `A re-sealed value in ${item.table} did not check out. Nothing was written.`,
        );
      await client.query(
        `UPDATE public.${quote(item.table)} SET ciphertext = $1 WHERE ctid = $2::tid`,
        [next, item.row.nod_row],
      );
      report.resealed[item.table] = (report.resealed[item.table] ?? 0) + 1;
    }

    if (present.has('artifacts')) {
      const oldHash = sha256(oldOwner);
      const newHash = sha256(newOwner);
      for (const row of (
        await client.query<Row>(
          'SELECT ctid::text AS nod_row, id::text AS id, storage_path FROM public.artifacts WHERE owner_id = $1',
          [oldOwner],
        )
      ).rows) {
        const known = [
          win32.join(sourceRoot, 'artifacts', oldHash, row.id),
          win32.join(sourceRoot, 'artifacts', row.id),
        ].map((path) => path.toLowerCase());
        if (
          !known.includes(win32.resolve(String(row.storage_path)).toLowerCase()) ||
          (options.artifactFiles && !options.artifactFiles.has(row.id))
        ) {
          report.artifacts.left++;
          continue;
        }
        await client.query('UPDATE public.artifacts SET storage_path = $1 WHERE ctid = $2::tid', [
          win32.join(options.profileRoot, 'artifacts', newHash, row.id),
          row.nod_row,
        ]);
        report.artifacts.moved++;
      }
    }
    if (present.has('vault_key_check')) await client.query('DELETE FROM public.vault_key_check');
    if (present.has('nod_locks')) await client.query('DELETE FROM public.nod_locks');

    const all = await columns(client);
    const ownerJson = JSON.stringify(oldOwner);
    for (const column of all) {
      const target = `${quote(column.schema)}.${quote(column.table)}`;
      const name = quote(column.column);
      const label = `${column.schema}.${column.root}.${column.column}`;
      let count = 0;
      if (column.kind === 'text' && identifierColumn.test(column.column))
        count =
          (
            await client.query(`UPDATE ${target} SET ${name} = $2 WHERE ${name} = $1`, [
              oldOwner,
              newOwner,
            ])
          ).rowCount ?? 0;
      else if (column.kind === 'array' && identifierColumn.test(column.column))
        count =
          (
            await client.query(
              `UPDATE ${target} SET ${name} = array_replace(${name}, $1::${column.element}, $2::${column.element})
               WHERE $1::${column.element} = ANY(${name})`,
              [oldOwner, newOwner],
            )
          ).rowCount ?? 0;
      else if (column.kind === 'json' || column.kind === 'jsonb')
        for (const row of (
          await client.query<{ nod_row: string; value: string }>(
            `SELECT ctid::text AS nod_row, ${name}::text AS value FROM ${target} WHERE strpos(${name}::text, $1) > 0`,
            [ownerJson],
          )
        ).rows) {
          const [next, changed] = rewriteJsonText(row.value, oldOwner, newOwner);
          if (!changed) continue;
          await client.query(
            `UPDATE ${target} SET ${name} = $1::${column.kind} WHERE ctid = $2::tid`,
            [next, row.nod_row],
          );
          count++;
        }
      if (count) report.rewritten[label] = (report.rewritten[label] ?? 0) + count;
    }

    const paths = [
      ...new Set(
        [sourceRoot, sourceRoot.replaceAll('\\', '/'), JSON.stringify(sourceRoot).slice(1, -1)].map(
          (path) => path.toLowerCase(),
        ),
      ),
    ];
    const needles = [oldOwner.toLowerCase(), sha256(oldOwner), ...paths];
    const allowed = new Set([...contentColumns, ...(options.allowContent ?? [])]);
    const blocked: string[] = [];
    for (const column of all) {
      const target = `${quote(column.schema)}.${quote(column.table)}`;
      const name = quote(column.column);
      const label = `${column.schema}.${column.root}.${column.column}`;
      const matches = needles
        .map((_, index) =>
          column.kind === 'bytea'
            ? `strpos(lower(convert_from(${name}, 'LATIN1')), lower(convert_from($${index + 1}::bytea, 'LATIN1'))) > 0`
            : `strpos(lower(${name}::text), $${index + 1}) > 0`,
        )
        .join(' OR ');
      const found = (
        await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${target} WHERE ${matches}`,
          column.kind === 'bytea' ? needles.map((needle) => Buffer.from(needle)) : needles,
        )
      ).rows[0]!.count;
      if (!found) continue;
      if (label === 'public.artifacts.storage_path' && found <= report.artifacts.left) continue;
      if (allowed.has(label)) report.content[label] = (report.content[label] ?? 0) + found;
      else blocked.push(`${label} (${found} rows)`);
    }
    if (blocked.length)
      throw new Error(
        `The source owner, its hash or the source data folder still appears in: ${blocked.join(', ')}. These columns aren’t known to hold only text you or Nod wrote, so nothing was written. If a column holds only such text, add --allow-content <schema.table.column> and run convert again.`,
      );
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const identityBinding = (owner: string) =>
  Buffer.from(JSON.stringify(['nod-integration-identity-v1', owner]));

export function openIdentity(key: Buffer, owner: string, encrypted: Buffer) {
  if (encrypted.length < 28) throw new Error('The app identity file is too short.');
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAAD(identityBinding(owner));
  decipher.setAuthTag(encrypted.subarray(12, 28));
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
}

export function sealIdentity(key: Buffer, owner: string, plaintext: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(identityBinding(owner));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

async function optionalFile(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readSourceIdentity(sourceRoot: string, key: Buffer, owner = sourceOwner) {
  const directory = join(sourceRoot, 'integration-identity');
  const name = sha256(owner);
  const encrypted = await optionalFile(join(directory, `${name}.encrypted`));
  const marker = await optionalFile(join(directory, `${name}.public`));
  if (!encrypted) {
    if (marker) throw new Error('The app identity has a public marker but no encrypted key file.');
    return undefined;
  }
  let plaintext: Buffer;
  let publicKey: string | undefined;
  try {
    plaintext = openIdentity(key, owner, encrypted);
    const privateKey = createPrivateKey({ key: plaintext, format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
    publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  } catch {
    throw new Error(
      'The saved app identity does not open with this Vault key. Check that --env points at the source install’s .env. Nothing was written.',
    );
  }
  if (!publicKey) throw new Error('The saved app identity has no public key.');
  if (marker && marker.toString() !== publicKey)
    throw new Error('The saved app identity does not match its public marker.');
  return { plaintext, publicKey };
}

export async function writeIdentity(
  stageRoot: string,
  key: Buffer,
  owner: string,
  identity: { plaintext: Buffer; publicKey: string },
  oldOwner = sourceOwner,
) {
  const sealed = sealIdentity(key, owner, identity.plaintext);
  if (!openIdentity(key, owner, sealed).equals(identity.plaintext))
    throw new Error('The re-encrypted app identity did not check out.');
  let stale = true;
  try {
    openIdentity(key, oldOwner, sealed);
  } catch {
    stale = false;
  }
  if (stale) throw new Error('The re-encrypted app identity still opens for the source owner.');
  const directory = join(stageRoot, 'integration-identity');
  await mkdir(directory, { recursive: true });
  const name = sha256(owner);
  await writeFile(join(directory, `${name}.encrypted`), sealed, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, `${name}.public`), identity.publicKey, {
    flag: 'wx',
    mode: 0o600,
  });
}

async function entries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function copyKeepingTimes(source: string, target: string, contents?: Buffer) {
  const info = await stat(source);
  if (contents) await writeFile(target, contents, { flag: 'wx' });
  else await copyFile(source, target);
  await utimes(target, info.atime, info.mtime);
}

export async function stageSessions(sourceRoot: string, stageRoot: string, profileRoot: string) {
  const from = win32.join(win32.resolve(sourceRoot), 'sessions');
  const to = win32.join(profileRoot, 'sessions');
  const moved = (path: unknown) => {
    if (typeof path !== 'string' || !win32.isAbsolute(path)) return undefined;
    const rest = win32.relative(from, win32.resolve(path));
    if (rest === '') return to;
    if (rest.startsWith('..') || win32.isAbsolute(rest)) return undefined;
    return win32.join(to, rest);
  };
  let files = 0;
  let headers = 0;
  async function walk(source: string, target: string) {
    await mkdir(target, { recursive: true });
    for (const entry of await entries(source)) {
      const path = join(source, entry.name);
      const destination = join(target, entry.name);
      if (entry.isDirectory()) {
        await walk(path, destination);
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      if (!entry.name.endsWith('.jsonl')) {
        await copyKeepingTimes(path, destination);
        continue;
      }
      const bytes = await readFile(path);
      const end = bytes.indexOf(0x0a);
      const first = bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
      let header: Record<string, unknown> | undefined;
      try {
        header = JSON.parse(first);
      } catch {}
      if (header?.type !== 'session') {
        await copyKeepingTimes(path, destination);
        continue;
      }
      for (const field of ['cwd', 'parentSession']) {
        const next = moved(header[field]);
        if (next) header[field] = next;
      }
      headers++;
      await copyKeepingTimes(
        path,
        destination,
        Buffer.concat([
          Buffer.from(JSON.stringify(header)),
          bytes.subarray(end === -1 ? bytes.length : end),
        ]),
      );
    }
  }
  if ((await entries(from)).length) await walk(from, join(stageRoot, 'sessions'));
  return { files, headers };
}

export async function sourceArtifacts(sourceRoot: string, oldOwner = sourceOwner) {
  const source = join(sourceRoot, 'artifacts');
  const files = new Map<string, string>();
  let skipped = 0;
  const listing = await entries(source);
  for (const entry of listing)
    if (entry.isDirectory() && entry.name === sha256(oldOwner))
      for (const file of await entries(join(source, entry.name)))
        if (file.isFile() && uuidName.test(file.name))
          files.set(file.name, join(source, entry.name, file.name));
        else skipped++;
  for (const entry of listing)
    if (entry.isFile() && uuidName.test(entry.name)) {
      if (!files.has(entry.name)) files.set(entry.name, join(source, entry.name));
    } else if (!(entry.isDirectory() && entry.name === sha256(oldOwner))) skipped++;
  return { files, skipped };
}

export async function stageArtifacts(
  sourceRoot: string,
  stageRoot: string,
  newOwner: string,
  oldOwner = sourceOwner,
) {
  const { files, skipped } = await sourceArtifacts(sourceRoot, oldOwner);
  const target = join(stageRoot, 'artifacts', sha256(newOwner));
  if (files.size) await mkdir(target, { recursive: true });
  for (const [name, path] of files) await copyKeepingTimes(path, join(target, name));
  return { files: files.size, skipped };
}

const movedEntries = new Set(['sessions', 'pi', 'objects', 'artifacts', 'integration-identity']);
const skippedEntries = new Set([
  'workspaces',
  'access-key',
  'credential-request-key',
  'trace-key',
  'analytics-id',
  'logs',
  'feedback-logs',
  'speech',
  'startup-feedback.json',
  'vault',
  'runtime',
]);

export async function stageFiles(options: {
  sourceRoot: string;
  stageRoot: string;
  profileRoot: string;
  key: Buffer;
  newOwner: string;
  identity?: { plaintext: Buffer; publicKey: string };
}) {
  const { sourceRoot, stageRoot } = options;
  await mkdir(stageRoot, { recursive: true });
  const sessions = await stageSessions(sourceRoot, stageRoot, options.profileRoot);
  const artifacts = await stageArtifacts(sourceRoot, stageRoot, options.newOwner);
  for (const name of ['pi', 'objects'])
    if ((await entries(join(sourceRoot, name))).length)
      await cp(join(sourceRoot, name), join(stageRoot, name), {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
  if (options.identity)
    await writeIdentity(stageRoot, options.key, options.newOwner, options.identity);
  const left = (await entries(sourceRoot))
    .map((entry) => entry.name)
    .filter(
      (name) => !movedEntries.has(name) && !skippedEntries.has(name) && !name.endsWith('.log'),
    );
  return { sessions, artifacts, identity: Boolean(options.identity), left };
}

export async function scanStaged(directory: string, needles: string[]) {
  const found: string[] = [];
  async function walk(path: string) {
    for (const entry of await entries(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const text = (await readFile(child, 'utf8')).toLowerCase();
        if (needles.some((needle) => text.includes(needle))) found.push(relative(directory, child));
      }
    }
  }
  await walk(directory);
  return found;
}

async function checkSourceStopped(docker: string, project: string, port: number) {
  const image = `${project}-workspace`;
  await run(docker, ['image', 'inspect', '--format', '{{.Id}}', image]).catch((error: Error) => {
    throw new Error(`The source workspace image ${image} is missing: ${error.message}`);
  });
  const busy = new Set<string>();
  for (const name of [`${project}_browser-data`, `${project}_workspace-tools`])
    for (const container of (
      await run(docker, ['ps', '--filter', `volume=${name}`, '--format', '{{.Names}}'])
    ).split(/\r?\n/))
      if (container) busy.add(container);
  if (await sourceRunning(port)) busy.add(`a server on port ${port}`);
  if (busy.size)
    throw new Error(
      `The source install is still running (${[...busy].join(', ')}). Run scripts\\windows\\stop.ps1 first.`,
    );
}

export const mountSource = (type: 'bind' | 'volume', source: string) =>
  `type=${type},"source=${source.replaceAll('"', '""')}"`;

export async function exportVolumes(options: {
  docker: string;
  project: string;
  sourceRoot: string;
  out: string;
  newNamespace: string;
  sourceNamespace?: string;
}) {
  const { docker, project, out } = options;
  const image = `${project}-workspace`;
  const volume = async (name: string) =>
    run(docker, ['volume', 'inspect', '--format', '{{.Name}}', name]).then(
      () => true,
      (error: Error) => {
        if (/no such volume/i.test(error.message)) return false;
        throw error;
      },
    );
  const tar = (mount: string, args: string[], output: string) =>
    run(
      docker,
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0:0',
        '--mount',
        `${mount},target=/source,readonly`,
        '--entrypoint',
        'tar',
        image,
        '-c',
        '-f',
        '-',
        '-C',
        '/source',
        ...args,
      ],
      { output },
    );
  const archives = { workspace: false, browser: false, tools: false };
  const workspaces = join(options.sourceRoot, 'workspaces');
  if ((await entries(workspaces)).length) {
    await tar(mountSource('bind', win32.resolve(workspaces)), ['.'], join(out, 'workspace.tar'));
    archives.workspace = true;
  }
  const browserVolume = `${project}_browser-data`;
  let sourceNamespace: string | undefined;
  if (await volume(browserVolume)) {
    const names = (
      await run(docker, [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0:0',
        '--mount',
        `${mountSource('volume', browserVolume)},target=/source,readonly`,
        '--entrypoint',
        'ls',
        image,
        '-1',
        '/source',
      ])
    )
      .split(/\r?\n/)
      .filter((name) => /^sk-[a-f0-9]{24}$/.test(name));
    const computed = browserNamespace(options.sourceRoot);
    sourceNamespace =
      options.sourceNamespace ??
      (names.includes(computed) ? computed : names.length === 1 ? names[0] : undefined);
    if (!sourceNamespace && names.length > 1)
      throw new Error(
        `The source browser volume has several profiles (${names.join(', ')}) and none matches ${computed}. Pick one with --browser-namespace.`,
      );
    if (sourceNamespace && !names.includes(sourceNamespace))
      throw new Error(`The source browser volume has no ${sourceNamespace} folder.`);
    if (sourceNamespace) {
      await tar(
        mountSource('volume', browserVolume),
        [`--transform=s,^${sourceNamespace},${options.newNamespace},`, sourceNamespace],
        join(out, 'browser.tar'),
      );
      archives.browser = true;
    }
  }
  const toolsVolume = `${project}_workspace-tools`;
  if (await volume(toolsVolume)) {
    await tar(mountSource('volume', toolsVolume), ['.'], join(out, 'tools.tar'));
    archives.tools = true;
  }
  return { archives, sourceNamespace };
}

function sourceRunning(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function scratchDatabase(docker: string, given?: { url: string; container: string }) {
  if (given) {
    const url = new URL(given.url);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.port === '54329' ||
      /^nod-(?:local|postgres)-/.test(given.container)
    )
      throw new Error(
        'Use a throwaway local Postgres for --database, never the source database on port 54329.',
      );
    return { url, container: given.container, stop: async () => {} };
  }
  const container = `nod-move-db-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  await run(
    docker,
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--env',
      'POSTGRES_PASSWORD',
      '--publish',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  const stop = () => run(docker, ['stop', container]).then(() => {});
  try {
    const address = (await run(docker, ['port', container, '5432/tcp'])).split(/\r?\n/)[0]!;
    const port = address.slice(address.lastIndexOf(':') + 1);
    const url = new URL(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`);
    for (let attempt = 0; ; attempt++) {
      const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
        break;
      } catch (error) {
        if (attempt > 60)
          throw new Error(`The scratch database did not start: ${(error as Error).message}`);
        await new Promise((done) => setTimeout(done, 1000));
      } finally {
        await client.end().catch(() => {});
      }
    }
    return { url, container, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

export async function convert(options: {
  dump: string;
  sourceRoot: string;
  env: string;
  userData: string;
  out: string;
  docker?: string;
  project?: string;
  database?: { url: string; container: string };
  browserNamespace?: string;
  allowContent?: string[];
  log?: (line: string) => void;
}) {
  const log = options.log ?? console.log;
  const docker = options.docker ?? 'docker';
  const sourceRoot = win32.resolve(options.sourceRoot);
  const out = win32.resolve(options.out);
  const profile = desktopProfile(options.userData);
  for (const [name, path] of [
    ['--out', out],
    ['--user-data', profile.userData],
  ] as const)
    if (await inside(sourceRoot, path))
      throw new Error(`${name} must be outside the source data folder ${sourceRoot}.`);
  if (await inside(profile.userData, out))
    throw new Error(`--out must be outside the desktop folder ${profile.userData}.`);
  const ownerId = await profileOwner(profile.root);
  const { key } = await readVaultKey(options.env);
  const project = options.project ?? 'nod-local';
  await checkSourceStopped(
    docker,
    project,
    Number(parseEnv(await readFile(options.env, 'utf8')).PORT?.trim() || '4310'),
  );
  if ((await entries(out)).length)
    throw new Error(`The output folder ${out} is not empty. Choose a new one.`);
  await stat(options.dump).catch(() => {
    throw new Error(`The database dump ${options.dump} does not exist.`);
  });
  const identity = await readSourceIdentity(sourceRoot, key);
  try {
    const artifactFiles = new Set((await sourceArtifacts(sourceRoot)).files.keys());
    log('Starting a scratch database…');
    const scratch = await scratchDatabase(docker, options.database);
    const interrupt = () => {
      void scratch.stop().finally(() => process.exit(130));
    };
    process.once('SIGINT', interrupt);
    const database = `nod_move_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: scratch.url.href });
    const user = decodeURIComponent(scratch.url.username) || 'postgres';
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${quote(database)}`);
      log('Restoring the source dump…');
      await run(
        docker,
        [
          'exec',
          '-i',
          scratch.container,
          'pg_restore',
          '--no-owner',
          '--no-acl',
          '--exit-on-error',
          '-U',
          user,
          '-d',
          database,
        ],
        { input: { file: options.dump }, label: 'Restoring the source dump' },
      );
      const target = new URL(scratch.url.href);
      target.pathname = `/${database}`;
      const client = new pg.Client({ connectionString: target.href });
      await client.connect();
      let report: DatabaseReport;
      let tables: Record<string, number>;
      try {
        log('Moving the database to the desktop owner…');
        report = await transformDatabase(client, {
          key,
          newOwner: ownerId,
          sourceRoot,
          profileRoot: profile.root,
          identityKey: identity?.publicKey,
          artifactFiles,
          allowContent: options.allowContent,
        });
        tables = await tableCounts(client);
      } finally {
        await client.end();
      }
      await mkdir(out, { recursive: true });
      try {
        await protectFolder(out);
        log('Saving the converted database…');
        await run(
          docker,
          [
            'exec',
            scratch.container,
            'pg_dump',
            '--format=custom',
            '--no-owner',
            '--no-acl',
            '-U',
            user,
            '-d',
            database,
          ],
          { output: join(out, 'database.dump'), label: 'Saving the converted database' },
        );
        log('Staging files…');
        const files = await stageFiles({
          sourceRoot,
          stageRoot: join(out, 'profile'),
          profileRoot: profile.root,
          key,
          newOwner: ownerId,
          identity,
        });
        const leftovers = await scanStaged(join(out, 'profile', 'pi'), [
          sourceOwner,
          sha256(sourceOwner),
          sourceRoot.toLowerCase(),
          JSON.stringify(sourceRoot).slice(1, -1).toLowerCase(),
        ]);
        log('Exporting workspace, browser and tools data from the source Docker…');
        const volumes = await exportVolumes({
          docker,
          project,
          sourceRoot,
          out,
          newNamespace: profile.browserNamespace,
          sourceNamespace: options.browserNamespace,
        });
        const plan: Plan = {
          version: planVersion,
          createdAt: new Date().toISOString(),
          sourceOwner,
          ownerId,
          userData: profile.userData,
          profileRoot: profile.root,
          distribution: profile.distribution,
          identity: profile.identity,
          browserNamespace: profile.browserNamespace,
          keyCheck: sealVaultValue(key, [...keyCheckBinding, ownerId], 'ok'),
          tables,
          archives: volumes.archives,
        };
        await writeFile(join(out, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, {
          flag: 'wx',
        });
        return { report, files, volumes, leftovers, plan };
      } catch (error) {
        throw new Error(
          `${(error as Error).message} ${out} now holds a partial result without plan.json, which import refuses. Delete it or choose another --out.`,
        );
      }
    } finally {
      process.removeListener('SIGINT', interrupt);
      await admin.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
      await scratch.stop().catch(() => {});
    }
  } finally {
    identity?.plaintext.fill(0);
  }
}

function summary(result: Awaited<ReturnType<typeof convert>>) {
  const lines = [
    `Desktop owner: ${result.plan.ownerId}`,
    `Re-sealed: ${
      Object.entries(result.report.resealed)
        .map(([table, count]) => `${table} ${count}`)
        .join(', ') || 'nothing'
    }`,
    `Owner rewritten in: ${
      Object.entries(result.report.rewritten)
        .map(([column, count]) => `${column} ${count}`)
        .join(', ') || 'nothing'
    }`,
    `Attachments: ${result.report.artifacts.moved} moved, ${result.files.artifacts.files} files staged`,
    `Sessions: ${result.files.sessions.files} files, ${result.files.sessions.headers} headers moved`,
    `App identity: ${result.files.identity ? 'kept' : 'none in the source'}`,
    `Archives: ${
      Object.entries(result.volumes.archives)
        .filter(([, made]) => made)
        .map(([name]) => name)
        .join(', ') || 'none'
    }`,
  ];
  if (Object.keys(result.report.content).length)
    lines.push(
      `Left as written in your own text: ${Object.entries(result.report.content)
        .map(([column, count]) => `${column} ${count}`)
        .join(', ')}`,
    );
  if (Object.keys(result.report.otherOwners).length)
    lines.push(
      `Rows of other owners left as they were: ${Object.entries(result.report.otherOwners)
        .map(([table, count]) => `${table} ${count}`)
        .join(', ')}`,
    );
  if (result.report.artifacts.left)
    lines.push(
      `Attachments left unchanged: ${result.report.artifacts.left}. Their file is missing or outside the source folder, so they did not open in the source either.`,
    );
  if (result.files.left.length) lines.push(`Not moved: ${result.files.left.join(', ')}`);
  if (result.leftovers.length)
    lines.push(`Check these pi files, they mention the source: ${result.leftovers.join(', ')}`);
  return lines.join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dump: { type: 'string' },
      'source-root': { type: 'string' },
      env: { type: 'string' },
      'user-data': { type: 'string' },
      out: { type: 'string' },
      database: { type: 'string' },
      'postgres-container': { type: 'string' },
      'source-project': { type: 'string' },
      'browser-namespace': { type: 'string' },
      'allow-content': { type: 'string', multiple: true },
    },
  });
  const missing = ['dump', 'source-root', 'env', 'user-data', 'out'].filter(
    (name) => !values[name as keyof typeof values],
  );
  if (missing.length || Boolean(values.database) !== Boolean(values['postgres-container'])) {
    console.error(
      `Usage: convert.ts --dump <database.dump> --source-root <nod\\.local> --env <nod\\.env> --user-data <desktop folder> --out <new folder> [--database <url> --postgres-container <name>] [--source-project nod-local] [--browser-namespace sk-…] [--allow-content schema.table.column]`,
    );
    process.exit(2);
  }
  try {
    const result = await convert({
      dump: values.dump!,
      sourceRoot: values['source-root']!,
      env: values.env!,
      userData: values['user-data']!,
      out: values.out!,
      project: values['source-project'],
      browserNamespace: values['browser-namespace'],
      allowContent: values['allow-content'],
      database: values.database
        ? { url: values.database, container: values['postgres-container']! }
        : undefined,
    });
    console.log(summary(result));
    console.log(`Staged in ${values.out}. Next: quit Nod, then run import.ts with --dry-run.`);
  } catch (error) {
    console.error(`Conversion failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
