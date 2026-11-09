/** Admin-only, subscriber-gated read-only relay. No SDK payload or database mutation. */
import type { DatabaseClient } from "../database/contracts.js";
import type { AdminRealtimeChange, AdminRealtimeGateway } from "./adminGateway.js";
import { currentRealtimeCursor, eventsAfter, type RealtimeDbEvent } from "./eventCursor.js";

const POLL_INTERVAL_MS = 2_000;
const MAX_LOG_SAMPLE = 200;
const MAX_SCOPED_LOG_APPS = 32;

type Gateway = Pick<AdminRealtimeGateway, "subscriberCount" | "publishChange">;
type LogSample = { id: string; app_slug: string | null; created_at: number };

function affectedResource(event: RealtimeDbEvent): AdminRealtimeChange | null {
  const resource = event.event_type.startsWith("app.") ? "apps" :
    event.event_type.startsWith("license.") ? "licenses" :
    event.event_type.startsWith("device.") ? "devices" : null;
  if (!resource) return null;
  return { type: "resource.changed", resource, app_id: event.app_id, source_version: event.id };
}

export function createAdminEventBridge(db: DatabaseClient, gateway: Gateway) {
  let journalCursor = 0;
  let logSample = new Map<string, LogSample>();
  let initialized = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function readLogs(): Promise<LogSample[]> {
    // Existing created_at DESC index; select only bounded metadata; NEVER select log secrets.
    const result = await db.execute(
      "SELECT id, app_slug, created_at FROM validation_logs ORDER BY created_at DESC, id DESC LIMIT 201",
    );
    return result.rows.slice(0, MAX_LOG_SAMPLE + 1).map(row => ({
      id: String(row.id),
      app_slug: typeof row.app_slug === "string" ? row.app_slug : null,
      created_at: Number(row.created_at),
    }));
  }

  async function relayNewLogs(latest: LogSample[]): Promise<void> {
    const limited = latest.slice(0, MAX_LOG_SAMPLE);
    const newEntries = limited.filter(entry => !logSample.has(entry.id));
    const wasCleared = logSample.size > 0 && limited.length === 0;
    logSample = new Map(limited.map(entry => [entry.id, entry]));
    if (newEntries.length === 0 && !wasCleared) return;
    if (newEntries.length >= MAX_LOG_SAMPLE || latest.length > MAX_LOG_SAMPLE &&
        newEntries.length > MAX_LOG_SAMPLE / 2) {
      gateway.publishChange({ type: "stream.resync", app_id: null, reason: "log_overflow" });
      return;
    }
    if (wasCleared) {
      gateway.publishChange({ type: "resource.changed", app_id: null, resource: "logs" });
      gateway.publishChange({ type: "resource.changed", app_id: null, resource: "stats" });
      return;
    }
    const slugs = [...new Set(newEntries.map(x => x.app_slug).filter(
      (value): value is string => Boolean(value),
    ))];
    if (slugs.length > MAX_SCOPED_LOG_APPS) {
      gateway.publishChange({ type: "stream.resync", app_id: null, reason: "log_overflow" });
      return;
    }
    let appIds = new Map<string, string>();
    if (slugs.length) {
      const result = await db.execute({
        sql: `SELECT id, app_slug FROM apps WHERE app_slug IN (${slugs.map(() => "?").join(",")})`,
        args: slugs,
      });
      appIds = new Map(result.rows.map(row => [String(row.app_slug), String(row.id)]));
    }
    const scopes = new Set<string | null>();
    for (const log of newEntries) scopes.add(log.app_slug ? appIds.get(log.app_slug) ?? null : null);
    for (const scope of scopes) {
      gateway.publishChange({ type: "resource.changed", app_id: scope, resource: "logs" });
    }
    gateway.publishChange({ type: "resource.changed", app_id: null, resource: "stats" });
  }

  async function tick(): Promise<void> {
    if (busy) return;
    if (gateway.subscriberCount() === 0) {
      initialized = false;
      logSample.clear();
      return; // Zero subscribers => zero database reads or journal queries.
    }
    busy = true;
    try {
      if (!initialized) {
        // Fresh subscribers start from a current DB snapshot; their browser will HTTP-resync.
        const [version, logs] = await Promise.all([currentRealtimeCursor(db), readLogs()]);
        journalCursor = version;
        logSample = new Map(logs.slice(0, MAX_LOG_SAMPLE).map(entry => [entry.id, entry]));
        initialized = true;
        return;
      }
      const events = await eventsAfter(db, journalCursor);
      for (const event of events) {
        if (!Number.isSafeInteger(event.id) || event.id <= journalCursor) {
          gateway.publishChange({ type: "stream.resync", app_id: null, reason: "cursor" });
          journalCursor = await currentRealtimeCursor(db);
          break;
        }
        const notification = affectedResource(event);
        if (notification) gateway.publishChange(notification);
        else gateway.publishChange({ type: "stream.resync", app_id: null, reason: "cursor" });
        // App/license/device changes also invalidate overview/metrics.
        gateway.publishChange({ type: "resource.changed", app_id: null, resource: "stats" });
        journalCursor = event.id;
      }
      // 200 events per tick is a hard bound, not a dropped tail; next tick continues.
      if (events.length === 200) {
        gateway.publishChange({ type: "stream.resync", app_id: null, reason: "backlog" });
      }
      await relayNewLogs(await readLogs());
    } finally {
      busy = false;
    }
  }

  function start(onError: (error: unknown) => void): void {
    if (timer) return;
    timer = setInterval(() => { void tick().catch(onError); }, POLL_INTERVAL_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    initialized = false;
    logSample.clear();
  }

  return { start, stop, tick, get cursor() { return journalCursor; } };
}
