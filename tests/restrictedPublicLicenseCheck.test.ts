import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { apiRouter } from "../src/server/api.js";
import { handleCloudflareApi } from "../src/server/cloudflareHandler.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { generateAdminApiKey } from "../src/server/crypto.js";
import { consumePublicCheckQuota, evaluatePublicLicense } from "../src/server/restrictedPublicLicenseCheck.js";

const RATE_SECRET = "qa_only_nonproduction_restricted_rate_secret_32_bytes";
const PATH = "/api/v1/public/license/check";

test("pure membership evaluation never activates or accepts unactivated time-bound keys", () => {
  const now = 10_000;
  const active = { status: "active", app_status: "active", validity_type: "lifetime", activated_at: null, expires_at: null };
  assert.equal(evaluatePublicLicense(active, now).valid, true);
  assert.equal(evaluatePublicLicense({ ...active, validity_type: "daily" }, now).status, "not_activated");
  assert.equal(evaluatePublicLicense({ ...active, validity_type: "daily", activated_at: 1 }, now).valid, false);
  assert.equal(evaluatePublicLicense({ ...active, activated_at: 1, expires_at: now - 1 }, now).status, "expired");
  assert.equal(evaluatePublicLicense({ ...active, app_status: "suspended" }, now).valid, false);
  assert.equal(evaluatePublicLicense(null, now).status, "not_valid");
});

test("global read-only check is disabled by default; consumer/domain auth and Node/CF parity", async () => {
  const old = {
    NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    PUBLIC_LICENSE_CHECK_ENABLED: process.env.PUBLIC_LICENSE_CHECK_ENABLED,
    PUBLIC_LICENSE_CHECK_RATE_SECRET: process.env.PUBLIC_LICENSE_CHECK_RATE_SECRET,
  };
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.PUBLIC_LICENSE_CHECK_ENABLED;
  process.env.PUBLIC_LICENSE_CHECK_RATE_SECRET = RATE_SECRET;
  const db = getDbClient();
  let server: Server | undefined;
  try {
    await initDatabaseSchema();
    const now = Date.now();
    const appA = "allowed-app";
    const appB = "second-app";
    const appC = "inactive-app";
    for (const id of [appA, appB, appC]) {
      await db.execute({ sql: "INSERT INTO apps (id, app_slug, display_name, app_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: [id, id, id, "TEST_ONLY", now, now] });
    }
    const addLicense = async (id: string, appId: string, status = "active", expiry: number | null = null, kind = "lifetime", activatedAt: number | null = null) => {
      await db.execute({
        sql: "INSERT INTO licenses (id, key, app_id, status, expires_at, validity_type, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [id, id, appId, status, expiry, kind, activatedAt, now],
      });
    };
    await addLicense("OWN-KEY", appA);
    await addLicense("OTHER-KEY", appB);
    await addLicense("EXPIRED-KEY", appA, "active", now - 1000);
    await addLicense("REVOKED-KEY", appA, "revoked");
    await addLicense("SUSPENDED-KEY", appA, "suspended");
    await addLicense("UNACTIVATED-KEY", appA, "active", null, "daily");
    await addLicense("INACTIVE-APP-KEY", appC);
    await db.execute({ sql: "UPDATE apps SET status='inactive' WHERE id=?", args: [appC] });

    const scoped = generateAdminApiKey("check");
    const normal = generateAdminApiKey("live");
    const mixed = generateAdminApiKey("check");
    const globalKey = generateAdminApiKey("check");
    for (const [g, appId, scopes] of [
      [scoped, null, ["licenses:check"]],
      [normal, appA, ["licenses:read"]],
      [mixed, appA, ["licenses:check", "admin:*"]],
      [globalKey, appA, ["licenses:check"]],
    ] as const) {
      await db.execute({
        sql: "INSERT INTO admin_api_keys (id, name, key_prefix, secret_hash, permissions_json, app_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
        args: [g.id, g.id, g.keyPrefix, g.secretHash, JSON.stringify(scopes), appId, now],
      });
    }

    await db.execute({
      sql: "INSERT INTO public_license_api_domains (id, domain_origin, app_id, key_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      args: ["domain-test", "https://tools.example", "", scoped.id, now],
    });
    const app = express();
    app.use(PATH, express.json({ limit: "1kb" }));
    app.use("/api", apiRouter);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const addr = server.address() as AddressInfo;
    const url = "http://127.0.0.1:" + addr.port;
    const request = (key: string, bearer = scoped.secret, extra: Record<string, string> = {}) =>
      fetch(url + PATH, { method: "POST", headers: { "Content-Type": "application/json", "X-LicenX-Tool-Origin": "https://tools.example", Authorization: "Bearer " + bearer, ...extra }, body: JSON.stringify({ license_key: key }) });
    const edge = (key: string, bearer = scoped.secret, extra: Record<string, string> = {}) =>
      handleCloudflareApi(new Request("https://licenx.test" + PATH, { method: "POST", headers: { "Content-Type": "application/json", "X-LicenX-Tool-Origin": "https://tools.example", Authorization: "Bearer " + bearer, ...extra }, body: JSON.stringify({ license_key: key }) }), undefined);

    assert.equal((await request("OWN-KEY")).status, 503, "disabled by default");
    assert.equal((await edge("OWN-KEY")).status, 503, "edge disabled by default");

    process.env.PUBLIC_LICENSE_CHECK_ENABLED = "true";
    await db.execute("UPDATE public_license_api_settings SET enabled=1 WHERE id='main'");
    for (const target of [request, edge]) {
      assert.equal((await target("OWN-KEY", normal.secret)).status, 401, "admin read key not authorized");
      assert.equal((await target("OWN-KEY", mixed.secret)).status, 401, "mixed wildcard key not authorized");
      assert.equal((await target("OWN-KEY", globalKey.secret)).status, 401, "legacy app-bound check key not authorized");
      assert.equal((await target("OWN-KEY", scoped.secret, { Origin: "https://untrusted.test" })).status, 403, "browser calls refused");
      assert.equal((await target("OWN-KEY", scoped.secret, { "X-LicenX-Tool-Origin": "https://other-tool.example" })).status, 403, "wrong domain denied");
      assert.equal((await target("OWN-KEY", scoped.secret, { "X-LicenX-Tool-Origin": "" })).status, 403, "missing claimed domain denied");
      const accepted = await target("OWN-KEY");
      assert.equal(accepted.status, 200);
      assert.equal(accepted.headers.get("cache-control"), "no-store");
      assert.equal(accepted.headers.get("access-control-allow-origin"), null);
      const body = await accepted.json() as { valid: boolean; status: string; expires_at: null };
      assert.deepEqual({ valid: body.valid, status: body.status, expires_at: body.expires_at }, { valid: true, status: "active", expires_at: null });

      const secondApp = await target("OTHER-KEY");
      assert.equal(secondApp.status, 200);
      const secondAppBody = await secondApp.json() as { valid: boolean; app: { slug: string } };
      assert.equal(secondAppBody.valid, true, "one domain can check a license for any LicenX app");
      assert.equal(secondAppBody.app.slug, appB);
      for (const [key, status] of [
        ["UNKNOWN-KEY", "not_valid"], ["EXPIRED-KEY", "expired"],
        ["REVOKED-KEY", "revoked"], ["SUSPENDED-KEY", "suspended"],
        ["UNACTIVATED-KEY", "not_activated"], ["INACTIVE-APP-KEY", "inactive_app"],
      ] as const) {
        const response = await target(key);
        assert.equal(response.status, 200, key);
        const result = await response.json() as { valid: boolean; status: string };
        assert.equal(result.valid, false, key);
        assert.equal(result.status, status, key);
      }
    }
    const records = await db.execute("SELECT id, status, activated_at, expires_at FROM licenses ORDER BY id");
    assert.equal(records.rows.find(r => r.id === "EXPIRED-KEY")?.status, "active", "read-only expiry must not persist");
    assert.equal(records.rows.find(r => r.id === "UNACTIVATED-KEY")?.activated_at, null, "no activation");
    const deviceRows = await db.execute("SELECT COUNT(*) AS c FROM devices");
    const logRows = await db.execute("SELECT COUNT(*) AS c FROM validation_logs");
    assert.equal(Number(deviceRows.rows[0]?.c), 0, "no device binding");
    assert.equal(Number(logRows.rows[0]?.c), 0, "no raw license-key validation logs");

    await db.execute({ sql: "UPDATE admin_api_keys SET status='revoked' WHERE id=?", args: [scoped.id] });
    assert.equal((await request("OWN-KEY")).status, 401, "revoked key denied");
    assert.equal((await edge("OWN-KEY")).status, 401, "revoked key denied on edge");

    // Rotating untrusted forwarded IPs cannot bypass Node's normalized source-IP limit.
    let nodeLimited = false;
    for (let i = 0; i < 25; i++) {
      const response = await request("OWN-KEY", scoped.secret, { "X-Forwarded-For": "198.51.100." + i });
      if (response.status === 429) { nodeLimited = true; break; }
    }
    assert.equal(nodeLimited, true, "Node source quota blocks repeated spoofed XFF");

    let edgeLimited = false;
    for (let i = 0; i < 25; i++) {
      const response = await edge("OWN-KEY", scoped.secret, { "CF-Connecting-IP": "203.0.113.77", "X-Forwarded-For": "198.51.100." + i });
      if (response.status === 429) { edgeLimited = true; break; }
    }
    assert.equal(edgeLimited, true, "Cloudflare source quota blocks repeated spoofed XFF");

    // Shared persistent counter guarantees fail-closed on excess across invocations.
    const cap = await consumePublicCheckQuota(db, RATE_SECRET, "test", "unique-client", 2, 60000, now);
    assert.equal(cap, true);
    assert.equal(await consumePublicCheckQuota(db, RATE_SECRET, "test", "unique-client", 2, 60000, now), true);
    assert.equal(await consumePublicCheckQuota(db, RATE_SECRET, "test", "unique-client", 2, 60000, now), false);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
