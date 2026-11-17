import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import express from "express";
import { apiRouter } from "../src/server/api.js";
import { createSessionToken, generateEd25519KeyPair } from "../src/server/crypto.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { registerRealtimePresence, setRealtimePresenceEnabled } from "../src/server/realtime/presence.js";
import type { MonitoringDevicesResponse } from "../src/types.js";

class StubSocket extends EventEmitter {
  readyState = 1;
  close() { this.readyState = 3; this.emit("close"); }
}

test("LM-P03: real read-only admin HTTP endpoint scopes, paginates, redacts and preserves existing contracts", async () => {
  const keys = ["NODE_ENV", "DATABASE_PROVIDER", "DATABASE_URL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PROVIDER = "libsql";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  setRealtimePresenceEnabled(false);

  const db = getDbClient();
  let http: ReturnType<typeof createServer> | undefined;
  const socket = new StubSocket();
  try {
    await initDatabaseSchema();
    const now = Date.now();
    const signature = generateEd25519KeyPair();
    await db.execute({
      sql: "INSERT INTO admin_config (id,username,password_hash,jwt_secret,ed25519_private_key,ed25519_public_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      args: ["lm03-owner", "owner", "placeholder", "test-admin-key", signature.privateKeyPem, signature.publicKeyPem, now, now],
    });
    for (const [id, status] of [["app-a", "active"], ["app-b", "active"], ["app-off", "inactive"]]) {
      await db.execute({
        sql: "INSERT INTO apps (id,app_slug,display_name,status,app_secret,device_lease_seconds,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        args: [id, id, id, status, "very-private-app-secret", 7200, now, now],
      });
    }
    for (const [licenseId, appId, expired] of [
      ["lic-a", "app-a", false],
      ["lic-b", "app-b", false],
      ["lic-expired", "app-a", true],
      ["lic-off", "app-off", false],
    ] as const) {
      await db.execute({
        sql: "INSERT INTO licenses (id,key,status,app_id,device_limit,validity_type,validity_value,activated_at,expires_at,created_at) VALUES (?,?,'active',?,500,'lifetime',0,?,?,?)",
        args: [licenseId, "PRIVATE-LICENSE-" + licenseId, appId, now,
          expired ? now - 1000 : null, now],
      });
    }

    // The real SQLite-compatible database, with >100 devices and nontrivial page offsets.
    const count = 128;
    const rows = Array.from({ length: count }, () => "(?,?,?,?,?,?,'active')").join(",");
    const args: Array<string | number> = [];
    for (let i = 0; i < count; i++) {
      const id = "dev-a-" + String(i).padStart(3, "0");
      args.push(id, "lic-a", "SENSITIVE-HWID-" + i, "Computer " + i, now, now + i);
    }
    await db.execute({
      sql: "INSERT INTO devices (id,license_id,hwid,device_name,first_bound_at,last_ping_at,status) VALUES " + rows,
      args,
    });
    const single = async (
      id: string, licenseId: string, state: "active" | "blocked", lastPing: number,
    ) => db.execute({
      sql: "INSERT INTO devices (id,license_id,hwid,device_name,ip_address,first_bound_at,last_ping_at,status) VALUES (?,?,?,?,?,?,?,?)",
      args: [id, licenseId, "SECRET-HWID-" + id, "PC " + id,
        "203.0.113.100", now, lastPing, state],
    });
    await single("dev-old", "lic-a", "active", now - 9_000_000);
    await single("dev-unknown", "lic-a", "active", 0);
    await single("dev-blocked", "lic-a", "blocked", now);
    await single("dev-expired", "lic-expired", "active", now);
    await single("dev-other", "lic-b", "active", now);
    await single("dev-inactive", "lic-off", "active", now);

    setRealtimePresenceEnabled(true);
    registerRealtimePresence("monitor-c1", {
      appId: "app-a", licenseId: "lic-a", deviceId: "dev-a-127",
      hwid: "SECRET-HWID-127", authenticatedAt: now,
    }, socket);

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    http = createServer(app);
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw Error("Test listener unavailable");
    const base = "http://127.0.0.1:" + address.port;
    const token = "Bearer " + createSessionToken({
      username: "owner", exp: Math.floor(now / 1000) + 1800,
    }, "test-admin-key");
    const headers = { authorization: token };
    const route = "/api/monitoring/devices";

    const noAuth = await fetch(base + route + "?app_id=app-a");
    assert.equal(noAuth.status, 401);
    const invalidAuth = await fetch(base + route + "?app_id=app-a",
      { headers: { authorization: "Bearer nonsense" } });
    assert.equal(invalidAuth.status, 401);

    const invalid = [
      "", "?limit=25", "?app_id=bad%20id", "?app_id=app-a&limit=26",
      "?app_id=app-a&limit=0", "?app_id=app-a&offset=-1",
      "?app_id=app-a&offset=1000001", "?app_id=app-a&offset=999999999999999999",
      "?app_id=app-a&limit=1.5", "?app_id=app-a&limit=3&limit=4",
      "?app_id=app-a&offset=0&offset=1", "?app_id=app-a%2F..%2Fapp-b",
    ];
    for (const query of invalid) {
      const res = await fetch(base + route + query, { headers });
      assert.equal(res.status, 400, "invalid monitoring filter " + query);
      assert.equal((await res.json() as { code: string }).code, "INVALID_MONITORING_DEVICE_FILTER");
    }

    const firstResponse = await fetch(base + route + "?app_id=app-a&limit=25&offset=0", { headers });
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("cache-control"), "no-store");
    const first = await firstResponse.json() as MonitoringDevicesResponse;
    assert.equal(first.appId, "app-a");
    assert.equal(first.total, 130);
    assert.equal(first.devices.length, 25);
    assert.equal(first.limit, 25);
    assert.equal(first.offset, 0);
    assert.ok(first.observedAt > 0);
    assert.deepEqual(Object.keys(first.devices[0]).sort(), [
      "deviceName", "id", "lastPingAt", "leaseSignal", "wsConnected",
    ].sort());
    assert.ok(first.devices.every(row => row.id.startsWith("dev-a-")));
    assert.equal(first.devices[0].wsConnected, true);
    assert.equal(first.devices[0].leaseSignal, "recent");
    assert.doesNotMatch(JSON.stringify(first), /SENSITIVE-HWID|SECRET-HWID|PRIVATE-LICENSE|203\.0\.113\.100|very-private-app-secret|app-b/i);

    const offsets = [25, 50, 75, 100, 125, 150];
    const lengths = [25, 25, 25, 25, 5, 0];
    for (let i = 0; i < offsets.length; i++) {
      const res = await fetch(base + route + "?app_id=app-a&limit=25&offset=" + offsets[i], { headers });
      assert.equal(res.status, 200);
      const page = await res.json() as MonitoringDevicesResponse;
      assert.equal(page.total, 130);
      assert.equal(page.devices.length, lengths[i]);
      assert.ok(page.devices.every(row => row.id !== "dev-other" && row.id !== "dev-expired" &&
        row.id !== "dev-blocked"));
      if (offsets[i] === 125) {
        assert.equal(page.devices.find(row => row.id === "dev-old")?.leaseSignal, "stale");
        assert.equal(page.devices.find(row => row.id === "dev-unknown")?.leaseSignal, "unknown");
      }
    }
    const otherResponse = await fetch(base + route + "?app_id=app-b", { headers });
    assert.equal(otherResponse.status, 200);
    const other = await otherResponse.json() as MonitoringDevicesResponse;
    assert.equal(other.total, 1);
    assert.deepEqual(other.devices.map(row => row.id), ["dev-other"]);
    assert.equal(other.devices[0].wsConnected, false, "valid WSS snapshot distinguishes no WS");
    assert.equal((await fetch(base + route + "?app_id=app-off", { headers })).status, 200);
    const inactive = await (await fetch(base + route + "?app_id=app-off", { headers })).json() as MonitoringDevicesResponse;
    assert.equal(inactive.total, 0);
    assert.deepEqual(inactive.devices, []);

    // Transport OFF is unknown rather than confirmed disconnected; heartbeat still independent.
    setRealtimePresenceEnabled(false);
    const disabled = await (await fetch(base + route + "?app_id=app-a&limit=1", { headers })).json() as MonitoringDevicesResponse;
    assert.equal(disabled.devices[0].wsConnected, null);
    assert.equal(disabled.devices[0].leaseSignal, "recent");

    // Legacy Admin endpoints are unchanged and retain their original response contracts.
    const presence = await fetch(base + "/api/realtime/presence?app_id=app-b", { headers });
    assert.equal(presence.status, 200);
    const legacy = await fetch(base + "/api/devices?limit=1&offset=0", { headers });
    assert.equal(legacy.status, 200);
    const legacyData = await legacy.json() as { devices: Array<{ hwid: string }> };
    assert.equal(typeof legacyData.devices[0].hwid, "string");
    const serverCode = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
    assert.match(serverCode, /res\.status\(503\)\.json\(\{ code: "MONITORING_DEVICES_UNAVAILABLE" \}\)/);
    assert.match(serverCode, /"\/monitoring\/devices",\s*requireAdminAuth/);
  } finally {
    setRealtimePresenceEnabled(false);
    if (http?.listening) await new Promise<void>(resolve => http!.close(() => resolve()));
    await db.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


/**
 * LM-RG01: only the disposable GitHub-Compose PostgreSQL identity is accepted.
 * This separate process runs after synthetic browser bootstrap. Never point at
 * a developer's PostgreSQL or a real VPS, even when someone sets the env flag.
 */
test("LM-RG01: disposable PostgreSQL monitoring endpoint enforces auth, paging, isolation and safe 503", {
  skip: process.env.LM_RG01_PG_ONLY !== "1",
}, async () => {
  const uri = process.env.DATABASE_URL ?? "";
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw Error("Missing CI-only PostgreSQL URL"); }
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.LICENX_ADMIN_E2E_CI !== "1" ||
      !/^licenx_admin_ci_[0-9]+$/.test(process.env.COMPOSE_PROJECT_NAME ?? "") ||
      process.env.DATABASE_PROVIDER !== "postgres" ||
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "postgres" || parsed.port !== "5432" ||
      parsed.pathname !== "/licenx_ci") {
    throw Error("Refusing LM-RG01 database test outside disposable CI PostgreSQL");
  }

  const db = getDbClient();
  let http: ReturnType<typeof createServer> | undefined;
  setRealtimePresenceEnabled(false);
  try {
    // Real server state from the CI-owned PostgreSQL instance; never modify fixture rows.
    const config = await db.execute("SELECT username, jwt_secret FROM admin_config LIMIT 1");
    assert.equal(config.rows.length, 1, "Browser setup must have initialized CI admin");
    const username = String(config.rows[0].username);
    const secret = String(config.rows[0].jwt_secret);
    const ts = Math.floor(Date.now() / 1000);
    const valid = createSessionToken({ username, exp: ts + 600 }, secret);
    const expired = createSessionToken({ username, exp: ts - 60 }, secret);
    const header = { authorization: "Bearer " + valid };
    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    http = createServer(app);
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw Error("No CI listener");
    const base = "http://127.0.0.1:" + address.port;
    const uriFor = (query: string) => base + "/api/monitoring/devices" + query;

    assert.equal((await fetch(uriFor("?app_id=ci_e2e_app_a"))).status, 401);
    assert.equal((await fetch(uriFor("?app_id=ci_e2e_app_a"), {
      headers: { authorization: "Bearer " + expired },
    })).status, 401, "expired admin token must be rejected");
    assert.equal((await fetch(uriFor("?app_id=ci_e2e_app_a&limit=26"), { headers: header })).status, 400);
    assert.equal((await fetch(uriFor("?app_id=ci_e2e_app_a&offset=-1"), { headers: header })).status, 400);
    assert.equal((await fetch(uriFor("?app_id=ci_e2e_app_a%2F..%2Fci_e2e_app_b"), { headers: header })).status, 400);

    const first = await fetch(uriFor("?app_id=ci_e2e_app_a&limit=25&offset=0"), { headers: header });
    assert.equal(first.status, 200, "PostgreSQL must execute the actual app-scoped SQL");
    assert.equal(first.headers.get("cache-control"), "no-store");
    const firstData = await first.json() as MonitoringDevicesResponse;
    assert.equal(firstData.total, 149);
    assert.equal(firstData.devices.length, 25);
    assert.ok(firstData.devices.every(row => row.id.startsWith("ci_e2e_device_") &&
      row.id !== "ci_e2e_device_149"));
    assert.deepEqual(Object.keys(firstData.devices[0]).sort(),
      ["deviceName", "id", "lastPingAt", "wsConnected", "leaseSignal"].sort());
    assert.doesNotMatch(JSON.stringify(firstData),
      /ci-e2e-hwid|CI-E2E-LICENSE|ci-only-no-real-key|password|token|ip_address/i);

    for (const [offset, count] of [[25, 25], [50, 25], [75, 25], [100, 25], [125, 24], [150, 0]]) {
      const response = await fetch(uriFor("?app_id=ci_e2e_app_a&limit=25&offset=" + offset), { headers: header });
      assert.equal(response.status, 200);
      const data = await response.json() as MonitoringDevicesResponse;
      assert.equal(data.total, 149);
      assert.equal(data.devices.length, count);
      assert.ok(data.devices.every(row => row.id !== "ci_e2e_device_149"));
    }
    const b = await fetch(uriFor("?app_id=ci_e2e_app_b"), { headers: header });
    assert.equal(b.status, 200);
    const second = await b.json() as MonitoringDevicesResponse;
    assert.equal(second.total, 1);
    assert.deepEqual(second.devices.map(row => row.id), ["ci_e2e_device_149"]);
    const empty = await fetch(uriFor("?app_id=ci_e2e_app_000"), { headers: header });
    assert.equal(empty.status, 200);
    assert.equal((await empty.json() as MonitoringDevicesResponse).total, 0);
    assert.equal(firstData.devices[0].wsConnected, null, "disabled SDK transport must report WS Unknown");
    assert.equal(firstData.devices[0].leaseSignal, "recent");

    // Deterministic test-only failure injection, isolated to this process and query.
    // Admin authentication uses a different SELECT; no DB, schema, container or credential mutation.
    const mutable = db as unknown as { execute: (...args: any[]) => Promise<any> };
    const original = mutable.execute;
    mutable.execute = async (...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : String(args[0]?.sql ?? "");
      if (sql.startsWith("SELECT COUNT(*) AS total FROM devices d JOIN licenses l")) {
        throw Error("DISPOSABLE_CI_MONITORING_QUERY_FAILURE");
      }
      return original.apply(db, args);
    };
    try {
      const failure = await fetch(uriFor("?app_id=ci_e2e_app_a"), { headers: header });
      assert.equal(failure.status, 503);
      assert.deepEqual(await failure.json(), { code: "MONITORING_DEVICES_UNAVAILABLE" });
    } finally {
      mutable.execute = original;
    }
    const legacyPresence = await fetch(base + "/api/realtime/presence?app_id=ci_e2e_app_b", { headers: header });
    assert.equal(legacyPresence.status, 200);
    const legacyDevices = await fetch(base + "/api/devices?limit=1", { headers: header });
    assert.equal(legacyDevices.status, 200);
    assert.ok(Array.isArray((await legacyDevices.json() as { devices: unknown[] }).devices));
  } finally {
    setRealtimePresenceEnabled(false);
    if (http?.listening) await new Promise<void>(resolve => http!.close(() => resolve()));
    await db.close();
  }
});
