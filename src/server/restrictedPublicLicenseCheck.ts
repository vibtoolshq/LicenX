/** Restricted server-to-server license membership check. Never activates or binds a license. */
import crypto from "node:crypto";
import type { DatabaseClient } from "./database/contracts.js";
import { hashAdminApiSecret } from "./crypto.js";
import { normalizeAllowedToolOrigin } from "./publicLicenseApiControl.js";

export const PUBLIC_LICENSE_CHECK_PATH = "/v1/public/license/check";
export const PUBLIC_CHECK_MAX_BODY_BYTES = 1024;
const RESPONSE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export type CheckResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};
type CheckParams = {
  db: DatabaseClient;
  enabled?: string;
  rateSecret?: string;
  clientIp: string;
  authorization?: string | null;
  origin?: string | null;
  claimedToolOrigin?: string | null;
  contentType?: string | null;
  input: unknown;
  method?: string;
  now?: number;
};

function output(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): CheckResponse {
  return { status, body, headers: { ...RESPONSE_HEADERS, ...extra } };
}
function digest(key: string, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

/** One atomic SQL operation per counter; shared across PostgreSQL/SQLite/replicas. */
export async function consumePublicCheckQuota(
  db: DatabaseClient,
  secret: string,
  label: string,
  subject: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const bucketKey = digest(secret, label + "\0" + subject);
  const cutoff = now - windowMs;
  const result = await db.execute({
    sql: `INSERT INTO public_license_check_limits (bucket_key, window_start, requests)
      VALUES (?, ?, 1)
      ON CONFLICT(bucket_key) DO UPDATE SET
        requests = CASE WHEN public_license_check_limits.window_start <= ? THEN 1
                        ELSE public_license_check_limits.requests + 1 END,
        window_start = CASE WHEN public_license_check_limits.window_start <= ? THEN ?
                            ELSE public_license_check_limits.window_start END
      RETURNING requests`,
    args: [bucketKey, now, cutoff, cutoff, now],
  });
  return Number(result.rows[0]?.requests || 0) <= max;
}

export type PublicLicenseStatus = {
  valid: boolean;
  status: string;
  app: { name: string; slug: string } | null;
  validity_type: string | null;
  validity_value: number | null;
  expires_at: number | null;
  expires_in_seconds: number | null;
  checked_at: number;
};

/** A read-only snapshot across all LicenX applications, not an activation operation. */
export function evaluatePublicLicense(
  row: Record<string, unknown> | null,
  now: number,
): PublicLicenseStatus {
  const base: PublicLicenseStatus = {
    valid: false, status: "not_valid", app: null,
    validity_type: null, validity_value: null, expires_at: null,
    expires_in_seconds: null, checked_at: now,
  };
  if (!row) return base;
  const app = typeof row.app_name === "string" && typeof row.app_slug === "string"
    ? { name: row.app_name, slug: row.app_slug } : null;
  const validity_type = typeof row.validity_type === "string" ? row.validity_type : null;
  const value = row.validity_value == null ? null : Number(row.validity_value);
  const validity_value = value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const rawExpiry = row.expires_at == null ? null : Number(row.expires_at);
  const expires_at = rawExpiry != null && Number.isSafeInteger(rawExpiry) ? rawExpiry : null;
  const expires_in_seconds = expires_at == null ? null : Math.max(0, Math.ceil((expires_at - now) / 1000));
  const known: PublicLicenseStatus = {
    ...base, app, validity_type, validity_value, expires_at, expires_in_seconds,
  };
  if (row.app_status !== "active") return { ...known, status: "inactive_app" };
  if (row.status !== "active") {
    const status = String(row.status ?? "not_valid");
    return { ...known, status: ["revoked", "suspended", "expired"].includes(status) ? status : "not_valid" };
  }
  if (rawExpiry !== null && expires_at === null) return { ...known, status: "not_valid" };
  if (expires_at !== null && expires_at <= now) return { ...known, status: "expired" };
  if (validity_type !== "lifetime" && row.activated_at == null) {
    return { ...known, status: "not_activated", expires_in_seconds: null };
  }
  if (validity_type !== "lifetime" && expires_at === null) {
    return { ...known, status: "not_valid" };
  }
  return { ...known, valid: true, status: "active" };
}

export async function runRestrictedPublicLicenseCheck(params: CheckParams): Promise<CheckResponse> {
  const { db, clientIp, authorization, origin, contentType, input } = params;
  const now = params.now ?? Date.now();
  if (params.enabled === "false") {
    return output(503, { valid: false, code: "UNAVAILABLE" });
  }
  if ((params.method ?? "POST") !== "POST") return output(405, { code: "METHOD_NOT_ALLOWED" }, { Allow: "POST" });
  // Static browsers cannot hold a private consumer credential. Require backend-to-backend requests.
  if (origin) return output(403, { valid: false, code: "FORBIDDEN" });
  const requestedDomain = normalizeAllowedToolOrigin(params.claimedToolOrigin);
  if (!requestedDomain) return output(403, { valid: false, code: "FORBIDDEN" });
  if (!/^application\/json(?:\s*;|$)/i.test(contentType || "")) {
    return output(400, { valid: false, code: "INVALID_REQUEST" });
  }
  try {
    const config = await db.execute("SELECT enabled, secret_key FROM public_license_api_settings WHERE id='main' LIMIT 1");
    if (Number(config.rows[0]?.enabled || 0) !== 1) return output(503, { valid: false, code: "UNAVAILABLE" });
    const rateKey = params.rateSecret && params.rateSecret.length >= 32
      ? params.rateSecret : String(config.rows[0]?.secret_key || "");
    if (rateKey.length < 32) return output(503, { valid: false, code: "UNAVAILABLE" });
    if (!(await consumePublicCheckQuota(db, rateKey, "ip", clientIp || "unknown", 20, 60_000, now)) ||
        !(await consumePublicCheckQuota(db, rateKey, "global", "all", 10000, 60_000, now))) {
      return output(429, { valid: false, code: "RATE_LIMITED" }, { "Retry-After": "60" });
    }
    if (!authorization || !/^Bearer vcon_sec_[a-f0-9]{48}$/.test(authorization)) {
      return output(401, { valid: false, code: "UNAUTHORIZED" });
    }
    const keyHash = hashAdminApiSecret(authorization.substring(7));
    const found = await db.execute({
      sql: "SELECT id, key_prefix, permissions_json, app_id, status FROM admin_api_keys WHERE secret_hash = ? LIMIT 1",
      args: [keyHash],
    });
    const consumer = found.rows[0];
    let permissions: unknown;
    try { permissions = consumer && JSON.parse(String(consumer.permissions_json || "[]")); } catch { permissions = null; }
    if (!consumer || consumer.status !== "active" ||
        consumer.app_id != null ||
        !String(consumer.key_prefix).startsWith("vcon_check_") ||
        !Array.isArray(permissions) || permissions.length !== 1 || permissions[0] !== "licenses:check") {
      return output(401, { valid: false, code: "UNAUTHORIZED" });
    }
    const domain = await db.execute({
      sql: "SELECT d.id FROM public_license_api_domains d " +
           "WHERE d.key_id=? AND d.app_id='' AND d.domain_origin=? AND d.enabled=1 LIMIT 1",
      args: [consumer.id, requestedDomain],
    });
    if (!domain.rows.length) return output(403, { valid: false, code: "FORBIDDEN" });
    const id = String(consumer.id);
    if (!(await consumePublicCheckQuota(db, rateKey, "consumer", id, 120, 60_000, now)) ||
        !(await consumePublicCheckQuota(db, rateKey, "consumer-ip", id + "\0" + clientIp, 60, 60_000, now))) {
      return output(429, { valid: false, code: "RATE_LIMITED" }, { "Retry-After": "60" });
    }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        typeof (input as Record<string, unknown>).license_key !== "string") {
      return output(400, { valid: false, code: "INVALID_REQUEST" });
    }
    const key = ((input as Record<string, unknown>).license_key as string).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,128}$/.test(key)) return output(400, { valid: false, code: "INVALID_REQUEST" });
    const lic = await db.execute({
      sql: `SELECT l.status, l.expires_at, l.activated_at, l.validity_type, l.validity_value,
                   a.display_name AS app_name, a.app_slug, a.status AS app_status
            FROM licenses l JOIN apps a ON a.id = l.app_id
            WHERE l.key = ? LIMIT 1`,
      args: [key],
    });
    const evaluated = evaluatePublicLicense(lic.rows.length ? lic.rows[0] : null, now);
    if (!evaluated.valid &&
        !(await consumePublicCheckQuota(db, rateKey, "invalid", id + "\0" + clientIp, 10, 900_000, now))) {
      return output(429, { valid: false, code: "RATE_LIMITED" }, { "Retry-After": "900" });
    }
    // Expire old telemetry independently; never touch license, app or device state.
    if (crypto.randomInt(128) === 0) {
      await db.execute({ sql: "DELETE FROM public_license_check_limits WHERE window_start < ?", args: [now - 3_600_000] });
    }
    return output(200, evaluated);
  } catch {
    return output(503, { valid: false, code: "UNAVAILABLE" });
  }
}
