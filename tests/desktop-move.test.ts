import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import pg from 'pg';
import { loadIntegrationIdentity } from '../src/providers/composio/identity.ts';
import { openLocalSession } from '../src/providers/pi/checkpoint.ts';
import { createArtifactService } from '../src/server/artifacts.ts';
import { sealVaultValue } from '../src/server/vault-crypto.ts';
import { checkedKeyStore } from '../src/server/vault.ts';
import {
  convert,
  readSourceIdentity,
  sealedKinds,
  sourceArtifacts,
  stageFiles,
  transformDatabase,
} from '../scripts/windows/desktop-move/convert.ts';
import {
  checkDesktop,
  copyProfile,
  restoreDatabase,
} from '../scripts/windows/desktop-move/import.ts';
import { desktopProfile, readPlan, run } from '../scripts/windows/desktop-move/shared.ts';

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
    name,
    url: url.href,
    client,
    async close() {
      await client.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'nod-move-'));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

const sourceRoot = win32.resolve('C:\\synthetic\\nod\\.local');
const profileRoot = win32.resolve('D:\\synthetic-desktop\\profiles\\local');

async function seed(client: pg.Client, key: Buffer) {
  await client.query(`
    CREATE TABLE nod_locks(key text PRIMARY KEY);
    CREATE TABLE threads(id uuid PRIMARY KEY, owner_id text NOT NULL);
    CREATE TABLE messages(id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id), text text, attachments jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE preferences(owner_id text PRIMARY KEY, account_ids text[] NOT NULL, keep_out text[] NOT NULL);
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
  for (const text of [
    `My source install keeps its files in ${sourceRoot} as local-development.`,
    oldOwner,
  ])
    await client.query('INSERT INTO messages VALUES ($1, $2, $3, $4, $5)', [
      randomUUID(),
      oldOwner,
      thread,
      text,
      JSON.stringify([{ id: artifact, name: 'report.pdf' }]),
    ]);
  await client.query('INSERT INTO preferences VALUES ($1, $2, $3)', [
    oldOwner,
    ['a', oldOwner],
    ['b'],
  ]);
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
  await client.query('INSERT INTO pgboss.job VALUES ($1, $2::jsonb, $3)', [
    randomUUID(),
    `{"ownerId": "${oldOwner}", "nested": [{"owner": "${oldOwner}"}], "byOwner": {"${oldOwner}": 1}, "big": 12345678901234567890123}`,
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
       UNION ALL SELECT 1 FROM preferences WHERE $1 = ANY(account_ids) OR owner_id = $1
       UNION ALL SELECT 1 FROM pgboss.job WHERE strpos(data::text, $1) > 0
       UNION ALL SELECT 1 FROM nod_locks UNION ALL SELECT 1 FROM vault_key_check
       UNION ALL SELECT 1 FROM channel_session_keys WHERE owner_id = $1`,
        [oldOwner],
      );
      assert.equal(residue.rowCount, 0);
      const job = (await database.client.query("SELECT data, data->>'big' AS big FROM pgboss.job"))
        .rows[0];
      assert.equal(job.big, '12345678901234567890123');
      assert.equal(job.data.ownerId, newOwner);
      assert.deepEqual(job.data.nested, [{ owner: newOwner }]);
      assert.deepEqual(job.data.byOwner, { [newOwner]: 1 });
      assert.equal(
        (
          await database.client.query('SELECT count(*)::int AS n FROM messages WHERE text = $1', [
            oldOwner,
          ])
        ).rows[0].n,
        1,
      );
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

test('attachments open through the artifact service after the move', skip, async () => {
  const key = randomBytes(32);
  const database = await disposableDatabase();
  const folder = await temporary();
  try {
    const source = join(folder.root, 'source');
    const stage = join(folder.root, 'stage');
    const profile = join(folder.root, 'profile');
    await mkdir(join(source, 'artifacts', hash(oldOwner)), { recursive: true });
    await mkdir(profile, { recursive: true });
    const [hashed, legacy, missing] = [randomUUID(), randomUUID(), randomUUID()];
    await writeFile(join(source, 'artifacts', hash(oldOwner), hashed), 'hashed bytes');
    await writeFile(join(source, 'artifacts', legacy), 'legacy bytes');
    await database.client.query(`
      CREATE TABLE threads(id uuid PRIMARY KEY, owner_id text NOT NULL);
      CREATE TABLE artifacts(id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id),
        name text NOT NULL, mime_type text NOT NULL, size integer NOT NULL, storage_path text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, deleting_at timestamptz);
    `);
    for (const [id, path, size] of [
      [hashed, join(source, 'artifacts', hash(oldOwner), hashed), 12],
      [legacy, join(source, 'artifacts', legacy), 12],
      [missing, join(source, 'artifacts', hash(oldOwner), missing), 5],
    ] as const)
      await database.client.query(
        "INSERT INTO artifacts(id, owner_id, name, mime_type, size, storage_path) VALUES ($1, $2, 'a.txt', 'text/plain', $3, $4)",
        [id, oldOwner, size, path],
      );
    const report = await transformDatabase(database.client, {
      key,
      newOwner,
      sourceRoot: source,
      profileRoot: profile,
      artifactFiles: new Set((await sourceArtifacts(source)).files.keys()),
    });
    assert.deepEqual(report.artifacts, { moved: 2, left: 1 });
    assert.equal(
      (await database.client.query('SELECT storage_path FROM artifacts WHERE id = $1', [missing]))
        .rows[0].storage_path,
      join(source, 'artifacts', hash(oldOwner), missing),
    );
    await stageFiles({ sourceRoot: source, stageRoot: stage, profileRoot: profile, key, newOwner });
    await cp(stage, profile, { recursive: true });
    const pool = new pg.Pool({ connectionString: database.url });
    try {
      const service = createArtifactService({
        database: pool,
        ownerId: newOwner,
        localRoot: profile,
      });
      assert.equal((await service.readArtifact(hashed)).toString(), 'hashed bytes');
      assert.equal((await service.readArtifact(legacy)).toString(), 'legacy bytes');
      await assert.rejects(service.readArtifact(missing));
    } finally {
      await pool.end();
    }
  } finally {
    await database.close();
    await folder.close();
  }
});

test(
  'a failed or mismatched restore leaves the desktop database as it was',
  {
    skip: !process.env.TEST_DATABASE_URL || !process.env.TEST_POSTGRES_CONTAINER,
    timeout: 120_000,
  },
  async () => {
    const container = process.env.TEST_POSTGRES_CONTAINER!;
    const user = decodeURIComponent(new URL(process.env.TEST_DATABASE_URL!).username);
    const docker = (args: string[], options: Parameters<typeof run>[2]) =>
      run('docker', args, options);
    const source = await disposableDatabase();
    const target = await disposableDatabase();
    const folder = await temporary();
    try {
      await source.client.query(`
        CREATE TABLE t(id int); INSERT INTO t VALUES (1), (2), (3);
        CREATE SCHEMA pgboss; CREATE TABLE pgboss.q(x int); INSERT INTO pgboss.q VALUES (1);
      `);
      await target.client.query(
        'CREATE TABLE desktop_only(id int); INSERT INTO desktop_only VALUES (7);',
      );
      const dump = join(folder.root, 'source.dump');
      await docker(
        ['exec', container, 'pg_dump', '--format=custom', '-U', user, '-d', source.name],
        { output: dump, label: 'test dump' },
      );
      const bytes = await readFile(dump);
      const truncated = join(folder.root, 'truncated.dump');
      await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
      const restore = (file: string, tables: Record<string, number>) =>
        restoreDatabase({ docker, container, dump: file, tables, user, database: target.name });
      const untouched = async () =>
        assert.deepEqual((await target.client.query('SELECT id FROM desktop_only')).rows, [
          { id: 7 },
        ]);
      await assert.rejects(restore(truncated, { 'public.t': 3, 'pgboss.q': 1 }));
      await untouched();
      await assert.rejects(
        restore(dump, { 'public.t': 99, 'pgboss.q': 1 }),
        /does not match the conversion: public\.t expected 99, found 3/,
      );
      await untouched();
      await restore(dump, { 'public.t': 3, 'pgboss.q': 1 });
      assert.equal(
        (await target.client.query("SELECT to_regclass('public.desktop_only') AS t")).rows[0].t,
        null,
      );
      assert.equal((await target.client.query('SELECT count(*)::int AS n FROM t')).rows[0].n, 3);
    } finally {
      await source.close();
      await target.close();
      await folder.close();
    }
  },
);

test('the plan, profile and folders must agree before anything moves', async () => {
  const folder = await temporary();
  try {
    const userData = join(folder.root, 'desktop');
    const profile = desktopProfile(userData);
    const staging = join(folder.root, 'staging');
    await mkdir(staging, { recursive: true });
    await mkdir(profile.root, { recursive: true });
    await writeFile(join(profile.root, 'profile.json'), JSON.stringify({ ownerId: randomUUID() }));
    const plan = {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceOwner: oldOwner,
      ownerId: newOwner,
      userData,
      profileRoot: profile.root,
      distribution: profile.distribution,
      identity: profile.identity,
      browserNamespace: profile.browserNamespace,
      keyCheck: '',
      tables: {},
      archives: { workspace: false, browser: false, tools: false },
    };
    await writeFile(join(staging, 'plan.json'), JSON.stringify(plan));
    await assert.rejects(checkDesktop(await readPlan(staging), staging), /profile changed/);
    await writeFile(
      join(staging, 'plan.json'),
      JSON.stringify({ ...plan, profileRoot: join(folder.root, 'elsewhere') }),
    );
    await assert.rejects(readPlan(staging), /does not match its desktop folder/);

    const source = join(folder.root, 'nod', '.local');
    await mkdir(source, { recursive: true });
    const attempt = (out: string, data = userData) =>
      convert({
        dump: join(folder.root, 'none.dump'),
        sourceRoot: source,
        env: join(folder.root, '.env'),
        userData: data,
        out,
      });
    await assert.rejects(attempt(join(source, 'staging')), /--out must be outside the source/);
    await assert.rejects(attempt(source), /--out must be outside the source/);
    await assert.rejects(
      attempt(join(folder.root, 'out'), join(source, 'desktop')),
      /--user-data must be outside the source/,
    );
    await assert.rejects(attempt(join(userData, 'out')), /--out must be outside the desktop/);
    await assert.rejects(attempt(join(folder.root, 'nod', '.local-desktop')), /\.env could not/);
  } finally {
    await folder.close();
  }
});

test('the app identity and Pi sessions come back under the desktop profile', async () => {
  const key = randomBytes(32);
  const folder = await temporary();
  try {
    const source = join(folder.root, 'source');
    const stage = join(folder.root, 'stage');
    const profile = join(folder.root, 'profile');
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

    const desktop = join(folder.root, 'desktop-profile');
    await loadIntegrationIdentity({
      dataRoot: desktop,
      ownerId: newOwner,
      keyStore: { id: 'desktop', configured: true, getKey: async () => randomBytes(32) },
      checkpoint: memory(),
    });
    const empty = join(folder.root, 'empty-staging');
    await mkdir(join(empty, 'profile'), { recursive: true });
    const backup = join(empty, 'before-import');
    assert.deepEqual(
      await copyProfile({ staging: empty, profileRoot: desktop, backup, ownerId: newOwner }),
      { removed: 2 },
    );
    await readFile(join(backup, 'profile', 'integration-identity', `${hash(newOwner)}.encrypted`));
    assert.ok(
      (
        await loadIntegrationIdentity({
          dataRoot: desktop,
          ownerId: newOwner,
          keyStore,
          checkpoint: memory(),
        })
      ).publicKey,
    );
  } finally {
    await folder.close();
  }
});
