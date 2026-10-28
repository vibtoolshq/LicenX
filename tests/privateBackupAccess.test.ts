import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apiRouter, invalidateAdminConfigCache } from "../src/server/api.js";
import { handleCloudflareApi, invalidateAdminConfigCache as invalidateCloudflareCache } from "../src/server/cloudflareHandler.js";
import { createSessionToken } from "../src/server/crypto.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { uploadToR2 } from "../src/server/r2.js";
import { R2Storage } from "../src/server/storage/r2.js";

let db: ReturnType<typeof getDbClient>;
let server: Server;
let baseUrl: string;
let root: string;
const original = { ...process.env };
const token = createSessionToken({ username: "storage-admin", exp: Math.floor(Date.now()/1000) + 3600 }, "fixture-jwt-secret");
const config = { accountId: "fixture-account", accessKeyId: "fixture-key", secretAccessKey: "fixture-secret", bucketName: "public-branding", privateBucketName: "private-backups", publicUrl: "https://assets.test" };
const objects = new Map<string, Uint8Array>();
const send = S3Client.prototype.send;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.DATABASE_PROVIDER;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "licenx-storage-api-"));
  process.env.LOCAL_STORAGE_PATH = root;
  db = getDbClient();
  await initDatabaseSchema();
  S3Client.prototype.send = async function (command: any): Promise<any> {
    const key = `${command.input.Bucket}/${command.input.Key}`;
    if (command instanceof PutObjectCommand) {
      const data = command.input.Body;
      if (!(data instanceof Uint8Array)) throw new Error("Expected an in-memory upload body");
      objects.set(key, new Uint8Array(data)); return {};
    }
    if (command instanceof GetObjectCommand && objects.has(key)) return { Body: { transformToByteArray: async () => objects.get(key) }, ContentType: "application/octet-stream" };
    throw new Error("Synthetic missing object (no network)");
  } as typeof send;
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use("/api", apiRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

beforeEach(async () => {
  process.env.STORAGE_PROVIDER = "local";
  process.env.LOCAL_STORAGE_PATH = root;
  objects.clear();
  invalidateAdminConfigCache(); invalidateCloudflareCache();
  for (const table of ["devices", "licenses", "r2_backups", "admin_config"]) await db.execute(`DELETE FROM ${table}`);
  await db.execute({ sql: "INSERT INTO admin_config (id, username, password_hash, jwt_secret, ed25519_private_key, ed25519_public_key, created_at, updated_at) VALUES ('admin', 'storage-admin', 'unused', 'fixture-jwt-secret', 'unused', 'unused', 1, 1)", args: [] });
});

after(async () => {
  S3Client.prototype.send = send;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
  await fs.rm(root, { recursive: true, force: true });
  for (const name of ["NODE_ENV", "DATABASE_URL", "TURSO_DATABASE_URL", "DATABASE_PROVIDER", "STORAGE_PROVIDER", "LOCAL_STORAGE_PATH"]) {
    if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
  }
});

async function nodeRequest(route: string, body?: object, authorized = true) {
  return fetch(baseUrl + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function cloudRequest(route: string, body?: object, authorized = true) {
  return handleCloudflareApi(new Request("https://licenx.test/api" + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), undefined);
}

test("local Node branding upload/public serving and saved site settings work with no R2 credentials", async () => {
  const status = await (await nodeRequest("/setup/status")).json();
  assert.equal(status.r2Configured, false);
  assert.equal(status.storageProvider, "local");
  assert.equal(status.storageConfigured, true);
  assert.equal(status.privateBackupsConfigured, true);
  const uploaded = await nodeRequest("/settings/upload", { filename: "logo.png", contentType: "image/png", dataBase64: "YQ==" });
  assert.equal(uploaded.status, 200);
  const asset = await uploaded.json();
  const image = await nodeRequest(asset.url.slice(4), undefined, false);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await image.text(), "a");
  assert.equal((await nodeRequest("/settings/site", { logoUrl: asset.url })).status, 200);
  assert.equal((await (await nodeRequest("/public/site-settings", undefined, false)).json()).logoUrl, asset.url);
  assert.equal((await nodeRequest("/settings/upload", { dataBase64: "YQ==", folder: "licenses" })).status, 400);
  assert.equal((await nodeRequest("/settings/upload", { dataBase64: "YQ==" }, false)).status, 401);
});

test("local private CSV requires admin authentication, has no-store attachment headers and never a public URL", async () => {
  const response = await nodeRequest("/licenses/bulk", { count: 2, backupToStorage: true });
  assert.equal(response.status, 200);
  const batch = await response.json();
  assert.equal(batch.r2Backup.provider, "local");
  assert.match(batch.r2Backup.url, /^\/api\/storage\/backups\//);
  assert.equal(batch.r2Backup.signedUrl, undefined);
  const route = batch.r2Backup.url.slice(4);
  assert.equal((await nodeRequest(route, undefined, false)).status, 401);
  const download = await nodeRequest(route);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("cache-control")!, /no-store/);
  assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  assert.match(await download.text(), new RegExp(batch.keys[0]));
  const raw = (await db.execute("SELECT r2_url FROM r2_backups")).rows[0].r2_url as string;
  const reference = JSON.parse(raw);
  for (const alias of ["/public/assets/", "/storage/file/"]) {
    assert.equal((await nodeRequest(alias + reference.key, undefined, false)).status, 404);
    assert.equal((await cloudRequest(alias + reference.key, undefined, false)).status, 404);
  }
  assert.equal((await cloudRequest(route, undefined, false)).status, 401);
  const listed = await (await nodeRequest("/r2/backups")).json();
  assert.equal(listed.backups[0].r2_url, batch.r2Backup.url);
  assert.equal(JSON.stringify(listed).includes("licenx-private-v1"), false);
});

test("public proxy rejects legacy license CSVs and hostile paths in Node and Cloudflare; legacy URLs are suppressed", async () => {
  await db.execute({ sql: "INSERT INTO r2_backups (id, filename, record_count, file_size, r2_url, created_at) VALUES ('legacy', 'old.csv', 1, 1, 'https://old-public.test/licenses/old.csv', 1)", args: [] });
  for (const request of [nodeRequest, cloudRequest]) {
    for (const route of ["/public/assets/licenses/old.csv", "/storage/file/licenses/old.csv", "/public/assets/backups/old.csv", "/public/assets/branding/..%2fsecret.png", "/storage/file/branding/%252e%252e%252fsecret.png"]) {
      const response = await request(route, undefined, false);
      assert.ok(response.status >= 400 && response.status < 500);
    }
    const history = await (await request("/r2/backups")).json();
    assert.equal(history.backups[0].r2_url, null);
    assert.equal(history.backups[0].downloadable, false);
  }
});

test("requested backup rejects missing private R2 configuration before creating any licenses", async () => {
  process.env.STORAGE_PROVIDER = "r2";
  await db.execute({ sql: "UPDATE admin_config SET r2_config_json = ?", args: [JSON.stringify({ ...config, privateBucketName: "" })] });
  for (const request of [nodeRequest, cloudRequest]) assert.equal((await request("/licenses/bulk", { count: 1, backupToR2: true })).status, 400);
  assert.equal((await db.execute("SELECT COUNT(*) AS count FROM licenses")).rows[0].count, 0);
});

test("R2 mock keeps public branding compatible and private writes/reads on a separate bucket in both runtimes", async () => {
  process.env.STORAGE_PROVIDER = "r2";
  await db.execute({ sql: "UPDATE admin_config SET r2_config_json = ?", args: [JSON.stringify(config)] });
  for (const request of [nodeRequest, cloudRequest]) {
    const upload = await request("/settings/upload", { filename: "logo.png", contentType: "image/png", dataBase64: "YQ==" });
    assert.equal(upload.status, 200);
    const asset = await upload.json();
    assert.match(asset.url, /^https:\/\/assets.test\/branding\//);
    assert.equal((await request("/public/assets/" + asset.key, undefined, false)).status, 200);
    const batch = await (await request("/licenses/bulk", { count: 1, backupToR2: true })).json();
    assert.equal(batch.r2Backup.provider, "r2");
    assert.equal(batch.r2Backup.signedUrl, undefined);
    const download = await request(batch.r2Backup.url.slice(4));
    assert.equal(download.status, 200);
    assert.match(download.headers.get("cache-control")!, /no-store/);
    assert.match(await download.text(), new RegExp(batch.keys[0]));
  }
  assert.ok([...objects.keys()].some((key) => key.startsWith("private-backups/backups/")));
  assert.ok([...objects.keys()].every((key) => !key.startsWith("public-branding/backups/")));
  const privatePut = await uploadToR2({ ...config, bucketName: config.privateBucketName, publicUrl: undefined }, "backups/direct.csv", "private", "text/csv", true);
  assert.equal(privatePut.url, undefined); assert.equal(privatePut.signedUrl, undefined);
  assert.equal(new R2Storage({ ...config, privateBucketName: config.bucketName }).privateBackupsConfigured, false);
});

test("a failed backup is reported while created licenses and direct CSV remain available", async () => {
  const brokenRoot = path.join(root, "not-a-directory");
  await fs.writeFile(brokenRoot, "file");
  process.env.LOCAL_STORAGE_PATH = brokenRoot;
  const response = await nodeRequest("/licenses/bulk", { count: 1, backupToStorage: true });
  assert.equal(response.status, 200);
  const batch = await response.json();
  assert.equal(batch.success, true);
  assert.equal(batch.r2Backup, null);
  assert.equal(batch.keys.length, 1);
  assert.match(batch.csv, /key,pin/);
  assert.ok(batch.backupError.code);
  assert.equal(JSON.stringify(batch.backupError).includes(root), false);
});

test("private R2 bucket settings persist with masked-secret and legacy-client compatibility", async () => {
  process.env.STORAGE_PROVIDER = "r2";
  for (const request of [nodeRequest, cloudRequest]) {
    assert.equal((await request("/settings/r2", config)).status, 200);
    const settings = await (await request("/settings")).json();
    assert.equal(settings.r2Config.privateBucketName, "private-backups");
    assert.equal(settings.privateBackupsConfigured, true);
    assert.equal(settings.r2Config.secretAccessKey.includes("fixture-secret"), false);
    const { privateBucketName: omitted, ...legacy } = config;
    assert.equal((await request("/settings/r2", { ...legacy, secretAccessKey: "••••••••••••••••" })).status, 200);
    assert.equal((await (await request("/settings")).json()).r2Config.privateBucketName, omitted);
    assert.equal((await request("/settings/r2", { ...config, privateBucketName: config.bucketName })).status, 400);
  }
});
