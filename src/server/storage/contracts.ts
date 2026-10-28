export class StorageError extends Error {
  constructor(public code: string, message: string, public status = 503) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StoredObject { data: Uint8Array; contentType: string }
export interface StorageProvider {
  provider: "local" | "r2";
  backupLocation?: string;
  privateBackupsConfigured: boolean;
  putPublic(key: string, data: Uint8Array, contentType: string): Promise<{ key: string; url: string }>;
  readPublic(key: string): Promise<StoredObject>;
  putBackup(key: string, data: Uint8Array): Promise<void>;
  readBackup(key: string): Promise<StoredObject>;
}

const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", svg: "image/svg+xml",
};

export function assertPublicAssetKey(key: string): void {
  if (!key || key.includes("..") || /[\\%\x00-\x1f]/.test(key) || key.startsWith("/")) {
    throw new StorageError("INVALID_ASSET_PATH", "Invalid asset path", 400);
  }
  if (!/^branding\/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(png|jpe?g|gif|webp|ico|svg)$/i.test(key)) {
    throw new StorageError("ASSET_NOT_FOUND", "Asset not found", 404);
  }
}

export function assertBackupKey(key: string): void {
  if (!/^backups\/[A-Za-z0-9][A-Za-z0-9_-]{0,160}\.csv$/.test(key)) {
    throw new StorageError("INVALID_BACKUP_PATH", "Invalid backup path", 400);
  }
}

export function assetContentType(key: string): string {
  assertPublicAssetKey(key);
  return imageTypes[key.split(".").pop()!.toLowerCase()];
}

export const publicAssetHeaders = {
  "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

export function storageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError("STORAGE_UNAVAILABLE", "Storage operation failed");
}
