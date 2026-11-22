import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import pg from 'pg';
import { loadIntegrationIdentity } from '../src/providers/composio/identity.ts';
import { openLocalSession } from '../src/providers/pi/checkpoint.ts';
import { sealVaultValue } from '../src/server/vault-crypto.ts';
import { checkedKeyStore } from '../src/server/vault.ts';
import {
  readSourceIdentity,
  sealedKinds,
  stageFiles,
  transformDatabase,
} from '../scripts/windows/desktop-move/convert.ts';

const oldOwner = 'local-development';
const newOwner = randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const skip = { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 };

async function disposableDatabase() {
  const name = `nod_move_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  return {
    url: url.href,
    client,
    async close() {
      await client.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

const sourceRoot = win32.resolve('C:\\synthetic\\nod\\.local');
const profileRoot = win32.resolve('D:\\synthetic-desktop\\profiles\\local');

async function seed(client: pg.Client, key: Buffer) {
  await client.query(`
    CREATE TABLE nod_locks(key text PRIMARY KEY);
    CREATE TABLE threads(id uuid PRIMARY KEY, owner_id text NOT NULL);
    CREATE TABLE messages(id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id), text text, attachments jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE preferences(owner_id text PRIMARY KEY, keep_out text[] NOT NULL);
    CREATE TABLE artifacts(id uuid PRIMARY KEY, owner_id text NOT NULL, storage_path text NOT NULL);
    CREATE TABLE integration_identities(owner_id text PRIMARY KEY, public_key text NOT NULL);
    CREATE TABLE vault_key_check(owner_id text PRIMARY KEY, ciphertext text NOT NULL);
    CREATE TABLE vault_entries(id text PRIMARY KEY, owner_id text NOT NULL, origin text NOT NULL, ciphertext text NOT NULL);
    CREATE TABLE credential_account_selections(id text NOT NULL, owner_id text NOT NULL, origin text NOT NULL, ciphertext text NOT NULL, PRIMARY KEY(owner_id, origin));
    CREATE TABLE vault_cards(id text PRIMARY KEY, owner_id text NOT NULL, ciphertext text NOT NULL);
    CREATE TABLE vault_app_grants(id uuid PRIMARY KEY, owner_id text NOT NULL, ciphertext text NOT NULL);
    CREATE TABLE channel_settings(owner_id text NOT NULL, provider text NOT NULL, ciphertext text, PRIMARY KEY(owner_id, provider));
    CREATE TABLE channel_sessions(owner_id text PRIMARY KEY, revision uuid NOT NULL);
    CREATE TABLE channel_session_keys(owner_id text NOT NULL REFERENCES channel_sessions(owner_id), slot text NOT NULL, ciphertext text NOT NULL, PRIMARY KEY(owner_id, slot));
    CREATE SCHEMA pgboss;
    CREATE TABLE pgboss.job(id uuid PRIMARY KEY, data jsonb, output jsonb);
  `);
  const thread = randomUUID();
  const artifact = randomUUID();
  await client.query('INSERT INTO nod_locks VALUES ($1), ($2)', [
    `thread:${oldOwner}`,
    `nod-vault-key:${oldOwner}`,
  ]);
  await client.query('INSERT INTO threads VALUES ($1, $2)', [thread, oldOwner]);
  await client.query('INSERT INTO messages VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    oldOwner,
    thread,
    `My source install keeps its files in ${sourceRoot} as local-development.`,
    JSON.stringify([{ id: artifact, name: 'report.pdf' }]),
  ]);
  await client.query('INSERT INTO preferences VALUES ($1, $2)', [oldOwner, ['a', oldOwner]]);
  await client.query('INSERT INTO artifacts VALUES ($1, $2, $3)', [
    artifact,
    oldOwner,
    win32.join(sourceRoot.toUpperCase(), 'artifacts', hash(oldOwner), artifact),
  ]);
  await client.query('INSERT INTO integration_identities VALUES ($1, $2)', [oldOwner, 'public']);
  await client.query('INSERT INTO vault_key_check VALUES ($1, $2)', [
    oldOwner,
    sealVaultValue(
      key,
      ['nod-vault-v1', oldOwner, 'nod:vault', 'key-check'],
      JSON.stringify({ username: '', password: '' }),
    ),
  ]);
  await client.query('INSERT INTO channel_sessions VALUES ($1, $2)', [oldOwner, randomUUID()]);
  for (const kind of sealedKinds) {
    const id = randomUUID();
    const origin = 'https://example.com';
    const ciphertext = sealVaultValue(
      key,
      kind.binding({ id, origin, provider: 'telegram', slot: 'creds' }, oldOwner),
      JSON.stringify({ username: 'synthetic', password: `secret-${kind.table}` }),
    );
    const [sql, values] = {
      vault_entries: [
        'INSERT INTO vault_entries VALUES ($1, $2, $3, $4)',
        [id, oldOwner, origin, ciphertext],
      ],
      credential_account_selections: [
        'INSERT INTO credential_account_selections VALUES ($1, $2, $3, $4)',
        [id, oldOwner, origin, ciphertext],
      ],
      vault_cards: ['INSERT INTO vault_cards VALUES ($1, $2, $3)', [id, oldOwner, ciphertext]],
      vault_app_grants: [
        'INSERT INTO vault_app_grants VALUES ($1, $2, $3)',
        [id, oldOwner, ciphertext],
      ],
      channel_settings: [
        "INSERT INTO channel_settings VALUES ($1, 'telegram', $2)",
        [oldOwner, ciphertext],
      ],
      channel_session_keys: [
        "INSERT INTO channel_session_keys VALUES ($1, 'creds', $2)",
        [oldOwner, ciphertext],
      ],
    }[kind.table] as [string, string[]];
    await client.query(sql, values);
  }
  await client.query('INSERT INTO pgboss.job VALUES ($1, $2, $3)', [
    randomUUID(),
    JSON.stringify({ ownerId: oldOwner, nested: [{ [oldOwner]: oldOwner }] }),
    JSON.stringify({ error: `ENOENT ${sourceRoot}\\sessions` }),
  ]);
  return { thread, artifact };
}

async function opensForApp(url: string, table: string, key: Buffer, owner?: string) {
  const schema = `probe_${randomBytes(4).toString('hex')}`;
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.${table} AS SELECT * FROM public.${table}`);
    if (owner) await pool.query(`UPDATE ${schema}.${table} SET owner_id = $1`, [owner]);
    await checkedKeyStore(pool, { id: 'test', configured: true, getKey: async () => key }).getKey();
    return true;
  } catch (error) {
    assert.match((error as Error).message, /Vault key does not match/);
    return false;
  } finally {
    await pool.end();
  }
}

test(
  'moving to the desktop owner leaves no source owner and re-seals every kind',
  skip,
  async () => {
    const key = randomBytes(32);
    const database = await disposableDatabase();
    try {
      const { artifact } = await seed(database.client, key);
      const report = await transformDatabase(database.client, {
        key,
        newOwner,
        sourceRoot,
        profileRoot,
        identityKey: 'public',
      });
      assert.deepEqual(
        Object.keys(report.resealed).sort(),
        sealedKinds.map((kind) => kind.table).sort(),
      );
      assert.deepEqual(Object.keys(report.content).sort(), [
        'pgboss.job.output',
        'public.messages.text',
      ]);
      const residue = await database.client.query(
        `SELECT 1 FROM threads WHERE owner_id = $1
       UNION ALL SELECT 1 FROM preferences WHERE $1 = ANY(keep_out) OR owner_id = $1
       UNION ALL SELECT 1 FROM pgboss.job WHERE strpos(data::text, $1) > 0
       UNION ALL SELECT 1 FROM nod_locks UNION ALL SELECT 1 FROM vault_key_check
       UNION ALL SELECT 1 FROM channel_session_keys WHERE owner_id = $1`,
        [oldOwner],
      );
      assert.equal(residue.rowCount, 0);
      assert.deepEqual((await database.client.query('SELECT data FROM pgboss.job')).rows[0].data, {
        ownerId: newOwner,
        nested: [{ [newOwner]: newOwner }],
      });
      assert.equal(
        (await database.client.query('SELECT storage_path FROM artifacts')).rows[0].storage_path,
        win32.join(profileRoot, 'artifacts', hash(newOwner), artifact),
      );
      for (const kind of sealedKinds) {
        assert.equal(await opensForApp(database.url, kind.table, key), true, kind.table);
        assert.equal(await opensForApp(database.url, kind.table, key, oldOwner), false, kind.table);
      }
    } finally {
      await database.close();
    }
  },
);

test(
  'a wrong Vault key or an unknown owner trace stops before anything changes',
  skip,
  async () => {
    const key = randomBytes(32);
    const database = await disposableDatabase();
    try {
      await seed(database.client, key);
      const before = (await database.client.query('SELECT owner_id, ciphertext FROM vault_entries'))
        .rows;
      await assert.rejects(
        transformDatabase(database.client, {
          key: randomBytes(32),
          newOwner,
          sourceRoot,
          profileRoot,
          identityKey: 'public',
        }),
        /in vault_entries does not open with this Vault key/,
      );
      await database.client.query('CREATE TABLE widgets(note text NOT NULL)');
      await database.client.query('INSERT INTO widgets VALUES ($1)', [`cache:${oldOwner}:1`]);
      await assert.rejects(
        transformDatabase(database.client, {
          key,
          newOwner,
          sourceRoot,
          profileRoot,
          identityKey: 'public',
        }),
        /still appears in: public\.widgets\.note \(1 rows\)/,
      );
      assert.deepEqual(
        (await database.client.query('SELECT owner_id, ciphertext FROM vault_entries')).rows,
        before,
      );
      assert.equal((await database.client.query('SELECT 1 FROM nod_locks')).rowCount, 2);
    } finally {
      await database.close();
    }
  },
);

test('the app identity and Pi sessions come back under the desktop profile', async () => {
  const key = randomBytes(32);
  const root = await mkdtemp(join(tmpdir(), 'nod-move-'));
  try {
    const source = join(root, 'source');
    const stage = join(root, 'stage');
    const profile = join(root, 'profile');
    const keyStore = { id: 'test', configured: true, getKey: async () => Buffer.from(key) };
    const memory = (value?: string) => ({
      read: async () => value,
      commit: async (publicKey: string) => {
        value ??= publicKey;
        if (value !== publicKey) throw new Error('changed');
      },
    });
    const original = await loadIntegrationIdentity({
      dataRoot: source,
      ownerId: oldOwner,
      keyStore,
      checkpoint: memory(),
    });
    const thread = join(source, 'sessions', 'thread-a');
    await mkdir(thread, { recursive: true });
    const sessions = ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z'].map((stamp) => {
      const manager = SessionManager.create(thread, thread);
      manager.appendMessage({ role: 'user', content: `synthetic ${stamp}`, timestamp: 1 });
      return manager;
    });
    const files = (await readdir(thread)).sort();
    await utimes(join(thread, files[0]!), new Date(), new Date(Date.now() + 60_000));
    await utimes(join(thread, files[1]!), new Date(), new Date(Date.now() - 60_000));
    const expected = openLocalSession(thread).getSessionId();
    assert.ok(sessions.some((manager) => manager.getSessionId() === expected));
    await writeFile(join(source, 'access-key'), 'synthetic');

    const identity = await readSourceIdentity(source, key);
    const staged = await stageFiles({
      sourceRoot: source,
      stageRoot: stage,
      profileRoot: profile,
      key,
      newOwner,
      identity,
    });
    assert.deepEqual(staged.left, []);
    await cp(stage, profile, { recursive: true, preserveTimestamps: true });
    assert.equal(openLocalSession(join(profile, 'sessions', 'thread-a')).getSessionId(), expected);
    const moved = await loadIntegrationIdentity({
      dataRoot: profile,
      ownerId: newOwner,
      keyStore,
      checkpoint: memory(original.publicKey),
    });
    assert.equal(moved.publicKey, original.publicKey);
    assert.equal(moved.userId, original.userId);
    await assert.rejects(readSourceIdentity(source, randomBytes(32)), /does not open/);
    await assert.rejects(
      loadIntegrationIdentity({
        dataRoot: profile,
        ownerId: oldOwner,
        keyStore,
        checkpoint: memory(original.publicKey),
      }),
      /missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
