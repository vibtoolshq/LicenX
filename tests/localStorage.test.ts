import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStorage, localStorageError } from "../src/server/storage/local.js";
import { getStorage, prepareAssetUpload, storageStatus } from "../src/server/storage/index.js";

let root: string;
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "licenx-storage-")); });
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

test("local provider persists public branding and private CSV across provider recreation without R2", async () => {
  const storage = new LocalStorage(root);
  await storage.putPublic("branding/logo.png", Buffer.from("png-data"), "image/png");
  await storage.putBackup("backups/licenses.csv", Buffer.from("key,pin\nfixture,1234"));
  const restarted = new LocalStorage(root);
  assert.equal(Buffer.from((await restarted.readPublic("branding/logo.png")).data).toString(), "png-data");
  assert.match(Buffer.from((await restarted.readBackup("backups/licenses.csv")).data).toString(), /fixture/);
  await assert.rejects(restarted.readPublic("backups/licenses.csv"));
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(root, "private/backups/licenses.csv"))).mode & 0o777, 0o600);
  assert.deepEqual(storageStatus(null, { env: { STORAGE_PROVIDER: "local", LOCAL_STORAGE_PATH: root } }), { storageProvider: "local", storageConfigured: true, privateBackupsConfigured: true });
});

test("local provider rejects traversal, encoded paths, symlink roots/directories/files and unsafe web roots", async () => {
  const storage = new LocalStorage(root);
  for (const key of ["../secret.png", "branding/../../x.png", "branding/..%2fx.png", "branding/a\\b.png", "/branding/x.png", "branding/.env", "licenses/x.csv"]) await assert.rejects(storage.readPublic(key));
  for (const unsafe of ["relative/path", path.resolve("public/uploads"), path.resolve("dist/data")]) assert.throws(() => new LocalStorage(unsafe));
  const linkedRoot = path.join(root, "linked-root");
  await fs.symlink(path.join(root, "public"), linkedRoot, "dir");
  await assert.rejects(new LocalStorage(linkedRoot).readPublic("branding/logo.png"));
  const linkedFile = path.join(root, "public/branding/link.png");
  await fs.symlink(path.join(root, "private/backups/licenses.csv"), linkedFile);
  await assert.rejects(storage.readPublic("branding/link.png"));
  const nested = path.join(root, "nested");
  await fs.mkdir(nested);
  await fs.symlink(path.join(root, "private"), path.join(nested, "public"), "dir");
  await assert.rejects(new LocalStorage(nested).putPublic("branding/no.png", new Uint8Array([1]), "image/png"));
});

test("failed atomic publication leaves no temporary or partial public object; errors hide disk paths", async () => {
  const storage = new LocalStorage(root);
  await fs.mkdir(path.join(root, "public/branding/failure.png"));
  await assert.rejects(storage.putPublic("branding/failure.png", new Uint8Array([1]), "image/png"));
  assert.equal((await fs.readdir(path.join(root, "public/branding"))).some((name) => name.startsWith(".tmp-")), false);
  assert.equal(localStorageError({ code: "ENOSPC", path: "/private/path" }).status, 507);
  assert.equal(localStorageError({ code: "EDQUOT" }).code, "STORAGE_FULL");
  assert.equal(localStorageError({ code: "EACCES", path: "/private/path" }).message, "Local storage is unavailable");
  assert.equal(localStorageError({ code: "ENOENT" }).status, 404);
});

test("storage configuration fails closed and branding upload accepts only bounded public image keys", async () => {
  assert.throws(() => storageStatus(null, { runtime: "cloudflare", env: { STORAGE_PROVIDER: "local", LOCAL_STORAGE_PATH: root } }));
  assert.throws(() => storageStatus(null, { env: { STORAGE_PROVIDER: "unknown" } }));
  await assert.rejects(getStorage(null, { env: { STORAGE_PROVIDER: "local", LOCAL_STORAGE_PATH: "relative" } }));
  for (const input of [
    { dataBase64: "YQ==", folder: "backups" },
    { dataBase64: "YQ==", contentType: "text/html" },
    { dataBase64: "YQ==", contentType: "image/svg+xml" },
    { dataBase64: "%%%" },
    { dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") },
  ]) assert.throws(() => prepareAssetUpload(input));
  const asset = prepareAssetUpload({ filename: "../../brand.png", dataBase64: "data:image/png;base64,YQ==" });
  assert.match(asset.key, /^branding\/[A-Za-z0-9_.-]+\.png$/);
  assert.equal(asset.contentType, "image/png");
});
