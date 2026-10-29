import assert from "node:assert/strict";
import { test } from "node:test";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import {
  normalizeAllowedToolOrigin, getPublicApiControl, setPublicApiEnabled,
  createPublicApiDomain, updatePublicApiDomain, revokePublicApiDomain,
} from "../src/server/publicLicenseApiControl.js";
import { runRestrictedPublicLicenseCheck } from "../src/server/restrictedPublicLicenseCheck.js";

test("exact HTTPS origin validator rejects wildcards, paths, credentials and query strings", () => {
  assert.equal(normalizeAllowedToolOrigin("https://tools.example"), "https://tools.example");
  assert.equal(normalizeAllowedToolOrigin("https://tools.example/"), "https://tools.example");
  for (const input of [
    "http://tools.example", "*.example", "https://*.example.com", "https://tools.example/path",
    "https://tools.example?token=a", "https://user:pass@tools.example",
    "https://tools.example/#hash", " https://tools.example", "javascript:alert(1)",
  ]) assert.equal(normalizeAllowedToolOrigin(input), null, input);
});

test("Admin Public API lifecycle defaults off; exact domain + dedicated key, app scope and revocation", async () => {
  const old = {
    NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  };
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const db = getDbClient();
  try {
    await initDatabaseSchema();
    const started = Date.now();
    await db.execute({ sql: "INSERT INTO apps (id, app_slug, display_name, app_secret, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)", args: ["app-dom", "app-dom", "Domain Test App", "TEST_ONLY", started, started] });
    await db.execute({ sql: "INSERT INTO licenses (id, key, app_id, status, validity_type, created_at) VALUES (?, ?, ?, 'active', 'lifetime', ?)", args: ["lic-dom", "TEST-DOMAIN-LICENSE", "app-dom", started] });
    const before = await getPublicApiControl(db);
    assert.equal(before.enabled, false);
    assert.deepEqual(before.domains, []);
    await assert.rejects(setPublicApiEnabled(db, true), /Register an active domain/);
    await assert.rejects(createPublicApiDomain(db, { domain_origin: "http://insecure.test", app_id: "app-dom" }), /HTTPS/);
    await assert.rejects(createPublicApiDomain(db, { domain_origin: "https://tools.example", app_id: "absent-app" }), /Application not found/);

    const created = await createPublicApiDomain(db, { domain_origin: "https://tools.example", app_id: "app-dom", name: "Tool test" });
    assert.match(created.secret, /^vcon_sec_[a-f0-9]{48}$/);
    assert.equal(created.domain.domain_origin, "https://tools.example");
    await assert.rejects(createPublicApiDomain(db, { domain_origin: "https://tools.example", app_id: "app-dom" }), /already registered/);
    const listed = await getPublicApiControl(db);
    assert.equal(listed.domains.length, 1);
    assert.equal(listed.domains[0].enabled, true);
    assert.equal(JSON.stringify(listed).includes(created.secret), false, "GET must never expose secret");
    const dedicated = await db.execute({ sql: "SELECT permissions_json, key_prefix, app_id FROM admin_api_keys WHERE id=?", args: [created.domain.key_id] });
    assert.deepEqual(JSON.parse(String(dedicated.rows[0].permissions_json)), ["licenses:check"]);
    assert.match(String(dedicated.rows[0].key_prefix), /^vcon_check_/);
    assert.equal(dedicated.rows[0].app_id, "app-dom");

    const request = (origin: string | null = "https://tools.example") =>
      runRestrictedPublicLicenseCheck({
        db, enabled: "true", clientIp: "192.0.2.44", origin: null,
        claimedToolOrigin: origin, contentType: "application/json",
        authorization: "Bearer " + created.secret, input: { license_key: "TEST-DOMAIN-LICENSE" },
      });
    assert.equal((await request()).status, 503, "database global flag must block by default");
    await setPublicApiEnabled(db, true);
    const authorized = await request();
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body.valid, true);
    assert.equal(authorized.headers["Cache-Control"], "no-store");
    assert.equal((await request("https://untrusted.example")).status, 403);
    assert.equal((await request(null)).status, 403);
    await updatePublicApiDomain(db, created.domain.id, false);
    assert.equal((await request()).status, 403, "disabled domain must be immediately denied");
    await updatePublicApiDomain(db, created.domain.id, true);
    assert.equal((await request()).status, 200);
    await revokePublicApiDomain(db, created.domain.id);
    assert.equal((await request()).status, 401, "revoked per-domain credential must be denied");
    const keyAfter = await db.execute({ sql: "SELECT status FROM admin_api_keys WHERE id=?", args: [created.domain.key_id] });
    assert.equal(keyAfter.rows[0].status, "revoked");
    assert.equal((await getPublicApiControl(db)).domains.length, 0);
    await setPublicApiEnabled(db, false);
    assert.equal((await request()).status, 503);
    const license = await db.execute("SELECT status, activated_at FROM licenses WHERE id='lic-dom'");
    assert.equal(license.rows[0].status, "active");
    assert.equal(license.rows[0].activated_at, null, "read-only membership must not activate a license");
  } finally {
    await db.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
