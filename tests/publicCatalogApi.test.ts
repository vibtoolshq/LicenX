import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { apiRouter, invalidateAdminConfigCache } from "../src/server/api.js";
import { createSessionToken } from "../src/server/crypto.js";
import { getDbClient } from "../src/server/db.js";
import { postgresStatement } from "../src/server/database/sqlDialect.js";
import {
  readAdminPublicCatalog, readPublishedPublicCatalog, updateAdminPublicCatalog,
} from "../src/server/publicCatalog.js";
import type { PublicCatalogAdmin, PublicNavItem, PublicToolItem } from "../src/types.js";

const old = Object.fromEntries(
  ["NODE_ENV", "DATABASE_PROVIDER", "DATABASE_URL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]
    .map(key => [key, process.env[key]]),
);
process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "libsql";
process.env.DATABASE_URL = "file::memory:";
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
const db = getDbClient();
const secret = "pn01-security-test-secret";
let server: ReturnType<typeof createServer> | undefined;
let base = "";
function token(seconds: number) {
  return createSessionToken({ username: "owner", exp: Math.floor(Date.now() / 1000) + seconds }, secret);
}
async function call(
  path: string, method = "GET", data?: unknown, headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(base + path, {
    method, headers: { ...headers, ...(data === undefined ? {} : { "content-type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
const bearer = () => ({ authorization: "Bearer " + token(600) });
const nav = (overrides: Partial<PublicNavItem> = {}): PublicNavItem => ({
  id: "more", label: "More", href: "https://example.org/tools", kind: "link",
  enabled: true, target: "new", order: 5, ...overrides,
});
const tool = (overrides: Partial<PublicToolItem> = {}): PublicToolItem => ({
  id: "editor", name: "Editor", description: "A useful tool",
  url: "https://example.org/editor", iconUrl: "/api/public/assets/branding/icon.png",
  enabled: true, order: 0, ...overrides,
});
const body = async (res: Response): Promise<any> => res.json();

test("PN-01 P01: real endpoints, CSRF, safe views, atomic edits and old Site Settings compatibility", async () => {
  try {
    await db.execute("CREATE TABLE admin_config (id TEXT PRIMARY KEY, username TEXT NOT NULL, jwt_secret TEXT NOT NULL, r2_config_json TEXT, site_settings_json TEXT, updated_at INTEGER)");
    await db.execute({
      sql: "INSERT INTO admin_config (id, username, jwt_secret, r2_config_json, site_settings_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: ["pn01", "owner", secret, null, JSON.stringify({
        siteName: "Operator Brand", legacyCustomKey: "existing-extension",
        buyLicenseUrl: "https://licenses.example.org/buy",
        allowPublicCheck: false, allowPublicReset: true,
      }), Date.now()],
    });
    invalidateAdminConfigCache();
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.use("/api", apiRouter);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test listener");
    base = "http://127.0.0.1:" + address.port;

    assert.equal((await call("/api/admin/public-catalog")).status, 401);
    assert.equal((await call("/api/admin/public-catalog", "PUT", {})).status, 401);
    assert.equal((await call("/api/admin/public-catalog", "GET", undefined,
      { authorization: "Bearer " + token(-100) })).status, 401);
    assert.equal((await call("/api/admin/public-catalog", "PUT", {}, {
      cookie: "vcon_admin_session=" + token(600),
    })).status, 403);
    assert.equal((await call("/api/admin/public-catalog", "PUT", {}, {
      cookie: "vcon_admin_session=" + token(600) + "; vcon_admin_csrf=valid",
      "x-csrf-token": "invalid",
      origin: base,
    })).status, 403);

    const adminStart = await call("/api/admin/public-catalog", "GET", undefined, bearer());
    assert.equal(adminStart.status, 200);
    assert.match(adminStart.headers.get("cache-control") ?? "", /no-store/);
    const initial = await body(adminStart) as PublicCatalogAdmin;
    assert.equal(initial.navigation.length, 2);
    assert.deepEqual(initial.navigation.map(x => x.id), ["tools", "buy-license"]);
    assert.equal(initial.navigation[1].href, "https://licenses.example.org/buy");
    assert.equal(initial.tools.length, 0);

    const publishedStart = await body(await call("/api/public/site-catalog"));
    assert.equal(publishedStart.navigation.length, 2);
    assert.deepEqual(Object.keys(publishedStart).sort(), ["navigation", "tools"]);
    const selected: PublicNavItem[] = [
      nav({ id: "tools", label: "Tools", href: "/tools", target: "same", order: 0 }),
      nav({ id: "buy-license", label: "Buy License", href: "https://example.com/buy", kind: "cta", order: 1 }),
      nav({ id: "draft", label: "Private note", href: "https://example.org/unpublished",
        enabled: false, order: 3 }),
    ];
    const write = await call("/api/admin/public-catalog", "PUT",
      { version: initial.version, section: "navigation", items: selected }, bearer());
    assert.equal(write.status, 200);
    const saved = await body(write) as PublicCatalogAdmin;
    assert.notEqual(saved.version, initial.version);
    assert.equal(saved.buyLicenseUrl, "https://example.com/buy");
    assert.equal(saved.navigation.find(item => item.id === "buy-license")?.href, saved.buyLicenseUrl);

    const raw = JSON.parse(String((await db.execute("SELECT site_settings_json FROM admin_config")).rows[0].site_settings_json));
    assert.equal(raw.buyLicenseUrl, "https://example.com/buy");
    assert.equal(raw.publicNavigation.find((item: Record<string, unknown>) => item.id === "buy-license").href, undefined);
    assert.equal(raw.legacyCustomKey, "existing-extension");
    const publicAfterNav = await call("/api/public/site-catalog");
    assert.equal(publicAfterNav.status, 200);
    assert.equal((await body(publicAfterNav)).navigation.some((item: PublicNavItem) => item.id === "draft"), false);
    const oldPublic = await body(await call("/api/public/site-settings"));
    assert.equal(oldPublic.buyLicenseUrl, "https://example.com/buy");
    assert.equal(oldPublic.legacyCustomKey, "existing-extension");
    assert.equal(oldPublic.publicNavigation, undefined);
    assert.equal(oldPublic.publicTools, undefined);
    assert.equal(oldPublic.allowPublicCheck, false);
    assert.equal(oldPublic.allowPublicReset, true);

    const stale = await call("/api/admin/public-catalog", "PUT",
      { version: initial.version, section: "tools", items: [tool()] }, bearer());
    assert.equal(stale.status, 409);
    assert.equal((await body(stale)).code, "CATALOG_VERSION_CONFLICT");

    const updateTools = await call("/api/admin/public-catalog", "PUT",
      { version: saved.version, section: "tools", items: [
        tool(), tool({ id: "hidden", name: "Hidden", enabled: false, order: 1 }),
      ] }, bearer());
    assert.equal(updateTools.status, 200);
    const savedTools = await body(updateTools) as PublicCatalogAdmin;
    assert.equal(savedTools.tools.length, 2);
    assert.equal(savedTools.navigation.length, 3);
    assert.equal((await body(await call("/api/public/site-catalog"))).tools.length, 1);

    const siteUpdate = await call("/api/settings/site", "POST",
      { siteTagline: "Preserved after catalog creation", buyLicenseUrl: "https://example.org/new-buy" }, bearer());
    assert.equal(siteUpdate.status, 200);
    const applied = await body(siteUpdate);
    assert.equal(applied.siteSettings.siteTagline, "Preserved after catalog creation");
    assert.equal(applied.siteSettings.buyLicenseUrl, "https://example.org/new-buy");
    assert.equal(applied.siteSettings.publicTools.length, 2);
    assert.equal(applied.siteSettings.publicNavigation.length, 3);
    const fresh = await body(await call("/api/admin/public-catalog", "GET", undefined, bearer())) as PublicCatalogAdmin;
    assert.equal(fresh.navigation.find(item => item.id === "buy-license")?.href, "https://example.org/new-buy");
    assert.equal(fresh.tools[0].name, "Editor");
    assert.equal(fresh.navigation[0].id, "tools");
    assert.equal((await call("/api/admin/public-catalog", "PUT",
      { version: savedTools.version, section: "navigation", items: selected }, bearer())).status, 409);

    const rejected = await call("/api/settings/site", "POST",
      { publicTools: [], siteName: "should-not-save" }, bearer());
    assert.equal(rejected.status, 400);
    assert.equal((await body(rejected)).code, "INVALID_CATALOG_ITEM");
    const afterRejected = await body(await call("/api/public/site-settings"));
    assert.equal(afterRejected.siteName, "Operator Brand");

    const csrfWrite = await call("/api/admin/public-catalog", "PUT",
      { version: fresh.version, section: "tools", items: [tool()] },
      { cookie: "vcon_admin_session=" + token(600) + "; vcon_admin_csrf=key-123",
        "x-csrf-token": "key-123", origin: base });
    assert.equal(csrfWrite.status, 200);
  } finally {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    await db.close();
    invalidateAdminConfigCache();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("PN-01 P01: pure fixed validation rejects dangerous/oversized/duplicate values before DB mutation", async () => {
  // Separate memory database, independent of the real Express fixture.
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: "file::memory:" });
  try {
    await client.execute("CREATE TABLE admin_config (id TEXT PRIMARY KEY, site_settings_json TEXT, updated_at INTEGER)");
    await client.execute({ sql: "INSERT INTO admin_config (id, site_settings_json) VALUES (?, ?)", args: ["a", '{"buyLicenseUrl":"#"}'] });
    const initial = await readAdminPublicCatalog(client);
    const bad: Array<PublicNavItem[] | PublicToolItem[]> = [
      [nav({ href: "javascript:alert(1)" })],
      [nav({ href: "data:text/html,test" })],
      [nav({ href: "//evil.example" })],
      [nav({ href: "/vcon/public-nav" })],
      [nav({ href: "/api/admin/public-catalog" })],
      [nav({ href: "https://127.0.0.1/path" })],
      [nav({ href: "https://user:pass@example.org/" })],
      [nav({ href: "https://example.org\\@localhost/" })],
      [nav({ id: "tools", href: "https://example.org" })],
      [nav({ label: "<script>" })],
      [nav({ order: -1 })],
      [nav(), nav()],
      Array.from({ length: 25 }, (_, i) => nav({ id: "item-" + i })),
    ];
    for (const items of bad) {
      await assert.rejects(updateAdminPublicCatalog(client, { version: initial.version, section: "navigation", items }),
        (error: any) => error.status === 400);
      assert.equal((await readAdminPublicCatalog(client)).version, initial.version);
    }
    const invalidTools = [
      tool({ url: "http://example.org" }),
      tool({ url: "https://localhost/file" }),
      tool({ iconUrl: "data:image/svg+xml;base64,PHN2Zz4=" }),
      tool({ iconUrl: "https://example.com/icon.svg" }),
    ];
    for (const invalid of invalidTools) {
      await assert.rejects(updateAdminPublicCatalog(client, { version: initial.version, section: "tools", items: [invalid] }),
        (error: any) => error.status === 400);
    }
    assert.equal((await readAdminPublicCatalog(client)).version, initial.version);
    // The legacy buy-license URL is not silently overwritten, even when unsafe.
    await client.execute({ sql: "UPDATE admin_config SET site_settings_json = ? WHERE id = ?", args: [
      '{"siteName":"Safe","buyLicenseUrl":"javascript:alert(1)"}', "a",
    ] });
    assert.equal((await readPublishedPublicCatalog(client)).navigation[1].href, "#");
    const corrupted = '{"siteName":"Original","publicTools":[{"id":"bad","url":"javascript:alert(1)"}]}';
    await client.execute({ sql: "UPDATE admin_config SET site_settings_json = ? WHERE id = ?", args: [corrupted, "a"] });
    await assert.rejects(readPublishedPublicCatalog(client), (error: any) => error.status === 400);
    assert.equal((await client.execute("SELECT site_settings_json FROM admin_config")).rows[0].site_settings_json, corrupted);
  } finally {
    client.close();
  }
});

test("PN-01 P01: two edits at one version cannot both overwrite, and SQL is PostgreSQL-compatible", async () => {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute("CREATE TABLE admin_config (id TEXT PRIMARY KEY, site_settings_json TEXT, updated_at INTEGER)");
    await db.execute({ sql: "INSERT INTO admin_config (id, site_settings_json) VALUES (?, ?)", args: ["a", "{}"] });
    const initial = await readAdminPublicCatalog(db);
    const results = await Promise.allSettled([
      updateAdminPublicCatalog(db, { version: initial.version, section: "tools", items: [tool()] }),
      updateAdminPublicCatalog(db, { version: initial.version, section: "navigation", items: [nav()] }),
    ]);
    const winners = results.filter(result => result.status === "fulfilled");
    const losers = results.filter(result => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    if (losers[0]?.status === "rejected") assert.equal(losers[0].reason.code, "CATALOG_VERSION_CONFLICT");
    const saved = await readAdminPublicCatalog(db);
    assert.equal(saved.tools.length + (saved.navigation.length === 1 ? 1 : 0), 1 + 0);
    // Existing Postgres adapter maps ? placeholders and returns rowCount as rowsAffected;
    // this is a syntax/adapter check, not a live PostgreSQL integration test.
    const translated = postgresStatement({
      sql: "UPDATE admin_config SET site_settings_json = ?, updated_at = ? WHERE id = ? AND site_settings_json = ?",
      args: ["{}", Date.now(), "a", "{}"],
    });
    assert.match(translated.text, /UPDATE admin_config SET site_settings_json = \$1, updated_at = \$2::bigint WHERE id = \$3 AND site_settings_json = \$4/);
    assert.equal(translated.values.length, 4);
  } finally {
    db.close();
  }
});
