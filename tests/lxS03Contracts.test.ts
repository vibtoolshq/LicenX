import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseClient, DatabaseTransaction } from "../src/server/database/contracts.js";
import { bindDeviceWithinLimit } from "../src/server/deviceBinding.js";
import {
  activateDeviceLogoutProof, invalidateDeviceLogoutProof, prepareDeviceLogoutProof,
  restoreDeviceLogoutProof, takeDeviceLogoutProof,
} from "../src/server/realtime/logoutProof.js";

function mockDb() {
  const actions: string[] = [];
  const transaction = {
    lockLicense: async () => { actions.push("lock"); },
    execute: async (statement: any) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.startsWith("SELECT id, status FROM devices")) return { rows: [], rowsAffected: 0 };
      if (sql.startsWith("SELECT COUNT(*) AS active_count")) return { rows: [{ active_count: 0 }], rowsAffected: 0 };
      if (sql.startsWith("SELECT") && sql.includes("license_id")) return { rows: [], rowsAffected: 0 };
      actions.push(sql.startsWith("INSERT INTO validation_logs") ? "audit" : sql.startsWith("INSERT INTO devices") ? "insert" : "update");
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => { actions.push("commit"); },
    rollback: async () => { actions.push("rollback"); },
    close: () => { actions.push("close"); },
  } as unknown as DatabaseTransaction;
  const db = { transaction: async () => transaction } as unknown as DatabaseClient;
  return { actions, db, transaction };
}
const params = (db: DatabaseClient) => ({
  db, licenseId: "test-license", hwid: "TEST-HWID", deviceId: "dev-test",
  deviceName: "test", osInfo: "test", ipAddress: "127.0.0.1",
  now: Date.now(), deviceLimit: 1, rejectBlocked: true as const,
});
test("LX-S03: signed response or audit failure rolls back new device binding", async () => {
  const {db, actions} = mockDb();
  await assert.rejects(bindDeviceWithinLimit({
    ...params(db),
    finalizeBound: async () => { throw new Error("synthetic signer failed"); },
  }), /synthetic signer failed/);
  assert.ok(actions.includes("insert"));
  assert.ok(actions.includes("rollback"));
  assert.ok(!actions.includes("commit"));
});
test("LX-S03: success audit is written before binding commit", async () => {
  const {db,actions} = mockDb();
  const bound = await bindDeviceWithinLimit({
    ...params(db),
    finalizeBound: async (result,tx) => {
      assert.equal(result.boundDevicesCount,1);
      await tx.execute({sql:"INSERT INTO validation_logs VALUES (?)",args:["test-log"]});
    },
  });
  assert.equal(bound.status,"bound");
  assert.ok(actions.indexOf("audit") >= 0);
  assert.ok(actions.indexOf("audit") < actions.indexOf("commit"));
});
test("LX-S03: opt-in logout bearer is single use, device scoped and superseded at login", () => {
  const token = prepareDeviceLogoutProof();
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(takeDeviceLogoutProof(token),null);
  activateDeviceLogoutProof(token,"dev-A","lic-A","hw-A");
  assert.equal(takeDeviceLogoutProof("BAD"),null);
  assert.deepEqual(takeDeviceLogoutProof(token)?.deviceId,"dev-A");
  assert.equal(takeDeviceLogoutProof(token),null);
  const old = prepareDeviceLogoutProof();
  const next = prepareDeviceLogoutProof();
  activateDeviceLogoutProof(old,"dev-A","lic-A","hw-A");
  activateDeviceLogoutProof(next,"dev-B","lic-A","hw-A");
  assert.equal(takeDeviceLogoutProof(old),null);
  assert.equal(takeDeviceLogoutProof(next)?.deviceId,"dev-B");
  const fresh = prepareDeviceLogoutProof();
  activateDeviceLogoutProof(fresh,"dev-B","lic-A","hw-A");
  invalidateDeviceLogoutProof("lic-A","hw-A");
  assert.equal(takeDeviceLogoutProof(fresh),null);
});
test("LX-S03: transient DB failure can restore a reserved v2 proof safely", () => {
  const token=prepareDeviceLogoutProof();
  activateDeviceLogoutProof(token,"device","license","hwid");
  const proof=takeDeviceLogoutProof(token);
  assert.ok(proof);
  restoreDeviceLogoutProof(token,proof);
  assert.equal(takeDeviceLogoutProof(token)?.licenseId,"license");
});
