import type { DatabaseClient } from "../database/contracts.js";
import type { RealtimeIdentity } from "./sessionTickets.js";

/** Only trusted post-hello sockets are counted; no keys, HWIDs, IPs or payloads. */
interface PresenceSocket {
  readyState: number;
  once(event: "close" | "error", listener: () => void): unknown;
  off(event: "close" | "error", listener: () => void): unknown;
  close(code?: number, reason?: string): void;
}
type PresenceEntry = {
  appId: string;
  licenseId: string;
  deviceId: string;
  socket: PresenceSocket;
  cleanup: () => void;
};
const entries = new Map<string, PresenceEntry>();
let transportEnabled = false;

export function setRealtimePresenceEnabled(enabled: boolean): void {
  transportEnabled = enabled;
  if (!enabled) {
    for (const entry of entries.values()) entry.cleanup();
    entries.clear();
  }
}

export function registerRealtimePresence(
  clientId: string,
  identity: RealtimeIdentity,
  socket: PresenceSocket,
): void {
  if (!transportEnabled || socket.readyState !== 1) return;
  entries.get(clientId)?.cleanup();
  const onClose = () => unregisterRealtimePresence(clientId);
  const cleanup = () => {
    socket.off("close", onClose);
    socket.off("error", onClose);
  };
  entries.set(clientId, {
    appId: identity.appId,
    licenseId: identity.licenseId,
    deviceId: identity.deviceId,
    socket,
    cleanup,
  });
  socket.once("close", onClose);
  socket.once("error", onClose);
}

export function unregisterRealtimePresence(clientId: string): void {
  const current = entries.get(clientId);
  if (!current) return;
  entries.delete(clientId);
  current.cleanup();
}

/** Called AFTER the authenticated admin unbind has committed. */
export function closeRealtimeDeviceSessions(deviceId: string): number {
  let closed = 0;
  for (const [clientId, item] of entries) {
    if (item.deviceId !== deviceId) continue;
    unregisterRealtimePresence(clientId);
    closed++;
    try { item.socket.close(4003, "device unbound"); } catch { /* already closed */ }
  }
  return closed;
}

export interface RealtimePresenceReport {
  transportEnabled: boolean;
  connectedNow: number;
  activeSockets: number;
  boundActive: number;
  staleBound: number;
  connectedDeviceIds: string[];
  observedAt: number;
  scope: string | null;
}

export async function getRealtimePresenceReport(
  db: DatabaseClient,
  filter: { appId?: string; deviceIds?: string[] } = {},
): Promise<RealtimePresenceReport> {
  const now = Date.now();
  const appId = filter.appId ?? null;
  // Avoid nullable untyped SQL bind values for PostgreSQL compatibility.
  let sql = `SELECT COUNT(*) AS bound_active,
      COALESCE(SUM(CASE
        WHEN d.last_ping_at <= (? - COALESCE(a.device_lease_seconds, 7200) * 1000)
        THEN 1 ELSE 0 END), 0) AS stale_bound
      FROM devices d
      JOIN licenses l ON l.id = d.license_id
      LEFT JOIN apps a ON a.id = l.app_id
      WHERE d.status = 'active' AND l.status = 'active'
        AND (l.expires_at IS NULL OR l.expires_at > ?)
        AND (l.app_id IS NULL OR a.status = 'active')`;
  const args: Array<string | number> = [now, now];
  if (appId !== null) { sql += " AND l.app_id = ?"; args.push(appId); }
  const result = await db.execute({ sql, args });
  const first = result.rows[0];
  const socketEntries = [...entries.values()].filter(
    item => item.socket.readyState === 1 && (appId === null || item.appId === appId),
  );
  const distinctDevices = new Set(socketEntries.map(item => item.deviceId));
  const requested = new Set(filter.deviceIds ?? []);
  return {
    transportEnabled,
    connectedNow: distinctDevices.size,
    activeSockets: socketEntries.length,
    boundActive: Number(first?.bound_active ?? 0),
    staleBound: Number(first?.stale_bound ?? 0),
    // Return only IDs the already-authorized Admin UI explicitly requested.
    connectedDeviceIds: [...distinctDevices].filter(id => requested.has(id)),
    observedAt: now,
    scope: appId,
  };
}
