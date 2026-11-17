import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { apiRouter } from '../src/server/api.js';
import { createSessionToken, generateEd25519KeyPair } from '../src/server/crypto.js';
import { getDbClient, initDatabaseSchema } from '../src/server/db.js';
import {
  createServerDiagnosticsRunner, defaultDiagnosticsProbes,
  type DiagnosticsProbes,
} from '../src/server/serverDiagnostics.js';

function fixture(overrides: Partial<DiagnosticsProbes> = {}): DiagnosticsProbes {
  return {
    httpStatus: async path => path === '/api/monitoring/devices?app_id=preflight' ? 401 : 200,
    wsUnauthStatus: async () => 401,
    wsEnabled: () => true,
    now: () => Date.now(),
    ...overrides,
  };
}

test('SD-01: fixed read-only probes pass without license/device writes, report stays bounded and sanitized', async () => {
  const paths: string[] = [];
  const run = createServerDiagnosticsRunner(fixture({
    httpStatus: async path => { paths.push(path); return path.includes('monitoring') ? 401 : 200; },
  }));
  const result = await run();
  assert.equal(result.status, 200);
  if (result.status !== 200) throw Error('unexpected status');
  assert.deepEqual(paths, [
    '/api/health', '/api/ready', '/api/monitoring/devices?app_id=preflight',
  ]);
  assert.deepEqual(result.report.summary, { pass: 4, fail: 0, warn: 0, skipped: 0 });
  assert.deepEqual(result.report.checks.map(c => c.id),
    ['api_health', 'api_ready', 'monitor_auth', 'admin_ws_auth']);
  assert.doesNotMatch(JSON.stringify(result), /cookie|session|bearer|token|private.key|hwid|license_key/i);
  await assert.rejects(defaultDiagnosticsProbes.httpStatus('https://untrusted.invalid', 1),
    /Unapproved diagnostic path/);
});

test('SD-01: unexpected status, timeout and disabled WSS are labeled FAIL/SKIPPED, never PASS', async () => {
  const result = await createServerDiagnosticsRunner(fixture({
    httpStatus: async path => path === '/api/ready' ? 503 :
      path.includes('monitoring') ? 200 : 200,
    wsEnabled: () => false,
  }))();
  assert.equal(result.status, 200);
  if (result.status !== 200) throw Error('unexpected status');
  assert.deepEqual(result.report.checks.map(c => c.state),
    ['PASS', 'FAIL', 'FAIL', 'SKIPPED']);
  assert.equal(result.report.summary.pass, 1);
  assert.equal(result.report.summary.fail, 2);
  assert.equal(result.report.summary.skipped, 1);
  const failing = await createServerDiagnosticsRunner(fixture({
    httpStatus: async () => { throw Error('sensitive-url or SECRET-PRIVATE'); },
    wsUnauthStatus: async () => 0,
  }))();
  assert.equal(failing.status, 200);
  if (failing.status !== 200) throw Error('unexpected status');
  assert.equal(failing.report.summary.fail, 4);
  assert.doesNotMatch(JSON.stringify(failing), /sensitive-url|SECRET-PRIVATE/);
});

test('SD-01: a hung probe times out safely and later checks still complete', async () => {
  const start = Date.now();
  const result = await createServerDiagnosticsRunner(fixture({
    httpStatus: path => path === '/api/health' ? new Promise<number>(() => {}) :
      Promise.resolve(path.includes('monitoring') ? 401 : 200),
    wsEnabled: () => false,
  }))();
  assert.equal(result.status, 200);
  if (result.status !== 200) throw Error('unexpected status');
  assert.deepEqual(result.report.checks.map(c => c.state),
    ['FAIL', 'PASS', 'PASS', 'SKIPPED']);
  assert.match(result.report.checks[0].detail, /timed out/);
  assert.ok(Date.now() - start < 6000, 'hung probe must not block the runner');
});

test('SD-01: concurrent requests conflict and global cooldown prevents repeated probes', async () => {
  let release: (value: number) => void = () => {};
  const pending = new Promise<number>(resolve => { release = resolve; });
  let t = 20_000;
  const run = createServerDiagnosticsRunner(fixture({
    now: () => t,
    httpStatus: async () => pending,
    wsEnabled: () => false,
  }));
  const first = run();
  assert.deepEqual(await run(), { status: 409, error: 'DIAGNOSTICS_BUSY' });
  release(200);
  const result = await first;
  assert.equal(result.status, 200);
  assert.deepEqual(await run(), { status: 429, error: 'DIAGNOSTICS_COOLDOWN' });
  t += 10_001;
  assert.equal((await run()).status, 200);
});

test('SD-01: real Admin route enforces missing/expired auth and CSRF without mutating schema', async () => {
  const keys = ['NODE_ENV', 'DATABASE_PROVIDER', 'DATABASE_URL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PROVIDER = 'libsql';
  process.env.DATABASE_URL = 'file::memory:';
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const db = getDbClient();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await initDatabaseSchema();
    const now = Date.now();
    const signed = generateEd25519KeyPair();
    await db.execute({
      sql: 'INSERT INTO admin_config (id,username,password_hash,jwt_secret,ed25519_private_key,ed25519_public_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      args: ['sd01-admin', 'owner', 'placeholder', 'sd01-session-secret', signed.privateKeyPem, signed.publicKeyPem, now, now],
    });
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    const url = 'http://127.0.0.1:' + address.port + '/api/admin/server-diagnostics/run';
    const expired = createSessionToken({
      username: 'owner', exp: Math.floor(now / 1000) - 60,
    }, 'sd01-session-secret');
    const valid = createSessionToken({
      username: 'owner', exp: Math.floor(now / 1000) + 1800,
    }, 'sd01-session-secret');
    const post = (headers: Record<string, string> = {}, body = '{}') =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await post()).status, 401);
    assert.equal((await post({ authorization: 'Bearer ' + expired })).status, 401);
    assert.equal((await post({ cookie: 'vcon_admin_session=' + valid })).status, 403);
    const invalid = await post({ authorization: 'Bearer ' + valid },
      '{"url":"https://evil.example/ssrf"}');
    assert.equal(invalid.status, 400);
    const success = await post({ authorization: 'Bearer ' + valid });
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('cache-control'), 'no-store');
    const payload = await success.json() as { checks: { id: string }[] };
    assert.deepEqual(payload.checks.map(c => c.id),
      ['api_health', 'api_ready', 'monitor_auth', 'admin_ws_auth']);
    const cooldown = await post({ authorization: 'Bearer ' + valid });
    assert.equal(cooldown.status, 429);
  } finally {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    if ('close' in db) await db.close();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
