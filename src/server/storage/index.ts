import crypto from "node:crypto";
import type { DatabaseClient } from "../database/contracts.js";
import type { R2Config } from "../r2.js";
import { R2Storage } from "./r2.js";
import { assertBackupKey, StorageError, storageError, type StorageProvider } from "./contracts.js";

export { assertPublicAssetKey, publicAssetHeaders, StorageError, storageError } from "./contracts.js";
interface StorageEnvironment { STORAGE_PROVIDER?: string; LOCAL_STORAGE_PATH?: string }
interface StorageContext { runtime?: "node" | "cloudflare"; env?: StorageEnvironment }

function configuration(value: unknown): R2Config {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : {};
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const text = (name: string) => typeof record[name] === "string" ? record[name] as string : "";
    return { accountId: text("accountId"), accessKeyId: text("accessKeyId"), secretAccessKey: text("secretAccessKey"), bucketName: text("bucketName"), publicUrl: text("publicUrl"), privateBucketName: text("privateBucketName") };
  }
  catch { throw new StorageError("STORAGE_CONFIGURATION", "Invalid storage configuration"); }
}
function environment(context: StorageContext): StorageEnvironment {
  return context.runtime === "cloudflare" ? context.env ?? {} : context.env ?? process.env;
}
export function storageStatus(value: unknown, context: StorageContext = {}) {
  const env = environment(context);
  const provider = env.STORAGE_PROVIDER?.trim().toLowerCase() || "r2";
  if (!["local", "r2"].includes(provider) || (provider === "local" && context.runtime === "cloudflare")) {
    throw new StorageError("STORAGE_CONFIGURATION", "Unsupported storage provider for this runtime");
  }
  if (provider === "local") {
    const configured = Boolean(env.LOCAL_STORAGE_PATH && /^(\/|[A-Za-z]:[\\/])/.test(env.LOCAL_STORAGE_PATH));
    return { storageProvider: "local" as const, storageConfigured: configured, privateBackupsConfigured: configured };
  }
  const storage = new R2Storage(configuration(value));
  const config = configuration(value);
  return { storageProvider: "r2" as const, storageConfigured: Boolean(config.accountId && config.accessKeyId && config.secretAccessKey && !config.secretAccessKey.includes("•") && config.bucketName), privateBackupsConfigured: storage.privateBackupsConfigured };
}
export async function getStorage(value: unknown, context: StorageContext = {}): Promise<StorageProvider> {
  const status = storageStatus(value, context);
  if (status.storageProvider === "local") {
    const { LocalStorage } = await import("./local.js");
    return new LocalStorage(environment(context).LOCAL_STORAGE_PATH || "");
  }
  return new R2Storage(configuration(value));
}
export async function loadStorage(db: DatabaseClient, context: StorageContext = {}) {
  const result = await db.execute("SELECT r2_config_json FROM admin_config LIMIT 1");
  return getStorage(result.rows[0]?.r2_config_json, context);
}

interface BackupReference { kind: "licenx-private-v1"; provider: "local" | "r2"; key: string; location?: string }
function backupReference(value: unknown): BackupReference | null {
  try {
    const ref = JSON.parse(String(value));
    if (ref.kind !== "licenx-private-v1" || !["local", "r2"].includes(ref.provider)) return null;
    assertBackupKey(ref.key);
    return ref;
  } catch { return null; }
}
export function backupRecord(row: Record<string, unknown>) {
  const ref = backupReference(row.r2_url);
  const url = ref ? `/api/storage/backups/${encodeURIComponent(String(row.id))}` : null;
  return { ...row, r2_url: url, download_url: url, provider: ref?.provider ?? "legacy", downloadable: Boolean(ref) };
}
export async function saveBackup(db: DatabaseClient, storage: StorageProvider, csv: string, count: number, now: number) {
  const id = "backup_" + crypto.randomBytes(12).toString("hex");
  const filename = `bulk_licenses_${now}_${crypto.randomBytes(4).toString("hex")}.csv`;
  const key = `backups/${filename}`;
  const data = Buffer.from(csv, "utf8");
  await storage.putBackup(key, data);
  const ref: BackupReference = { kind: "licenx-private-v1", provider: storage.provider, key, location: storage.backupLocation };
  await db.execute({ sql: "INSERT INTO r2_backups (id, filename, record_count, file_size, r2_url, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: [id, filename, count, data.byteLength, JSON.stringify(ref), now] });
  return { success: true, id, provider: storage.provider, url: `/api/storage/backups/${id}` };
}
export async function readBackup(db: DatabaseClient, storage: StorageProvider, id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new StorageError("BACKUP_NOT_FOUND", "Backup not found", 404);
  const result = await db.execute({ sql: "SELECT * FROM r2_backups WHERE id = ?", args: [id] });
  const row = result.rows[0];
  const ref = row && backupReference(row.r2_url);
  if (!ref) throw new StorageError("BACKUP_NOT_FOUND", "Backup requires private storage migration or does not exist", 404);
  if (ref.provider !== storage.provider || ref.location !== storage.backupLocation) throw new StorageError("BACKUP_PROVIDER_MISMATCH", "Backup belongs to a different storage configuration", 409);
  return { ...await storage.readBackup(ref.key), filename: String(row.filename).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0,180) };
}
export const privateBackupHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function prepareAssetUpload(body: Record<string, unknown>) {
  const { filename = "asset.png", contentType = "image/png", dataBase64, folder = "branding" } = body;
  if (folder !== "branding") throw new StorageError("INVALID_ASSET_PATH", "Only branding uploads are supported", 400);
  const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
  if (typeof contentType !== "string" || !extensions[contentType]) throw new StorageError("INVALID_IMAGE_TYPE", "Use PNG, JPEG, GIF, WebP or ICO images", 400);
  if (typeof dataBase64 !== "string" || !dataBase64) throw new StorageError("MISSING_FILE_DATA", "Missing file data", 400);
  const raw = dataBase64.replace(/^data:image\/[A-Za-z.+-]+;base64,/, "");
  if (raw.length > 7_000_000 || raw.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new StorageError("INVALID_FILE_DATA", "Invalid or oversized image data", 400);
  const data = Buffer.from(raw, "base64");
  if (!data.byteLength || data.byteLength > 5 * 1024 * 1024) throw new StorageError("IMAGE_TOO_LARGE", "Images must be at most 5MB", 400);
  const name = String(filename).replace(/[^A-Za-z0-9_-]/g, "_").slice(0,32) || "asset";
  const key = `branding/${Date.now()}_${crypto.randomBytes(8).toString("hex")}_${name}.${extensions[contentType]}`;
  return { key, data, contentType: contentType === "image/vnd.microsoft.icon" ? "image/x-icon" : contentType };
}

export function backupFailure(error: unknown) {
  const failure = storageError(error);
  return { code: failure.code, message: failure.message };
}
