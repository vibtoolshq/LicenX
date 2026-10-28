import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { apiRouter, invalidateAdminConfigCache } from "../src/server/api.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { PostgresClient } from "../src/server/database/postgres.js";
import { migratePostgres } from "../src/server/database/postgresSchema.js";
import { bindDeviceWithinLimit } from "../src/server/deviceBinding.js";
import { getAdminLoginRateLimit, recordFailedAdminLoginAttempt } from "../src/server/adminLoginRateLimit.js";
import { getUserControlPinRateLimit, recordFailedUserControlPinAttempt } from "../src/server/userControlRateLimit.js";
import type { AddressInfo } from "node:net";
import { createSessionToken } from "../src/server/crypto.js";

const url = process.env.LICENX_TEST_POSTGRES_URL;
const integration = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
let db: PostgresClient;
let server: Server;
let baseUrl: string;
const original = { ...process.env };

before(async () => {
  if (!url) return;
  // Only use a dedicated disposable test database; never the application's DATABASE_URL.
  if (!new URL(url).pathname.slice(1).startsWith("licenx_test_")) throw new Error("Disposable licenx_test_ database required");
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PROVIDER = "postgres";
  process.env.DATABASE_URL = url;
  delete process.env.TURSO_DATABASE_URL;
  db = getDbClient() as PostgresClient;
  await Promise.all([initDatabaseSchema(), initDatabaseSchema()]);
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

beforeEach(async () => {
  if (!url) return;
  invalidateAdminConfigCache();
  for (const table of ["devices", "validation_logs", "licenses", "apps", "admin_api_keys", "admin_config", "admin_login_attempts", "user_control_pin_attempts", "r2_backups"]) {
    await db.execute(`DELETE FROM ${table}`);
  }
});

after(async () => {
  if (!url) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) await db.close();
  for (const key of ["NODE_ENV", "DATABASE_PROVIDER", "DATABASE_URL", "TURSO_DATABASE_URL"]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

async function request(path: string, body?: object, token?: string, method = body ? "POST" : "GET") {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function license(deviceLimit = 1) {
  await db.execute({
    sql: "INSERT INTO licenses (id, key, device_limit, validity_type, validity_value, created_at) VALUES ('license', 'PG-TEST-KEY', ?, 'hourly', 1, ?)",
    args: [deviceLimit, Date.now()],
  });
}

function bind(index: number, now = Date.now()) {
  return bindDeviceWithinLimit({ db, licenseId: "license", hwid: `hwid-${index}`, deviceId: `dev-${index}`, deviceName: "Test", osInfo: "fixture", ipAddress: "127.0.0.1", now, deviceLimit: 1, rejectBlocked: true, activateLicense: true });
}

integration("real PostgreSQL serializes migration reruns and maps safe integers/search/affected rows", async () => {
  const other = new PostgresClient(url!);
  try { await Promise.all([migratePostgres(db), migratePostgres(other)]); } finally { await other.close(); }
  assert.equal((await db.execute("SELECT COUNT(*) AS count FROM licenx_schema_migrations")).rows[0].count, 1);
  await license();
  const found = await db.execute({ sql: "SELECT * FROM licenses WHERE key LIKE ?", args: ["%pg-test%"] });
  assert.equal(found.rows.length, 1);
  assert.equal(typeof found.rows[0].created_at, "number");
  assert.doesNotThrow(() => JSON.stringify(found.rows));
  assert.equal((await db.execute("UPDATE licenses SET tier = 'Pro' WHERE id = 'license'")).rowsAffected, 1);
  await assert.rejects(db.execute("SELECT 9007199254740992::bigint AS unsafe"), RangeError);
});

integration("real PostgreSQL batch failure and abandoned transactions roll back without leaking a connection", async () => {
  await assert.rejects(db.batch([
    "INSERT INTO r2_backups (id, filename, record_count, file_size, created_at) VALUES ('a', 'a', 1, 2, 3)",
    "INSERT INTO missing_table VALUES (1)",
  ]));
  assert.equal((await db.execute("SELECT COUNT(*) AS count FROM r2_backups")).rows[0].count, 0);
  const transaction = await db.transaction();
  await transaction.execute("INSERT INTO r2_backups (id, filename, record_count, file_size, created_at) VALUES ('b', 'b', 1, 2, 3)");
  transaction.close();
  assert.equal((await db.execute("SELECT COUNT(*) AS count FROM r2_backups")).rows[0].count, 0);
  const readOnly = await db.transaction("read");
  await assert.rejects(readOnly.execute("DELETE FROM r2_backups"));
  await readOnly.rollback();
  assert.equal((await db.execute("SELECT 1 AS ok")).rows[0].ok, 1);
});

integration("real concurrent PostgreSQL binds never exceed the device limit or restart activation", async () => {
  await license();
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => bind(i)));
  assert.equal(results.filter((result) => result.status === "bound").length, 1);
  assert.equal(results.filter((result) => result.status === "limit").length, 15);
  const first = (await db.execute("SELECT activated_at, expires_at FROM licenses WHERE id = 'license'")).rows[0];
  assert.equal(Number(first.expires_at) - Number(first.activated_at), 3_600_000);
  await db.execute("UPDATE devices SET status = 'logged_out'");
  assert.equal((await bind(99, Date.now() + 10_000)).status, "bound");
  assert.deepEqual((await db.execute("SELECT activated_at, expires_at FROM licenses WHERE id = 'license'")).rows[0], first);
});

integration("rejected first activation and failed binding leave PostgreSQL activation untouched", async () => {
  await license();
  await db.execute("INSERT INTO devices (id, license_id, hwid, first_bound_at, last_ping_at, status) VALUES ('blocked', 'license', 'hwid-0', 1, 1, 'blocked')");
  assert.equal((await bind(0)).status, "blocked");
  assert.equal((await db.execute("SELECT activated_at FROM licenses")).rows[0].activated_at, null);
  await db.execute({ sql: "UPDATE devices SET status = 'active', last_ping_at = ?", args: [Date.now()] });
  assert.equal((await bind(1)).status, "limit");
  assert.equal((await db.execute("SELECT activated_at FROM licenses")).rows[0].activated_at, null);
  await db.execute("DELETE FROM devices");
  await assert.rejects(bindDeviceWithinLimit({ db, licenseId: "missing", hwid: "bad", deviceId: "bad", deviceName: "bad", osInfo: "test", ipAddress: "127.0.0.1", now: Date.now(), deviceLimit: 1, rejectBlocked: true, activateLicense: true }));
  assert.equal((await db.execute("SELECT COUNT(*) AS count FROM devices")).rows[0].count, 0);
});

integration("PostgreSQL concurrent PIN and admin failures enforce database-backed rate limits", async () => {
  const now = Date.now();
  await Promise.all(Array.from({ length: 12 }, () => recordFailedAdminLoginAttempt(db, "attempt", now)));
  assert.equal((await getAdminLoginRateLimit(db, "attempt", now)).blocked, true);
  await Promise.all(Array.from({ length: 12 }, () => recordFailedUserControlPinAttempt(db, "key", "127.0.0.1", now)));
  assert.equal((await getUserControlPinRateLimit(db, "key", "127.0.0.1", now)).blocked, true);
});

integration("PostgreSQL Node API supports fresh setup/login and a signed validation-ping-logout lifecycle", async () => {
  assert.equal((await request("/setup/status")).body.initialized, false);
  const setup = await request("/setup/init", { username: "pg-admin", password: "fixture-password-2026" });
  assert.equal(setup.status, 200);
  assert.equal((await request("/setup/status")).body.initialized, true);
  const login = await request("/auth/login", { username: "pg-admin", password: "fixture-password-2026" });
  assert.equal(login.status, 200);
  const config = (await db.execute("SELECT jwt_secret FROM admin_config")).rows[0];
  const token = createSessionToken({ username: "pg-admin", exp: Math.floor(Date.now() / 1000) + 60 }, String(config.jwt_secret));
  assert.equal((await request("/apps", { app_slug: "pg-demo", display_name: "PG Demo" }, token)).status, 200);
  assert.equal((await request("/apps?search=DEMO", undefined, token)).body.total, 1);
  assert.equal((await request("/admin-api-keys", { name: "PG Fixture" }, token)).status, 201);
  assert.equal((await request("/admin-api-keys", undefined, token)).status, 200);
  await license();
  const validation = await request("/v1/license/validate", { license_key: "PG-TEST-KEY", hwid: "api-hwid" });
  assert.equal(validation.status, 200);
  assert.equal(typeof validation.body.signature, "string");
  assert.equal(typeof validation.body.activated_at, "number");
  assert.equal((await request("/v1/license/ping", { license_key: "PG-TEST-KEY", hwid: "api-hwid" })).status, 200);
  assert.equal((await request("/v1/license/logout", { license_key: "PG-TEST-KEY", hwid: "api-hwid" })).status, 200);
  assert.equal((await request("/v1/license/ping", { license_key: "PG-TEST-KEY", hwid: "api-hwid" })).status, 403);
  assert.equal((await request("/licenses?search=pg-test", undefined, token)).status, 200);
  assert.equal((await request("/stats", undefined, token)).status, 200);
  assert.equal((await request("/logs", undefined, token)).status, 200);
});
