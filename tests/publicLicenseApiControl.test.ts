import assert from "node:assert/strict";
import { test } from "node:test";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { generateAdminApiKey } from "../src/server/crypto.js";
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

test("Public API globally checks any app; legacy scoped domains fail closed; revocation is immediate", async () => {
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
    const now = Date.now();
    for (const [id, name] of [["app-dom", "First License App"], ["other-app", "Second License App"]]) {
      await db.execute({
        sql: "INSERT INTO apps (id, app_slug, display_name, app_secret, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
        args: [id, id, name, "TEST_ONLY", now, now],
      });
    }
    const addLicense = async (key: string, appId: string, status: string, validityType: string, value: number, expires: number | null, activated: number | null) => {
      await db.execute({
        sql: "INSERT INTO licenses (id, key, app_id, status, validity_type, validity_value, expires_at, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [key, key, appId, status, validityType, value, expires, activated, now],
      });
    };
    await addLicense("TEST-DOMAIN-LICENSE", "app-dom", "active", "lifetime", 0, null, null);
    await addLicense("OTHER-APP-LICENSE", "other-app", "active", "lifetime", 0, null, null);
    await addLicense("TIME-BOUND-LICENSE", "other-app", "active", "hourly", 2, now + 3600000, now - 3600000);
    await addLicense("EXPIRED-LICENSE", "app-dom", "active", "daily", 30, now - 1000, now - 10000);
    await addLicense("UNACTIVATED-LICENSE", "app-dom", "active", "daily", 30, null, null);
    const before = await getPublicApiControl(db);
    assert.equal(before.enabled, false);
    assert.deepEqual(before.domains, []);
    await assert.rejects(setPublicApiEnabled(db, true), /Register a global domain/);

    const legacy = generateAdminApiKey("check");
    await db.execute({
      sql: "INSERT INTO admin_api_keys (id, name, key_prefix, secret_hash, permissions_json, app_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
      args: [legacy.id, "Prior scoped domain", legacy.keyPrefix, legacy.secretHash, '["licenses:check"]', "app-dom", now],
    });
    await db.execute({
      sql: "INSERT INTO public_license_api_domains (id, domain_origin, app_id, key_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      args: ["legacy-domain", "https://old-tools.example", "app-dom", legacy.id, now],
    });
    assert.equal((await getPublicApiControl(db)).domains[0].legacy_scope, true);
    assert.equal((await getPublicApiControl(db)).domains[0].enabled, false);
    await assert.rejects(updatePublicApiDomain(db, "legacy-domain", true), /re-registered/);
    await assert.rejects(setPublicApiEnabled(db, true), /Register a global domain/);
    await assert.rejects(createPublicApiDomain(db, { domain_origin: "http://insecure.test" }), /HTTPS/);
    await assert.rejects(createPublicApiDomain(db, { domain_origin: "https://tools.example", app_id: "app-dom" }), /global/);

    const created = await createPublicApiDomain(db, { domain_origin: "https://tools.example", name: "All apps checker" });
    assert.match(created.secret, /^vcon_sec_[a-f0-9]{48}$/);
    assert.equal(created.domain.app_id, "");
    await assert.rejects(createPublicApiDomain(db, { domain_origin: "https://tools.example" }), /already registered/);
    const listed = await getPublicApiControl(db);
    assert.equal(listed.domains.length, 2);
    assert.equal(listed.domains.find(d => d.id === created.domain.id)?.legacy_scope, false);
    assert.equal(JSON.stringify(listed).includes(created.secret), false, "GET must never return private secret");
    const dedicated = await db.execute({ sql: "SELECT permissions_json, key_prefix, app_id FROM admin_api_keys WHERE id=?", args: [created.domain.key_id] });
    assert.deepEqual(JSON.parse(String(dedicated.rows[0].permissions_json)), ["licenses:check"]);
    assert.match(String(dedicated.rows[0].key_prefix), /^vcon_check_/);
    assert.equal(dedicated.rows[0].app_id, null);

    const request = (key: string, origin: string | null = "https://tools.example", bearer = created.secret) =>
      runRestrictedPublicLicenseCheck({
        db, enabled: "true", now, clientIp: "192.0.2.44", origin: null,
        claimedToolOrigin: origin, contentType: "application/json",
        authorization: "Bearer " + bearer, input: { license_key: key },
      });
    assert.equal((await request("TEST-DOMAIN-LICENSE")).status, 503, "DB global switch defaults OFF");
    await setPublicApiEnabled(db, true);
    for (const [key, name] of [["TEST-DOMAIN-LICENSE", "First License App"], ["OTHER-APP-LICENSE", "Second License App"]]) {
      const response = await request(key);
      assert.equal(response.status, 200, key);
      assert.equal(response.body.valid, true, key);
      assert.equal((response.body.app as { name: string }).name, name, key);
      assert.equal(response.body.expires_in_seconds, null, "lifetime has no countdown");
      assert.equal(response.headers["Cache-Control"], "no-store");
      assert.equal(JSON.stringify(response.body).includes(key), false, "response never echoes license key");
    }
    const timed = await request("TIME-BOUND-LICENSE");
    assert.equal(timed.body.valid, true);
    assert.equal(timed.body.validity_type, "hourly");
    assert.equal(timed.body.validity_value, 2);
    assert.equal(timed.body.expires_in_seconds, 3600);
    assert.equal((timed.body.app as { slug: string }).slug, "other-app");
    const expired = await request("EXPIRED-LICENSE");
    assert.equal(expired.body.valid, false);
    assert.equal(expired.body.status, "expired");
    assert.equal(expired.body.expires_in_seconds, 0);
    const unactivated = await request("UNACTIVATED-LICENSE");
    assert.equal(unactivated.body.status, "not_activated");
    assert.equal(unactivated.body.validity_value, 30);
    assert.equal(unactivated.body.expires_in_seconds, null);
    const unknown = await request("UNKNOWN-KEY");
    assert.equal(unknown.body.valid, false);
    assert.equal(unknown.body.app, null);
    assert.equal((await request("TEST-DOMAIN-LICENSE", "https://untrusted.example")).status, 403);
    assert.equal((await request("TEST-DOMAIN-LICENSE", null)).status, 403);
    assert.equal((await request("TEST-DOMAIN-LICENSE", "https://old-tools.example", legacy.secret)).status, 401,
      "prior app-scoped token cannot automatically gain global lookup access");
    await updatePublicApiDomain(db, created.domain.id, false);
    assert.equal((await request("TEST-DOMAIN-LICENSE")).status, 403);
    await updatePublicApiDomain(db, created.domain.id, true);
    assert.equal((await request("TEST-DOMAIN-LICENSE")).status, 200);
    await revokePublicApiDomain(db, created.domain.id);
    assert.equal((await request("TEST-DOMAIN-LICENSE")).status, 401);
    assert.equal((await getPublicApiControl(db)).domains.length, 1, "old legacy row retained and still ineligible");
    await setPublicApiEnabled(db, false);
    const originals = await db.execute("SELECT id, status, activated_at FROM licenses ORDER BY id");
    assert.equal(originals.rows.length, 5);
    assert.equal(originals.rows.find(r => r.id === "EXPIRED-LICENSE")?.status, "active");
    assert.equal(originals.rows.find(r => r.id === "UNACTIVATED-LICENSE")?.activated_at, null);
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM devices")).rows[0].n), 0);
  } finally {
    await db.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
