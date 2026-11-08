import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseClient } from "../database/contracts.js";

export interface RealtimeIdentity {
  appId: string;
  licenseId: string;
  deviceId: string;
  hwid: string;
  authenticatedAt: number;
}
type PendingTicket = { identity: RealtimeIdentity; expiresAt: number };
export const REALTIME_TICKET_TTL_MS = 30_000;

export async function validateRealtimeDevice(
  db: DatabaseClient,
  identity: Pick<RealtimeIdentity, "appId" | "licenseId" | "deviceId" | "hwid">,
  now = Date.now(),
): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT d.status AS device_status, d.last_ping_at,
      l.status AS license_status, l.expires_at,
      a.status AS app_status, a.realtime_websocket_enabled, a.device_lease_seconds
      FROM devices d JOIN licenses l ON l.id = d.license_id
      JOIN apps a ON a.id = l.app_id
      WHERE d.id = ? AND d.license_id = ? AND d.hwid = ? AND a.id = ? LIMIT 1`,
    args: [identity.deviceId, identity.licenseId, identity.hwid, identity.appId],
  });
  const row = result.rows[0];
  return Boolean(row && row.device_status === "active" && row.license_status === "active" &&
    row.app_status === "active" && Number(row.realtime_websocket_enabled) === 1 &&
    (!row.expires_at || Number(row.expires_at) > now) &&
    Number(row.last_ping_at) > now - Number(row.device_lease_seconds) * 1000);
}

export function createRealtimeTickets(db: DatabaseClient) {
  const pending = new Map<string, PendingTicket>();
  const attempts = new Map<string, { start: number; count: number }>();

  function allowIssue(remote: string, now = Date.now()): boolean {
    for (const [key, record] of attempts) if (now - record.start >= 60_000) attempts.delete(key);
    if (attempts.size >= 4096) attempts.clear();
    const record = attempts.get(remote);
    if (!record) { attempts.set(remote, { start: now, count: 1 }); return true; }
    record.count++;
    return record.count <= 20;
  }

  async function issue(input: { license_key?: unknown; hwid?: unknown; app_name?: unknown }, remote: string) {
    const { license_key, hwid, app_name } = input;
    if (typeof license_key !== "string" || !license_key.trim() || license_key.length > 160 ||
        typeof hwid !== "string" || !hwid.trim() || hwid.length > 256 ||
        typeof app_name !== "string" || !app_name.trim() || app_name.length > 128) {
      return { status: 400, body: { code: "INVALID_REALTIME_REQUEST" } };
    }
    // Limit each license/device proof, not the shared NAT/proxy IP of bulk clients.
    const bucket = crypto.createHash('sha256').update(remote + ':' + license_key.trim().toUpperCase() + ':' + hwid.trim()).digest('hex');
    if (!allowIssue(bucket)) return { status: 429, body: { code: 'RATE_LIMITED' } };
    const result = await db.execute({
      sql: `SELECT d.id AS device_id, l.id AS license_id, a.id AS app_id, l.activated_at
        FROM devices d JOIN licenses l ON l.id = d.license_id
        JOIN apps a ON a.id = l.app_id
        WHERE l.key = ? AND d.hwid = ? AND a.app_slug = ? LIMIT 1`,
      args: [license_key.trim().toUpperCase(), hwid.trim(), app_name.trim()],
    });
    const row = result.rows[0];
    if (!row || !row.activated_at) return { status: 403, body: { code: "REALTIME_NOT_AUTHORIZED" } };
    const identity: RealtimeIdentity = {
      appId: String(row.app_id), licenseId: String(row.license_id),
      deviceId: String(row.device_id), hwid: hwid.trim(), authenticatedAt: Date.now(),
    };
    if (!(await validateRealtimeDevice(db, identity))) {
      return { status: 403, body: { code: "REALTIME_NOT_AUTHORIZED" } };
    }
    const now = Date.now();
    for (const [hash, value] of pending) if (value.expiresAt <= now) pending.delete(hash);
    if (pending.size >= 8192) return { status: 503, body: { code: "REALTIME_BUSY" } };
    const ticket = crypto.randomBytes(32).toString("base64url");
    pending.set(crypto.createHash("sha256").update(ticket).digest("hex"), {
      identity, expiresAt: now + REALTIME_TICKET_TTL_MS,
    });
    return { status: 200, body: { ticket, expires_in_seconds: 30 } };
  }

  async function authenticate(req: IncomingMessage): Promise<RealtimeIdentity | null> {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !/^Bearer [a-zA-Z0-9_-]{40,60}$/.test(auth)) return null;
    const hash = crypto.createHash("sha256").update(auth.slice(7)).digest("hex");
    const record = pending.get(hash);
    if (!record) return null;
    pending.delete(hash);
    if (record.expiresAt <= Date.now()) return null;
    return (await validateRealtimeDevice(db, record.identity)) ? record.identity : null;
  }
  return { issue, authenticate };
}
