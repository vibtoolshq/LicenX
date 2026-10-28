import { getR2Object, uploadToR2, validateR2Config, type R2Config } from "../r2.js";
import { assetContentType, assertBackupKey, assertPublicAssetKey, StorageError, type StorageProvider } from "./contracts.js";

export class R2Storage implements StorageProvider {
  provider = "r2" as const;
  backupLocation?: string;
  privateBackupsConfigured: boolean;
  constructor(private config: R2Config) {
    this.backupLocation = config.privateBucketName?.trim();
    this.privateBackupsConfigured = validateR2Config(config).valid && Boolean(this.backupLocation && this.backupLocation !== config.bucketName.trim());
  }
  private requireConfig(privateObject = false) {
    if (!validateR2Config(this.config).valid) throw new StorageError("STORAGE_NOT_CONFIGURED", "Object storage not configured", 404);
    if (privateObject && !this.privateBackupsConfigured) throw new StorageError("PRIVATE_STORAGE_NOT_CONFIGURED", "Configure a separate private backup bucket with public access disabled", 400);
    return privateObject ? { ...this.config, bucketName: this.backupLocation!, publicUrl: undefined } : this.config;
  }
  async putPublic(key: string, data: Uint8Array, contentType: string) {
    assertPublicAssetKey(key);
    if (contentType !== assetContentType(key) || contentType === "image/svg+xml") throw new StorageError("INVALID_IMAGE_TYPE", "Use PNG, JPEG, GIF, WebP or ICO images", 400);
    const result = await uploadToR2(this.requireConfig(), key, data, contentType);
    if (!result.success) throw new StorageError("STORAGE_WRITE_FAILED", "Object storage upload failed");
    return { key, url: result.url! };
  }
  async readPublic(key: string) {
    assertPublicAssetKey(key);
    const result = await getR2Object(this.requireConfig(), key);
    if (!result.success || !result.data) throw new StorageError("OBJECT_NOT_FOUND", "Asset not found", 404);
    return { data: result.data, contentType: assetContentType(key) };
  }
  async putBackup(key: string, data: Uint8Array) {
    assertBackupKey(key);
    const result = await uploadToR2(this.requireConfig(true), key, data, "text/csv", true);
    if (!result.success) throw new StorageError("STORAGE_WRITE_FAILED", "Private backup upload failed");
  }
  async readBackup(key: string) {
    assertBackupKey(key);
    const result = await getR2Object(this.requireConfig(true), key);
    if (!result.success || !result.data) throw new StorageError("OBJECT_NOT_FOUND", "Backup not found", 404);
    return { data: result.data, contentType: "text/csv; charset=utf-8" };
  }
}
