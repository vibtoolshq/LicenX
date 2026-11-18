/** LG-01A: disposable Group association and admin-only route coverage, no production data. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import express from 'express';
import { apiRouter, invalidateAdminConfigCache } from '../src/server/api.js';
import { handleCloudflareApi } from '../src/server/cloudflareHandler.js';
import { createSessionToken } from '../src/server/crypto.js';
import { getDbClient, initDatabaseSchema } from '../src/server/db.js';

test('LG-01A: authenticated groups, legacy bulk and Cloudflare parity', async () => {
  const saved = Object.fromEntries(
    ['NODE_ENV', 'DATABASE_PROVIDER', 'DATABASE_URL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
      .map(key => [key, process.env[key]]),
  );
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PROVIDER = 'libsql';
  process.env.DATABASE_URL = 'file::memory:';
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  let server: ReturnType<typeof createServer> | undefined;
  try {
    const db = getDbClient();
    await initDatabaseSchema();
    const info = await db.execute('PRAGMA table_info(licenses)');
    assert.ok(info.rows.some(row => row.name === 'group_id'));

    const secret = 'lg01a-disposable-admin-secret';
    const now = Date.now();
    await db.execute({
      sql: 'INSERT INTO admin_config (id, username, password_hash, jwt_secret, ed25519_private_key, ed25519_public_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: ['lg01a-fixture', 'owner', 'fixture-only', secret, 'not-used', 'not-used', now, now],
    });
    invalidateAdminConfigCache();
    const token = createSessionToken({
      username: 'owner', exp: Math.floor(Date.now() / 1000) + 600,
    }, secret);
    const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const base = 'http://127.0.0.1:' + addr.port;
    const call = (route: string, method = 'GET', data?: unknown, authorized = true) =>
      fetch(base + '/api' + route, {
        method, headers: authorized ? headers : { 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    const cf = (route: string, method = 'GET', data?: unknown, authorized = true) =>
      handleCloudflareApi(new Request('https://fixture.example/api' + route, {
        method, headers: authorized ? headers : { 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }), undefined);
    const json = async (response: Response) => response.json() as Promise<any>;

    assert.equal((await call('/license-groups', 'GET', undefined, false)).status, 401);
    assert.equal((await cf('/license-groups', 'GET', undefined, false)).status, 401);
    assert.equal((await call('/license-groups', 'POST', { name: '' })).status, 400);
    const create = await call('/license-groups', 'POST', { name: 'Team Alpha' });
    assert.equal(create.status, 201);
    const group = (await json(create)).group;
    assert.match(group.id, /^grp_[a-f0-9]{24}$/);
    assert.equal((await call('/license-groups', 'POST', { name: 'team alpha' })).status, 409);
    assert.equal((await call('/license-groups', 'POST', { name: 'A'.repeat(81) })).status, 400);
    const other = await cf('/license-groups', 'POST', { name: 'Client Beta' });
    assert.equal(other.status, 201);
    const cfGroup = (await json(other)).group;

    const oldCount = Number((await db.execute('SELECT COUNT(*) AS c FROM licenses')).rows[0].c);
    assert.equal((await call('/licenses/bulk', 'POST', { count: 2, group_id: 'grp_missing' })).status, 400);
    assert.equal((await cf('/licenses/bulk', 'POST', { count: 1, group_id: 'grp_missing' })).status, 400);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS c FROM licenses')).rows[0].c), oldCount);

    const assigned = await call('/licenses/bulk', 'POST', {
      count: 2, prefix: 'LGQA', group_id: group.id, backupToR2: false,
    });
    assert.equal(assigned.status, 200);
    const batch = await json(assigned);
    assert.equal(batch.count, 2);
    assert.equal(batch.keys.length, 2);
    assert.match(batch.pin, /^\d{4}$/);
    assert.equal(batch.csv.split('\n')[0], 'key,pin,tier,app_id,device_limit,validity_type,validity_value,created_at,notes');
    const rows = await db.execute({ sql: 'SELECT key, pin, group_id FROM licenses WHERE group_id = ?', args: [group.id] });
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows.every(row => row.pin === batch.pin));

    const cfAssigned = await cf('/licenses/bulk', 'POST', {
      count: 1, prefix: 'LGCF', group_id: cfGroup.id, backupToR2: false,
    });
    assert.equal(cfAssigned.status, 200);
    assert.equal((await json(cfAssigned)).keys.length, 1);

    const plain = await call('/licenses/bulk', 'POST', { count: 1, prefix: 'LGLG' });
    assert.equal(plain.status, 200);
    const legacy = await json(plain);
    assert.equal(legacy.csv.split('\n')[0], batch.csv.split('\n')[0]);
    const unassigned = await db.execute({ sql: 'SELECT group_id FROM licenses WHERE key = ?', args: [legacy.keys[0]] });
    assert.equal(unassigned.rows[0].group_id, null);

    const byGroup = await json(await call('/licenses?group_id=' + group.id + '&limit=1&offset=0'));
    assert.equal(byGroup.total, 2);
    assert.equal(byGroup.licenses.length, 1);
    assert.equal(byGroup.licenses[0].group_name, 'Team Alpha');
    assert.equal(byGroup.licenses[0].group_id, group.id);
    const byNext = await json(await call('/licenses?group_id=' + group.id + '&limit=1&offset=1'));
    assert.equal(byNext.total, 2);
    assert.equal(byNext.licenses.length, 1);
    const allUnassigned = await json(await call('/licenses?group_id=unassigned'));
    assert.equal(allUnassigned.total, 1);
    const cfFiltered = await json(await cf('/licenses?group_id=' + cfGroup.id));
    assert.equal(cfFiltered.total, 1);
    assert.equal(cfFiltered.licenses[0].group_name, 'Client Beta');
    const cfUnassigned = await json(await cf('/licenses?group_id=unassigned'));
    assert.equal(cfUnassigned.total, 1);

    assert.equal((await call('/license-groups/' + group.id, 'PATCH', { name: 'Team Renamed' })).status, 200);
    const afterRename = await json(await call('/licenses?group_id=' + group.id));
    assert.equal(afterRename.licenses[0].group_name, 'Team Renamed');
    assert.equal((await cf('/license-groups/' + cfGroup.id, 'PATCH', { name: 'Client Renamed' })).status, 200);
    assert.equal((await cf('/license-groups/' + cfGroup.id, 'PATCH', { name: 'Team Renamed' })).status, 409);

    assert.equal((await call('/license-groups/' + group.id, 'DELETE')).status, 200);
    assert.equal((await cf('/license-groups/' + cfGroup.id, 'DELETE')).status, 200);
    const groups = (await json(await call('/license-groups'))).groups;
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g: any) => g.archived_at !== null));
    assert.equal(Number(groups.find((g: any) => g.id === group.id).license_count), 2);
    assert.equal((await call('/licenses/bulk', 'POST', { count: 1, group_id: group.id })).status, 400);
    assert.equal((await cf('/licenses/bulk', 'POST', { count: 1, group_id: cfGroup.id })).status, 400);
    const afterArchive = await json(await call('/licenses?group_id=' + group.id));
    assert.equal(afterArchive.total, 2);
    assert.equal((await call('/license-groups/' + group.id, 'PATCH', { name: 'Nope' })).status, 404);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS c FROM licenses')).rows[0].c), oldCount + 4);

    // PostgreSQL migration is source-audited here; no live PostgreSQL connection or data writes.
    const postgres = readFileSync(new URL('../src/server/database/postgresSchema.ts', import.meta.url), 'utf8');
    assert.match(postgres, /version = 6/);
    assert.match(postgres, /ADD COLUMN IF NOT EXISTS group_id TEXT/);
    assert.match(postgres, /CREATE TABLE IF NOT EXISTS license_groups/);
    assert.match(postgres, /idx_licenses_group_id/);
  } finally {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
