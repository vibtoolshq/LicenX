/** Phase-01: isolated Cloudflare app-scoped admin reset regression; no production requests. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { handleCloudflareApi } from "../src/server/cloudflareHandler.js";
import { generateAdminApiKey } from "../src/server/crypto.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";

test("Cloudflare admin reset allows own-app key but rejects missing permission and cross-app key", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  };
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  const db = getDbClient();
  try {
    await initDatabaseSchema();
    const nonce = randomBytes(6).toString("hex");
    const ownApp = "app_scope_a_" + nonce;
    const otherApp = "app_scope_b_" + nonce;
    const ownLic = "SCOPE-A-" + nonce.toUpperCase();
    const otherLic = "SCOPE-B-" + nonce.toUpperCase();
    const now = Date.now();
    for (const id of [ownApp, otherApp]) {
      await db.execute({
        sql: "INSERT INTO apps (id, app_slug, display_name, app_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, id, id, "CI_SYNTHETIC_ONLY", now, now],
      });
    }
    for (const [id, key, appId] of [
      ["lic_scope_a_" + nonce, ownLic, ownApp],
      ["lic_scope_b_" + nonce, otherLic, otherApp],
    ]) {
      await db.execute({
        sql: "INSERT INTO licenses (id, key, app_id, status, created_at) VALUES (?, ?, ?, 'active', ?)",
        args: [id, key, appId, now],
      });
      await db.execute({
        sql: "INSERT INTO devices (id, license_id, hwid, first_bound_at, last_ping_at) VALUES (?, ?, ?, ?, ?)",
        args: ["dev_" + id, id, "QA_SCOPE_DEVICE", now, now],
      });
    }
    const allowedKey = generateAdminApiKey("scoped");
    const readonlyKey = generateAdminApiKey("readonly");
    for (const [item, permissions] of [
      [allowedKey, ["licenses:manage"]],
      [readonlyKey, ["licenses:read"]],
    ] as const) {
      await db.execute({
        sql: "INSERT INTO admin_api_keys (id, name, key_prefix, secret_hash, permissions_json, app_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
        args: [item.id, item.id, item.keyPrefix, item.secretHash, JSON.stringify(permissions), ownApp, now],
      });
    }
    const reset = (license: string, bearer?: string) =>
      handleCloudflareApi(
        new Request("https://licenx.test/api/v1/admin/licenses/" + license + "/reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
          },
          body: "{}",
        }),
        undefined,
      );

    assert.equal((await reset(ownLic)).status, 401, "unauthenticated reset must fail");
    assert.equal((await reset(ownLic, readonlyKey.secret)).status, 403, "read-only scope must fail");
    assert.equal((await reset(otherLic, allowedKey.secret)).status, 403, "cross-app reset must fail");
    const before = await db.execute({ sql: "SELECT id FROM devices WHERE license_id = ?", args: ["lic_scope_b_" + nonce] });
    assert.equal(before.rows.length, 1, "cross-app device must remain");
    const accepted = await reset(ownLic, allowedKey.secret);
    assert.equal(accepted.status, 200, "same-app scoped reset must succeed");
    const payload = await accepted.json() as { success?: boolean; reset_devices_count?: number };
    assert.equal(payload.success, true);
    assert.equal(payload.reset_devices_count, 1);
    const ownAfter = await db.execute({ sql: "SELECT id FROM devices WHERE license_id = ?", args: ["lic_scope_a_" + nonce] });
    const otherAfter = await db.execute({ sql: "SELECT id FROM devices WHERE license_id = ?", args: ["lic_scope_b_" + nonce] });
    assert.equal(ownAfter.rows.length, 0);
    assert.equal(otherAfter.rows.length, 1, "cross-app device must remain after allowed reset");

    // Phase-03 regression: malformed create bodies and %-encoding return 400.
    const issueKey = generateAdminApiKey("create-qa");
    await db.execute({
      sql: "INSERT INTO admin_api_keys (id, name, key_prefix, secret_hash, permissions_json, app_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
      args: [issueKey.id, issueKey.id, issueKey.keyPrefix, issueKey.secretHash, JSON.stringify(["licenses:create", "licenses:read", "licenses:manage"]), ownApp, now],
    });
    const invoke = (path: string, method: string, body?: unknown) =>
      handleCloudflareApi(
        new Request("https://licenx.test" + path, {
          method,
          headers: { "Authorization": "Bearer " + issueKey.secret, "Content-Type": "application/json" },
          ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
        }),
        undefined,
      );
    const malformed = await invoke("/api/v1/admin/licenses", "POST", { device_limit: -5 });
    assert.equal(malformed.status, 400, "bad create input must not issue license");
    const brokenJson = await handleCloudflareApi(
      new Request("https://licenx.test/api/v1/admin/licenses", {
        method: "POST",
        headers: { Authorization: "Bearer " + issueKey.secret, "Content-Type": "application/json" },
        body: "{broken-json",
      }),
      undefined,
    );
    assert.equal(brokenJson.status, 400, "malformed JSON must not issue a default license");
    for (const [path, method] of [
      ["/api/v1/admin/licenses/%ZZ", "GET"],
      ["/api/v1/admin/licenses/%ZZ/reset", "POST"],
      ["/api/v1/admin/licenses/%ZZ/status", "PATCH"],
    ]) {
      assert.equal((await invoke(path, method, method === "PATCH" ? { status: "revoked" } : {})).status, 400, "malformed key encoding must return 400");
    }
    const ownIssue = await invoke("/api/v1/admin/licenses", "POST", { prefix: "SCOPED", validity_type: "daily", validity_value: 3 });
    assert.equal(ownIssue.status, 201, "valid scoped license creation remains supported");
    const ownIssueBody = await ownIssue.json() as { license: { app_id: string } };
    assert.equal(ownIssueBody.license.app_id, ownApp);
  } finally {
    await db.close();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
