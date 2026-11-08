import type { DatabaseClient } from "../database/contracts.js";
import type { RealtimeIdentity } from "./sessionTickets.js";

interface WsClients { get(id: string): { ws: { close(code?: number, reason?: string): void } } | undefined; }
const BATCH_SIZE = 100;
export function createRealtimeLeaseManager(db: DatabaseClient, clients: WsClients) {
  const connected = new Map<string, RealtimeIdentity>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  function register(id: string, identity: RealtimeIdentity) {
    if (!clients.get(id)) throw new Error("Not connected");
    connected.set(id, identity);
  }
  async function tick(now = Date.now()) {
    if (busy) return;
    busy = true;
    try {
      for (const id of connected.keys()) if (!clients.get(id)) connected.delete(id);
      const entries = [...connected.entries()];
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const ids = [...new Set(batch.map(([, identity]) => identity.deviceId))];
        const placeholders = ids.map(() => "?").join(",");
        const renewed = await db.execute({
          sql: `UPDATE devices SET last_ping_at = ? WHERE id IN
            (SELECT d.id FROM devices d JOIN licenses l ON l.id = d.license_id
              JOIN apps a ON a.id = l.app_id
              WHERE d.id IN (${placeholders}) AND d.status = 'active'
              AND l.status = 'active' AND a.status = 'active'
              AND a.realtime_websocket_enabled = 1
              AND (l.expires_at IS NULL OR l.expires_at > ?)
              AND d.last_ping_at > (? - a.device_lease_seconds * 1000))
            RETURNING id`,
          args: [now, ...ids, now, now],
        });
        const valid = new Set(renewed.rows.map(row => String(row.id)));
        for (const [id, identity] of batch) if (!valid.has(identity.deviceId)) {
          connected.delete(id);
          try { clients.get(id)?.ws.close(4003, "session invalid"); } catch {}
        }
      }
    } finally { busy = false; }
  }
  function start(onError: (error: unknown) => void) {
    if (timer) return;
    timer = setInterval(() => { void tick().catch(onError); }, 60_000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = undefined; connected.clear(); }
  return { register, isRegistered: (id: string) => connected.has(id), tick, start, stop, get count() { return connected.size; } };
}
