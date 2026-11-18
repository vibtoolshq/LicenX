import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptDeviceStats, DeviceStatsError, getLicenseDeviceStats,
  issueDeviceStatsSession, normalizeDeviceStats, refreshDeviceStatsSession,
} from "../src/server/deviceStats.js";
import type { DatabaseExecutor } from "../src/server/database/contracts.js";

test("SDK-STAT-01 rejects nested, unsafe, oversized, non-finite and secret-like statistics", () => {
  assert.deepEqual({ ...normalizeDeviceStats({ Total: 5000, "Current Task": "Running", Failed: 0, Enabled: true }) },
    { Total: 5000, "Current Task": "Running", Failed: 0, Enabled: true });
  for (const input of [{}, [], { Nested: { count: 1 } }, { Arr: [1] },
    { "private_token": "oops" }, { Bad: Infinity }, { Unsafe: Number.MAX_SAFE_INTEGER + 1 },
    Object.fromEntries(Array.from({ length: 41 }, (_, i) => ["key_" + i, i])),
    { A: "A".repeat(4100) }, { "__proto__": 1, constructor: "bad" }]) {
    assert.throws(() => normalizeDeviceStats(input), DeviceStatsError);
  }
});

class FakeStatsDb implements DatabaseExecutor {
  tokenHash = "";
  expiry = 0;
  reported = 0;
  stats = "{}";
  licenseId = "lic-a";
  deviceId = "dev-a";
  active = true;
  async execute(statement: string | {sql: string; args: any[]}, _args?: any): Promise<any> {
    const sql = typeof statement === "string" ? statement : statement.sql;
    const args = typeof statement === "string" ? _args : statement.args;
    if (sql.includes("INSERT INTO device_stat_snapshots")) {
      this.tokenHash = args[1]; this.expiry = args[2]; return { rows: [], rowsAffected: 1 };
    }
    if (sql.includes("FROM device_stat_snapshots s") && sql.includes("WHERE s.report_token_hash")) {
      const matched = args[0] === this.tokenHash && this.active;
      return { rows: matched ? [{
        device_id: this.deviceId, report_token_hash: this.tokenHash,
        report_token_expires: this.expiry, reported_at: this.reported,
        device_status: "active", last_ping_at: Date.now(), license_status: "active",
        expires_at: null, app_id: "app-a", app_status: "active", device_lease_seconds: 7200,
      }] : [], rowsAffected: 0 };
    }
    if (sql.includes("UPDATE device_stat_snapshots") && sql.includes("SET report_token_hash =")) {
      if (!this.active || args[2] !== this.deviceId || args[3] !== this.tokenHash ||
          this.expiry <= args[4]) return { rows: [], rowsAffected: 0 };
      this.tokenHash = args[0]; this.expiry = args[1];
      return { rows: [{device_id: this.deviceId}], rowsAffected: 1 };
    }
    if (sql.includes("UPDATE device_stat_snapshots")) {
      if (args[2] !== this.deviceId || args[3] !== this.tokenHash || !this.active ||
          this.reported > args[5]) return { rows: [], rowsAffected: 0 };
      this.stats=args[0]; this.reported=args[1]; return { rows: [], rowsAffected: 1 };
    }
    if (sql.includes("FROM device_stat_snapshots s JOIN devices d")) {
      return { rows: [{ device_id: this.deviceId, stats_json: this.stats,
        reported_at: this.reported, status: this.active ? "active" : "logged_out" }], rowsAffected: 0 };
    }
    throw Error("Unexpected query: " + sql.slice(0,80));
  }
}

test("SDK-STAT-01 report-only token is random, hashed at rest, device-scoped, revocable and rate-limited", async () => {
  const db = new FakeStatsDb();
  const now = Date.now();
  const token = await issueDeviceStatsSession(db, "dev-a", now);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(db.tokenHash.includes(token), false);
  assert.equal(db.tokenHash.length, 64);
  await acceptDeviceStats(db, token, { Sent: 1, Failed: 3 }, now + 1);
  assert.deepEqual(JSON.parse(db.stats), { Sent: 1, Failed: 3 });
  assert.equal((await getLicenseDeviceStats(db, "lic-a"))[0].stats.Sent, 1);
  await assert.rejects(acceptDeviceStats(db, token, { Sent: 2 }, now + 2),
    (e: unknown) => e instanceof DeviceStatsError && e.status === 429);
  await assert.rejects(acceptDeviceStats(db, "A".repeat(43), { Sent: 2 }, now + 5000),
    (e: unknown) => e instanceof DeviceStatsError && e.status === 401);
  db.active = false;
  await assert.rejects(acceptDeviceStats(db, token, { Sent: 2 }, now + 5000),
    (e: unknown) => e instanceof DeviceStatsError && e.status === 401);
  db.active = true;
  assert.equal(await refreshDeviceStatsSession(db, "dev-a", undefined, now+6000), undefined,
    "public key/HWID heartbeat cannot mint a reporter token");
  const rotated = await refreshDeviceStatsSession(db, "dev-a", token, now + 6000);
  assert.match(rotated ?? "", /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(acceptDeviceStats(db, token, { Sent: 2 }, now + 9000),
    (e: unknown) => e instanceof DeviceStatsError && e.status === 401);
});
