import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assetContentType, assertBackupKey, assertPublicAssetKey, StorageError, type StorageProvider } from "./contracts.js";

export function localStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return new StorageError("STORAGE_FULL", "Storage is full", 507);
  if (code === "ENOENT") return new StorageError("OBJECT_NOT_FOUND", "Stored object not found", 404);
  if (code === "ELOOP" || code === "ENOTDIR") return new StorageError("INVALID_STORAGE_PATH", "Invalid storage path", 400);
  return new StorageError("STORAGE_UNAVAILABLE", "Local storage is unavailable");
}

export class LocalStorage implements StorageProvider {
  provider = "local" as const;
  privateBackupsConfigured = true;
  private root: string;

  constructor(root: string) {
    if (!root || !path.isAbsolute(root)) throw new StorageError("STORAGE_CONFIGURATION", "Local storage requires an absolute LOCAL_STORAGE_PATH");
    this.root = path.resolve(root);
    for (const directory of [path.resolve("public"), path.resolve("dist")]) {
      if (this.root === directory || this.root.startsWith(directory + path.sep)) {
        throw new StorageError("STORAGE_CONFIGURATION", "Local storage must be outside public web directories");
      }
    }
  }

  private async directory(visibility: "public" | "private", key: string, create: boolean): Promise<string> {
    let current = path.parse(this.root).root;
    const segments = [...this.root.slice(current.length).split(path.sep).filter(Boolean), visibility, key.split("/")[0]];
    for (const segment of segments) {
      current = path.join(current, segment);
      if (create) {
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StorageError("INVALID_STORAGE_PATH", "Invalid storage path", 400);
    }
    return current;
  }

  private async write(visibility: "public" | "private", key: string, data: Uint8Array): Promise<void> {
    let temporary: string | undefined;
    let handle: fs.FileHandle | undefined;
    try {
      const directory = await this.directory(visibility, key, true);
      temporary = path.join(directory, `.tmp-${randomUUID()}`);
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, path.join(directory, key.split("/")[1]));
      temporary = undefined;
    } catch (error) {
      throw localStorageError(error);
    } finally {
      await handle?.close();
      if (temporary) await fs.unlink(temporary).catch(() => {});
    }
  }

  private async read(visibility: "public" | "private", key: string, contentType: string) {
    let handle: fs.FileHandle | undefined;
    try {
      const directory = await this.directory(visibility, key, false);
      const filename = path.join(directory, key.split("/")[1]);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new StorageError("INVALID_STORAGE_PATH", "Invalid storage path", 400);
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!(await handle.stat()).isFile()) throw new StorageError("INVALID_STORAGE_PATH", "Invalid storage path", 400);
      return { data: await handle.readFile(), contentType };
    } catch (error) {
      throw localStorageError(error);
    } finally {
      await handle?.close();
    }
  }

  async putPublic(key: string, data: Uint8Array, contentType: string) {
    assertPublicAssetKey(key);
    if (assetContentType(key) !== contentType || contentType === "image/svg+xml") throw new StorageError("INVALID_IMAGE_TYPE", "Use PNG, JPEG, GIF, WebP or ICO images", 400);
    await this.write("public", key, data);
    return { key, url: `/api/public/assets/${key}` };
  }
  async readPublic(key: string) { assertPublicAssetKey(key); return this.read("public", key, assetContentType(key)); }
  async putBackup(key: string, data: Uint8Array) { assertBackupKey(key); await this.write("private", key, data); }
  async readBackup(key: string) { assertBackupKey(key); return this.read("private", key, "text/csv; charset=utf-8"); }
}
