import { canonicalJson, signPayload } from "../crypto.js";
import type { DatabaseClient } from "../database/contracts.js";
import { currentRealtimeCursor, eventsAfter, eventAffects } from "./eventCursor.js";
import type { RealtimeIdentity } from "./sessionTickets.js";

interface WsClients {
  broadcast(value: unknown, filter?: (client: { identity: RealtimeIdentity }) => boolean): number;
}
export function createRealtimeEventPublisher(db: DatabaseClient, clients: WsClients, afterPublish?: () => Promise<void>) {
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  async function init() { cursor = await currentRealtimeCursor(db); }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const events = await eventsAfter(db, cursor);
      if (!events.length) return;
      const keyResult = await db.execute("SELECT ed25519_private_key FROM admin_config LIMIT 1");
      const key = keyResult.rows[0]?.ed25519_private_key;
      if (typeof key !== "string" || !key) throw new Error("Realtime event signing unavailable");
      for (const event of events) {
        if (!Number.isSafeInteger(event.id) || event.id <= cursor) throw new Error("Invalid event cursor");
        const time = Date.now();
        const payload = {
          type: "license.state_changed", event_id: String(event.id), version: event.id,
          event_type: event.event_type, app_id: event.app_id, license_id: event.license_id,
          device_id: event.device_id, issued_at: time, expires_at: time + 30_000,
        };
        const signature = signPayload(canonicalJson(payload), key);
        clients.broadcast({ ...payload, signature }, client => eventAffects(event, client.identity));
        cursor = event.id;
      }
      if (afterPublish) await afterPublish();
    } finally { busy = false; }
  }
  function start(onError: (error: unknown) => void) {
    if (timer) return;
    timer = setInterval(() => { void tick().catch(onError); }, 2000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = undefined; }
  async function snapshot(identity: RealtimeIdentity) {
    // Signed per-App policy is authoritative; the SDK must never infer
    // network-error UI continuity from an unsigned admin request or WS welcome.
    const app = await db.execute({
      sql: "SELECT keep_login_on_network_error FROM apps WHERE id = ? AND status = 'active'",
      args: [identity.appId],
    });
    if (!app.rows[0]) throw new Error("Realtime app policy unavailable");
    const payload = {
      type: "license.snapshot", version: await currentRealtimeCursor(db),
      app_id: identity.appId, license_id: identity.licenseId,
      device_id: identity.deviceId, valid: true, server_time: Date.now(),
      keep_login_on_network_error: Number(app.rows[0].keep_login_on_network_error) === 1,
    };
    const result = await db.execute("SELECT ed25519_private_key FROM admin_config LIMIT 1");
    const key = result.rows[0]?.ed25519_private_key;
    if (typeof key !== "string" || !key) throw new Error("Snapshot signing unavailable");
    return { ...payload, signature: signPayload(canonicalJson(payload), key) };
  }
  return { init, tick, start, stop, snapshot, get cursor() { return cursor; } };
}
