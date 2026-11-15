import express from "express";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { apiRouter } from "../src/server/api.js";
import { handleCloudflareApi } from "../src/server/cloudflareHandler.js";
import {
  canonicalJson,
  generateEd25519KeyPair,
  generateRSAKeyPair,
  verifySignature,
  type CryptoKeyPair,
} from "../src/server/crypto.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";

const licenseId = "license-heartbeat-signing-test";
const licenseKey = "LICX-HEARTBEAT-SIGNING-TEST";
const hwid = "HWID-HEARTBEAT-SIGNING-TEST";
const deviceId = "device-heartbeat-signing-test";
let db: ReturnType<typeof getDbClient>;
let server: Server;
let baseUrl: string;
const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
};

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  db = getDbClient();
  await initDatabaseSchema();

  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  const keyPair = generateRSAKeyPair();
  await db.execute("DELETE FROM devices");
  await db.execute("DELETE FROM validation_logs");
  await db.execute("DELETE FROM licenses");
  await db.execute("DELETE FROM admin_config");
  await db.execute({
    sql: `INSERT INTO admin_config
          (id, username, password_hash, jwt_secret, ed25519_private_key,
           ed25519_public_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "admin-heartbeat-signing-test",
      "test-admin",
      "unused-test-hash",
      "unused-test-secret",
      keyPair.privateKeyPem,
      keyPair.publicKeyPem,
      Date.now(),
      Date.now(),
    ],
  });
  await db.execute({
    sql: `INSERT INTO licenses
          (id, key, status, tier, app_id, device_limit, validity_type,
           validity_value, activated_at, expires_at, created_at)
          VALUES (?, ?, 'active', 'Standard', NULL, 1, 'lifetime', 0, ?, NULL, ?)`,
    args: [licenseId, licenseKey, Date.now(), Date.now()],
  });
  await db.execute({
    sql: `INSERT INTO devices
          (id, license_id, hwid, device_name, os_info, ip_address,
           first_bound_at, last_ping_at, status)
          VALUES (?, ?, ?, 'Heartbeat Test', 'test', '127.0.0.1', ?, ?, 'active')`,
    args: [deviceId, licenseId, hwid, Date.now(), Date.now()],
  });
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (db) await db.close();

  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function pingNode(nonce: string) {
  const response = await fetch(`${baseUrl}/api/v1/license/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ license_key: licenseKey, hwid, nonce }),
  });
  return { status: response.status, body: await response.json() };
}

async function pingCloudflare(nonce: string) {
  const response = await handleCloudflareApi(
    new Request("https://licenx.test/api/v1/license/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseKey, hwid, nonce }),
    }),
    undefined,
  );
  return { status: response.status, body: await response.json() };
}

async function installSigningKey(keyPair: CryptoKeyPair) {
  await db.execute({
    sql: `UPDATE admin_config
          SET ed25519_private_key = ?, ed25519_public_key = ? WHERE id = ?`,
    args: [
      keyPair.privateKeyPem,
      keyPair.publicKeyPem,
      "admin-heartbeat-signing-test",
    ],
  });
}

for (const algorithm of ["RSA", "Ed25519"] as const) {
  test(`Node and Cloudflare sign ${algorithm} nonce-bound heartbeat responses`, async () => {
    const keyPair =
      algorithm === "RSA" ? generateRSAKeyPair() : generateEd25519KeyPair();
    await installSigningKey(keyPair);
    const nonce = `challenge-${algorithm.toLowerCase()}`;

    const results = [await pingNode(nonce), await pingCloudflare(nonce)];
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.body.valid, true);
      assert.equal(result.body.status, "active");
      assert.equal(result.body.nonce, nonce);
      assert.equal(typeof result.body.signature, "string");

      const signedPayload = { ...result.body };
      const signature = signedPayload.signature as string;
      delete signedPayload.signature;
      assert.equal(
        verifySignature(
          canonicalJson(signedPayload),
          signature,
          keyPair.publicKeyPem,
        ),
        true,
      );
    }
  });
}

test("heartbeat denial remains fail-closed when the device is unbound", async () => {
  await db.execute("UPDATE devices SET status = 'logged_out' WHERE id = ?", [
    deviceId,
  ]);

  const nodeResult = await pingNode("unbound-challenge");
  const cloudflareResult = await pingCloudflare("unbound-challenge");

  assert.equal(nodeResult.status, 403);
  assert.equal(cloudflareResult.status, 403);
  assert.equal(nodeResult.body.code, "DEVICE_UNBOUND");
  assert.equal(cloudflareResult.body.code, "DEVICE_UNBOUND");
});

test("Node renews the same stale active binding; Cloudflare retains legacy lease policy", async () => {
  const appId = "app-heartbeat-lease-test";
  const appSlug = "heartbeat-lease-test";
  const appNow = Date.now();
  const stalePing = appNow - 1212 * 1000;
  await db.execute({
    sql: `INSERT INTO apps
          (id, app_slug, display_name, app_secret, device_lease_seconds,
           ping_interval_seconds, offline_grace_seconds, created_at, updated_at)
          VALUES (?, ?, 'Heartbeat Lease Test', 'sec-test', 1211, 1200, 0, ?, ?)`,
    args: [appId, appSlug, appNow, appNow],
  });
  await db.execute("UPDATE licenses SET app_id = ? WHERE id = ?", [
    appId,
    licenseId,
  ]);
  await db.execute("UPDATE devices SET last_ping_at = ? WHERE id = ?", [
    stalePing,
    deviceId,
  ]);

  const nodeResult = await pingNode("stale-active-node-recovery");
  assert.equal(nodeResult.status, 200, "same active Node binding can resume");
  assert.equal(nodeResult.body.valid, true);
  assert.equal(nodeResult.body.nonce, "stale-active-node-recovery");
  const renewed = await db.execute("SELECT status,last_ping_at FROM devices WHERE id = ?", [deviceId]);
  assert.equal(renewed.rows[0]?.status, "active");
  assert.ok(Number(renewed.rows[0]?.last_ping_at) >= appNow);
  // Cloudflare is separately scoped and must retain its old stale-lease denial.
  await db.execute(
    "UPDATE devices SET status = 'active', last_ping_at = ? WHERE id = ?",
    [stalePing, deviceId],
  );
  const cloudflareResult = await pingCloudflare("expired-cloudflare-lease");
  assert.equal(cloudflareResult.status, 403);
  assert.equal(cloudflareResult.body.code, "DEVICE_LEASE_EXPIRED");

  const row = await db.execute("SELECT status FROM devices WHERE id = ?", [
    deviceId,
  ]);
  assert.equal(row.rows[0]?.status, "logged_out");

  const afterReset = await pingNode("logged-out-must-stay-logged-out");
  assert.equal(afterReset.status, 403);
  assert.equal(afterReset.body.code, "DEVICE_UNBOUND");
  const afterResetRow = await db.execute("SELECT status FROM devices WHERE id = ?", [deviceId]);
  assert.equal(afterResetRow.rows[0]?.status, "logged_out");

  await db.execute("UPDATE devices SET status = 'blocked' WHERE id = ?", [deviceId]);
  const blocked = await pingNode("blocked-must-stay-blocked");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "DEVICE_UNBOUND");
  await db.execute({
    sql: "UPDATE devices SET status = 'active', last_ping_at = ? WHERE id = ?",
    args: [stalePing, deviceId],
  });
  await db.execute("UPDATE licenses SET status = 'revoked' WHERE id = ?", [licenseId]);
  const revoked = await pingNode("revoked-must-stay-revoked");
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.code, "LICENSE_INACTIVE");
});

test("F05 Node signed terminal denial is challenge- and device-bound", async () => {
  const keyPair = generateEd25519KeyPair();
  await installSigningKey(keyPair);
  await db.execute("UPDATE devices SET status = 'logged_out' WHERE id = ?", [deviceId]);
  const request = {
    license_key: licenseKey,
    hwid,
    app_name: "signed-denial-test-app",
    nonce: "F05_DENIAL_NONCE_123456789012345678901234",
  };
  const response = await fetch(`${baseUrl}/api/v1/license/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 403);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.code, "DEVICE_UNBOUND");
  assert.equal(body.valid, false);
  assert.equal(body.nonce, request.nonce);
  const crypto = await import("node:crypto");
  const binding = crypto.createHash("sha256").update(canonicalJson({
    license_key: licenseKey, hwid, app_name: request.app_name,
  }), "utf8").digest("hex");
  assert.equal(body.request_binding, binding);
  const proof = {
    valid: false, code: body.code, nonce: body.nonce,
    request_binding: body.request_binding, server_time: body.server_time,
  };
  assert.equal(verifySignature(canonicalJson(proof), body.signature, keyPair.publicKeyPem), true);
  assert.equal(verifySignature(canonicalJson({
    ...proof, nonce: "FORGED_NONCE_123456789012345678901234",
  }), body.signature, keyPair.publicKeyPem), false);
  assert.equal(verifySignature(canonicalJson({
    ...proof, request_binding: "0".repeat(64),
  }), body.signature, keyPair.publicKeyPem), false);
  assert.equal("license_key" in body, false, "never echo private license key");

  await db.execute("UPDATE licenses SET status='suspended' WHERE id=?", [licenseId]);
  const suspended = await fetch(`${baseUrl}/api/v1/license/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const suspendedBody = await suspended.json() as Record<string, any>;
  assert.equal(suspended.status, 403);
  assert.equal(suspendedBody.code, "LICENSE_INACTIVE");
  const { signature: suspendedSig, message: _m, status: _s, ...signedCandidate } = suspendedBody;
  assert.equal(verifySignature(canonicalJson({
    valid: signedCandidate.valid,
    code: signedCandidate.code,
    nonce: signedCandidate.nonce,
    request_binding: signedCandidate.request_binding,
    server_time: signedCandidate.server_time,
  }), suspendedSig, keyPair.publicKeyPem), true);
});

test("F05 missing signing key never forges permission or negative proof", async () => {
  await db.execute("DELETE FROM admin_config");
  await db.execute("UPDATE devices SET status = 'logged_out' WHERE id = ?", [deviceId]);
  const response = await fetch(`${baseUrl}/api/v1/license/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: licenseKey, hwid, app_name: "signed-denial-test-app",
      nonce: "F05_DENIAL_NONCE_123456789012345678901234",
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 403);
  assert.equal(body.valid, false);
  assert.equal(body.code, "DEVICE_UNBOUND");
  assert.equal("signature" in body, false);
});
