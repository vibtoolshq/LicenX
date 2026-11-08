import type { DatabaseClient } from "../database/contracts.js";
export interface RealtimeDbEvent {
  id: number; event_type: string; app_id: string | null;
  license_id: string | null; device_id: string | null; created_at: number;
}
export async function currentRealtimeCursor(db: DatabaseClient): Promise<number> {
  const r = await db.execute("SELECT COALESCE(MAX(id), 0) AS version FROM realtime_events");
  return Number(r.rows[0]?.version || 0);
}
export async function eventsAfter(db: DatabaseClient, version: number): Promise<RealtimeDbEvent[]> {
  const r = await db.execute({
    sql: "SELECT id, event_type, app_id, license_id, device_id, created_at FROM realtime_events WHERE id > ? ORDER BY id ASC LIMIT 200",
    args: [version],
  });
  return r.rows.map(x => ({
    id: Number(x.id), event_type: String(x.event_type),
    app_id: x.app_id ? String(x.app_id) : null,
    license_id: x.license_id ? String(x.license_id) : null,
    device_id: x.device_id ? String(x.device_id) : null,
    created_at: Number(x.created_at),
  }));
}
export function eventAffects(
  e: RealtimeDbEvent, identity: {appId: string; licenseId: string; deviceId: string},
): boolean {
  return e.device_id ? e.device_id === identity.deviceId :
    e.license_id ? e.license_id === identity.licenseId :
    e.app_id ? e.app_id === identity.appId : false;
}
