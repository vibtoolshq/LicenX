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

export async function getPublicApiControl(db: DatabaseClient) {
  const settings = await db.execute("SELECT enabled FROM public_license_api_settings WHERE id = 'main' LIMIT 1");
  const items = await db.execute(
    "SELECT d.id, d.domain_origin, d.app_id, d.enabled, d.created_at, d.key_id, a.display_name AS app_name, k.status AS key_status " +
    "FROM public_license_api_domains d LEFT JOIN apps a ON a.id = d.app_id " +
    "LEFT JOIN admin_api_keys k ON k.id = d.key_id ORDER BY d.created_at DESC",
  );
  return { enabled: Number(settings.rows[0]?.enabled || 0) === 1, domains: items.rows.map(r => ({
    id: String(r.id), domain_origin: String(r.domain_origin), app_id: String(r.app_id),
    app_name: String(r.app_name || ""), enabled: Number(r.enabled) === 1 && r.key_status === "active",
    created_at: Number(r.created_at), key_id: String(r.key_id),
  })) };
}

export async function setPublicApiEnabled(db: DatabaseClient, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new PublicApiControlError("Enabled must be true or false");
  if (enabled) {
    const count = await db.execute(
      "SELECT COUNT(*) AS n FROM public_license_api_domains d JOIN admin_api_keys k ON k.id=d.key_id " +
      "JOIN apps a ON a.id=d.app_id WHERE d.enabled=1 AND k.status='active' AND a.status='active'",
    );
    if (!Number(count.rows[0]?.n)) throw new PublicApiControlError("Register an active domain before enabling the API", 409);
  }
  // Migration seeds the main row and its private rate key. Never insert a row
  // without the required secret_key or overwrite the persisted HMAC seed.
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
  domain_origin?: unknown; app_id?: unknown; name?: unknown;
}) {
  const origin = normalizeAllowedToolOrigin(input.domain_origin);
  if (!origin) throw new PublicApiControlError("Provide an exact HTTPS domain origin, without paths or wildcards");
  if (typeof input.app_id !== "string" || !input.app_id.trim() || input.app_id.length > 256) {
    throw new PublicApiControlError("A valid application must be selected");
  }
  const name = typeof input.name === "string" && input.name.trim()
    ? input.name.trim() : origin;
  if (name.length > 128) throw new PublicApiControlError("Name too long");
  const appId = input.app_id.trim();
  const transaction = await db.transaction("write");
  try {
    const exists = await transaction.execute({ sql: "SELECT id FROM apps WHERE id=? AND status='active' LIMIT 1", args: [appId] });
    if (!exists.rows.length) throw new PublicApiControlError("Application not found or inactive", 404);
    const duplicate = await transaction.execute({ sql: "SELECT id FROM public_license_api_domains WHERE domain_origin = ? LIMIT 1", args: [origin] });
    if (duplicate.rows.length) throw new PublicApiControlError("Domain is already registered", 409);
    const generated = generateAdminApiKey("check");
    const id = crypto.randomUUID();
    const now = Date.now();
    await transaction.execute({
      sql: "INSERT INTO admin_api_keys (id, name, key_prefix, secret_hash, permissions_json, app_id, status, created_at) " +
           "VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
      args: [generated.id, name, generated.keyPrefix, generated.secretHash,
        JSON.stringify(["licenses:check"]), appId, now],
    });
    await transaction.execute({
      sql: "INSERT INTO public_license_api_domains (id, domain_origin, app_id, key_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      args: [id, origin, appId, generated.id, now],
    });
    await transaction.commit();
    return { success: true, domain: { id, domain_origin: origin, app_id: appId, app_name: "", enabled: true, key_id: generated.id, created_at: now }, secret: generated.secret };
  } catch (e) {
    await transaction.rollback();
    throw e;
  } finally { transaction.close(); }
}

export async function updatePublicApiDomain(db: DatabaseClient, id: string, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new PublicApiControlError("Invalid enabled value");
  const exists = await db.execute({ sql: "SELECT id FROM public_license_api_domains WHERE id=?", args: [id] });
  if (!exists.rows.length) throw new PublicApiControlError("Domain not found", 404);
  await db.execute({ sql: "UPDATE public_license_api_domains SET enabled = ? WHERE id = ?", args: [enabled ? 1 : 0, id] });
  return { success: true };
}

export async function revokePublicApiDomain(db: DatabaseClient, id: string) {
  const tx = await db.transaction("write");
  try {
    const found = await tx.execute({ sql: "SELECT key_id FROM public_license_api_domains WHERE id = ?", args: [id] });
    if (!found.rows.length) throw new PublicApiControlError("Domain not found", 404);
    await tx.execute({ sql: "DELETE FROM public_license_api_domains WHERE id = ?", args: [id] });
    // Explicit revocation, not a bulk deletion of unrelated credentials.
    await tx.execute({ sql: "UPDATE admin_api_keys SET status='revoked' WHERE id=?", args: [found.rows[0].key_id] });
    await tx.commit();
    return { success: true };
  } catch(e) { await tx.rollback(); throw e; }
  finally { tx.close(); }
}
