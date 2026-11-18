/** SDK-STAT-01: opt-in, strictly bounded, per-device client-reported statistics.
 * This data is never an authentication, billing or license authorization source.
 */
import crypto from "node:crypto";
import type { DatabaseExecutor } from "./database/contracts.js";

const MAX_PAIRS = 40;
const MAX_BYTES = 4096;
const TOKEN_AGE_MS = 60 * 60 * 1000;
const MIN_REPORT_SPACING_MS = 3000;
const reportIpLimits = new Map<string, { since: number; count: number }>();
export function allowDeviceStatsIp(ip: string, now = Date.now()): boolean {
  const safeIp = typeof ip === "string" ? ip.slice(0, 128) : "unknown";
  let window = reportIpLimits.get(safeIp);
  if (!window || now - window.since >= 60_000) {
    if (!window && reportIpLimits.size >= 4096) {
      reportIpLimits.delete(reportIpLimits.keys().next().value!);
    }
    window = { since: now, count: 0 };
    reportIpLimits.set(safeIp, window);
  }
  window.count += 1;
  return window.count <= 1000;
}
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const FORBIDDEN = /(?:password|passwd|secret|token|private|credential|cookie|authorization|license.?key|hwid|bearer|access.?key|api.?key)/i;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

export class DeviceStatsError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function normalizeDeviceStats(input: unknown): Record<string, string | number | boolean | null> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DeviceStatsError(400, "INVALID_STATS");
  const source = input as Record<string, unknown>;
  const labels = Object.keys(source);
  if (!labels.length || labels.length > MAX_PAIRS) throw new DeviceStatsError(400, "INVALID_STATS");
  const result: Record<string, string | number | boolean | null> = Object.create(null);
  for (const label of labels) {
    if (!label || label.length > 64 || label !== label.trim() || CONTROL.test(label) ||
        RESERVED.has(label.toLowerCase()) || FORBIDDEN.test(label)) {
      throw new DeviceStatsError(400, "INVALID_STAT_LABEL");
    }
    const value = source[label];
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new DeviceStatsError(400, "INVALID_STAT_VALUE");
    }
    if (typeof value === "string" && (value.length > 256 || CONTROL.test(value))) {
      throw new DeviceStatsError(400, "INVALID_STAT_VALUE");
    }
    if (typeof value === "number" && (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new DeviceStatsError(400, "INVALID_STAT_VALUE");
    }
    result[label] = value as string | number | boolean | null;
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BYTES) {
    throw new DeviceStatsError(413, "STATS_TOO_LARGE");
  }
  return result;
}

export async function issueDeviceStatsSession(db: DatabaseExecutor, deviceId: string, now = Date.now()): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  await db.execute({
    sql: `INSERT INTO device_stat_snapshots
      (device_id, stats_json, reported_at, report_token_hash, report_token_expires)
      VALUES (?, '{}', 0, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
      report_token_hash = excluded.report_token_hash,
      report_token_expires = excluded.report_token_expires`,
    args: [deviceId, hash, now + TOKEN_AGE_MS],
  });
  return token;
}

/** Refresh only a previously issued, RAM-held reporter session.
 * A public license-key/HWID heartbeat cannot mint the first report token.
 */
export async function refreshDeviceStatsSession(
  db: DatabaseExecutor,
  deviceId: string,
  previous: unknown,
  now = Date.now(),
): Promise<string | undefined> {
  if (typeof previous !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(previous)) return undefined;
  const priorHash = crypto.createHash("sha256").update(previous, "utf8").digest("hex");
  const next = crypto.randomBytes(32).toString("base64url");
  const nextHash = crypto.createHash("sha256").update(next, "utf8").digest("hex");
  const result = await db.execute({
    sql: `UPDATE device_stat_snapshots
      SET report_token_hash = ?, report_token_expires = ?
      WHERE device_id = ? AND report_token_hash = ? AND report_token_expires > ?
      RETURNING device_id`,
    args: [nextHash, now + TOKEN_AGE_MS, deviceId, priorHash, now],
  });
  return result.rows.length === 1 && String(result.rows[0].device_id) === deviceId
    ? next : undefined;
}

export async function acceptDeviceStats(
  db: DatabaseExecutor,
  bearer: unknown,
  statsInput: unknown,
  now = Date.now(),
): Promise<void> {
  if (typeof bearer !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(bearer)) {
    throw new DeviceStatsError(401, "STATS_UNAUTHORIZED");
  }
  const stats = normalizeDeviceStats(statsInput);
  const hash = crypto.createHash("sha256").update(bearer, "utf8").digest("hex");
  const match = await db.execute({
    sql: `SELECT s.device_id, s.report_token_hash, s.report_token_expires,
      s.reported_at, d.status AS device_status, d.last_ping_at,
      l.status AS license_status, l.expires_at,
      l.app_id, a.status AS app_status, a.device_lease_seconds
      FROM device_stat_snapshots s
      JOIN devices d ON d.id = s.device_id
      JOIN licenses l ON l.id = d.license_id
      LEFT JOIN apps a ON a.id = l.app_id
      WHERE s.report_token_hash = ? LIMIT 1`,
    args: [hash],
  });
  const row = match.rows[0];
  if (!row || typeof row.report_token_hash !== "string" ||
      !crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(row.report_token_hash, "hex")) ||
      Number(row.report_token_expires) <= now ||
      row.device_status !== "active" || row.license_status !== "active" ||
      (row.app_id !== null && row.app_status !== "active") ||
      (row.expires_at !== null && Number(row.expires_at) <= now)) {
    throw new DeviceStatsError(401, "STATS_UNAUTHORIZED");
  }
  const lease = Number(row.device_lease_seconds);
  const seconds = Number.isSafeInteger(lease) && lease > 0 ? lease : 7200;
  if (Number(row.last_ping_at) <= now - seconds * 1000) {
    throw new DeviceStatsError(401, "STATS_UNAUTHORIZED");
  }
  const writtenAt = Number(row.reported_at);
  if (writtenAt && writtenAt > now - MIN_REPORT_SPACING_MS) {
    throw new DeviceStatsError(429, "STATS_RATE_LIMITED");
  }
  // The final conditional UPDATE serializes concurrent uploads and verifies
  // active device/license/app state again at write time.
  const saved = await db.execute({
    sql: `UPDATE device_stat_snapshots SET stats_json = ?, reported_at = ?
      WHERE device_id = ? AND report_token_hash = ? AND report_token_expires > ?
      AND (reported_at = 0 OR reported_at <= ?)
      AND EXISTS (SELECT 1 FROM devices d JOIN licenses l ON l.id = d.license_id
        LEFT JOIN apps a ON a.id = l.app_id WHERE d.id = device_stat_snapshots.device_id
        AND d.status = 'active' AND l.status = 'active'
        AND (l.expires_at IS NULL OR l.expires_at > ?)
        AND (l.app_id IS NULL OR a.status = 'active'))`,
    args: [JSON.stringify(stats), now, row.device_id as string, hash, now,
      now - MIN_REPORT_SPACING_MS, now],
  });
  if (saved.rowsAffected !== 1) throw new DeviceStatsError(429, "STATS_RATE_LIMITED");
}

export async function getLicenseDeviceStats(db: DatabaseExecutor, licenseId: string) {
  const rows = await db.execute({
    sql: `SELECT s.device_id, s.stats_json, s.reported_at, d.status
      FROM device_stat_snapshots s JOIN devices d ON d.id = s.device_id
      WHERE d.license_id = ? ORDER BY s.reported_at DESC LIMIT 500`,
    args: [licenseId],
  });
  return rows.rows.map((row) => {
    let stats: Record<string, string | number | boolean | null> = {};
    try {
      if (Number(row.reported_at) > 0) stats = normalizeDeviceStats(JSON.parse(String(row.stats_json)));
    } catch { stats = {}; }
    return { device_id: String(row.device_id), stats,
      reported_at: Number(row.reported_at) || null, active: row.status === "active" };
  });
}
