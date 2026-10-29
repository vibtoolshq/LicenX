import crypto from "node:crypto";
import type { DatabaseClient } from "./database/contracts.js";
import { generateAdminApiKey } from "./crypto.js";

export class PublicApiControlError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function normalizeAllowedToolOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 255 || value.trim() !== value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password ||
        u.pathname !== "/" || u.search || u.hash || value.includes("*")) return null;
    const origin = u.origin;
    if (value !== origin && value !== origin + "/") return null;
    return origin;
  } catch { return null; }
}

// Historic app-bound registrations must NOT silently gain global read access.
// Only explicit new global registrations (domain.app_id = '') are accepted.
export async function getPublicApiControl(db: DatabaseClient) {
  const settings = await db.execute("SELECT enabled FROM public_license_api_settings WHERE id = 'main' LIMIT 1");
  const items = await db.execute(
    "SELECT d.id, d.domain_origin, d.app_id, d.enabled, d.created_at, d.key_id, k.status AS key_status, " +
    "k.app_id AS key_app_id FROM public_license_api_domains d " +
    "LEFT JOIN admin_api_keys k ON k.id = d.key_id ORDER BY d.created_at DESC",
  );
  return { enabled: Number(settings.rows[0]?.enabled || 0) === 1, domains: items.rows.map(r => {
    const legacyScope = r.app_id !== "" || r.key_app_id != null;
    return {
      id: String(r.id), domain_origin: String(r.domain_origin), app_id: String(r.app_id || ""),
      app_name: "", legacy_scope: legacyScope,
      enabled: !legacyScope && Number(r.enabled) === 1 && r.key_status === "active",
      created_at: Number(r.created_at), key_id: String(r.key_id),
    };
  }) };
}

export async function setPublicApiEnabled(db: DatabaseClient, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new PublicApiControlError("Enabled must be true or false");
  if (enabled) {
    const count = await db.execute(
      "SELECT COUNT(*) AS n FROM public_license_api_domains d JOIN admin_api_keys k ON k.id=d.key_id " +
      "WHERE d.app_id='' AND d.enabled=1 AND k.app_id IS NULL AND k.status='active' " +
      "AND k.permissions_json='[\"licenses:check\"]' AND k.key_prefix LIKE 'vcon_check_%'",
    );
    if (!Number(count.rows[0]?.n)) throw new PublicApiControlError("Register a global domain before enabling the API", 409);
  }
  // Preserve the private rate-limit HMAC key seeded during migration.
  const result = await db.execute({
    sql: "UPDATE public_license_api_settings SET enabled = ? WHERE id = 'main'",
    args: [enabled ? 1 : 0],
  });
  if (result.rowsAffected !== 1) {
    throw new PublicApiControlError("Public API settings are not initialized", 503);
  }
  return { success: true, enabled };
}

export async function createPublicApiDomain(db: DatabaseClient, input: {
  domain_origin?: unknown; name?: unknown; app_id?: unknown;
}) {
  if (input.app_id != null && input.app_id !== "") {
    throw new PublicApiControlError("Public API is global; do not select a License Application");
  }
  const origin = normalizeAllowedToolOrigin(input.domain_origin);
  if (!origin) throw new PublicApiControlError("Provide an exact HTTPS domain origin, without paths or wildcards");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : origin;
  if (name.length > 128) throw new PublicApiControlError("Name too long");
  const transaction = await db.transaction("write");
  try {
    const duplicate = await transaction.execute({ sql: "SELECT id FROM public_license_api_domains WHERE domain_origin = ? LIMIT 1", args: [origin] });
    if (duplicate.rows.length) throw new PublicApiControlError("Domain is already registered; revoke the old entry first", 409);
    const generated = generateAdminApiKey("check");
    const id = crypto.randomUUID();
    const now = Date.now();
    await transaction.execute({
      sql: "INSERT INTO admin_api_keys (id, name, key_prefix, secret_hash, permissions_json, app_id, status, created_at) " +
           "VALUES (?, ?, ?, ?, ?, NULL, 'active', ?)",
      args: [generated.id, name, generated.keyPrefix, generated.secretHash,
        JSON.stringify(["licenses:check"]), now],
    });
    // Empty string is the global-scope marker in the existing NOT NULL column.
    // No destructive database migration or implicit widening of old credentials.
    await transaction.execute({
      sql: "INSERT INTO public_license_api_domains (id, domain_origin, app_id, key_id, enabled, created_at) " +
           "VALUES (?, ?, '', ?, 1, ?)",
      args: [id, origin, generated.id, now],
    });
    await transaction.commit();
    return {
      success: true,
      domain: { id, domain_origin: origin, app_id: "", app_name: "", legacy_scope: false,
        enabled: true, key_id: generated.id, created_at: now },
      secret: generated.secret,
    };
  } catch (e) {
    await transaction.rollback();
    throw e;
  } finally { transaction.close(); }
}

export async function updatePublicApiDomain(db: DatabaseClient, id: string, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new PublicApiControlError("Invalid enabled value");
  const exists = await db.execute({
    sql: "SELECT d.id, d.app_id, k.app_id AS key_app_id FROM public_license_api_domains d " +
         "LEFT JOIN admin_api_keys k ON k.id=d.key_id WHERE d.id=?",
    args: [id],
  });
  if (!exists.rows.length) throw new PublicApiControlError("Domain not found", 404);
  if (enabled && (exists.rows[0].app_id !== "" || exists.rows[0].key_app_id != null)) {
    throw new PublicApiControlError("Legacy app-scoped domain must be revoked and re-registered", 409);
  }
  await db.execute({ sql: "UPDATE public_license_api_domains SET enabled = ? WHERE id = ?", args: [enabled ? 1 : 0, id] });
  return { success: true };
}

export async function revokePublicApiDomain(db: DatabaseClient, id: string) {
  const tx = await db.transaction("write");
  try {
    const found = await tx.execute({ sql: "SELECT key_id FROM public_license_api_domains WHERE id = ?", args: [id] });
    if (!found.rows.length) throw new PublicApiControlError("Domain not found", 404);
    await tx.execute({ sql: "DELETE FROM public_license_api_domains WHERE id = ?", args: [id] });
    await tx.execute({ sql: "UPDATE admin_api_keys SET status='revoked' WHERE id=?", args: [found.rows[0].key_id] });
    await tx.commit();
    return { success: true };
  } catch(e) { await tx.rollback(); throw e; }
  finally { tx.close(); }
}
