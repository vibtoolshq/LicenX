/** Isolated, default-off Admin WSS transport. No license channels, secrets or resource events. */
import crypto from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { ADMIN_SESSION_COOKIE, getCookieValue } from "../adminAuthCookies.js";
import { verifySessionToken } from "../crypto.js";
import { getDbClient } from "../db.js";
import { recordInternalDiagnostic } from "../diagnostics.js";

export const ADMIN_REALTIME_PATH = "/api/admin/realtime";
export const ADMIN_REALTIME_PROOF_COOKIE = "vcon_admin_realtime_proof";
const BOOTSTRAP_TTL_MS = 30_000;
const MAX_PENDING = 256;
const MAX_CONNECTED = 32;
const MAX_REVOKED = 4096;
const SESSION_CHECK_MS = 15_000;
const CHANGE_DEBOUNCE_MS = 80;
const MAX_PENDING_CHANGES = 128;
const MAX_CLIENT_BUFFER = 64 * 1024;
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type AdminRealtimeChange =
  | { type: "presence.changed"; app_id: string | null }
  | { type: "resource.changed"; app_id: string | null; resource: "apps" | "licenses" | "devices" | "logs" | "stats"; source_version?: number }
  | { type: "stream.resync"; app_id: string | null; reason: "cursor" | "backlog" | "log_overflow" };
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

type Pending = { sessionHash: string; expiresAt: number };
type Connection = {
  socket: WebSocket;
  sessionHash: string;
  username: string;
  secretHash: string;
  expiresAt: number;
  scope: string | null;
  sequence: number;
  streamId: string;
};

export function isAllowedAdminRealtimeOrigin(
  origin: string | undefined,
  host: string | undefined,
  production = process.env.NODE_ENV === "production",
): boolean {
  if (!origin || !host || host.includes("/") || host.includes("@")) return false;
  try {
    const parsed = new URL(origin);
    const hostParsed = new URL("http://" + host);
    if (origin !== parsed.origin || parsed.host !== hostParsed.host) return false;
    if (parsed.protocol === "https:") return true;
    return !production && parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]");
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Socket, code: 400 | 401 | 403 | 429 | 503): void {
  const reason = ({ 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    429: "Too Many Requests", 503: "Service Unavailable" } as const)[code];
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
  } else {
    socket.destroy();
  }
}

export interface AdminRealtimeGateway {
  issueBootstrap(sessionToken: string): string | null;
  revokeSession(sessionToken: string): void;
  attach(server: HttpServer): void;
  stop(): Promise<void>;
  sweepSessions(): Promise<void>;
  subscriberCount(): number;
  publishChange(change: AdminRealtimeChange): void;
}

let activeGateway: AdminRealtimeGateway | null = null;
export function setActiveAdminRealtimeGateway(gateway: AdminRealtimeGateway | null): void {
  activeGateway = gateway;
}
export function getActiveAdminRealtimeGateway(): AdminRealtimeGateway | null {
  return activeGateway;
}
export function revokeAdminRealtimeSession(sessionToken: string): void {
  activeGateway?.revokeSession(sessionToken);
}

export function createAdminRealtimeGateway(
  ready: () => boolean = () => true,
): AdminRealtimeGateway {
  const pending = new Map<string, Pending>();
  const connected = new Set<Connection>();
  const revoked = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  let server: HttpServer | null = null;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let pendingUpgrades = 0;
  const pendingChanges = new Map<string, AdminRealtimeChange>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function subscriberCount(): number {
    let count = 0;
    for (const entry of connected) if (entry.socket.readyState === WebSocket.OPEN) count++;
    return count;
  }

  function flushChanges(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (stopping) { pendingChanges.clear(); return; }
    const events = [...pendingChanges.values()];
    pendingChanges.clear();
    for (const event of events) {
      const data = { ...event, observedAt: Date.now() };
      for (const entry of connected) {
        if (entry.socket.readyState !== WebSocket.OPEN ||
            (entry.scope !== null && event.app_id !== null && event.app_id !== entry.scope)) continue;
        if (entry.socket.bufferedAmount > MAX_CLIENT_BUFFER) {
          entry.socket.close(1013, "admin realtime requires resync");
          continue;
        }
        entry.sequence++;
        const payload = JSON.stringify({ ...data, sequence: entry.sequence, stream_id: entry.streamId });
        entry.socket.send(payload, error => { if (error) entry.socket.terminate(); });
      }
    }
  }

  function publishChange(change: AdminRealtimeChange): void {
    if (stopping || subscriberCount() === 0) return;
    if (change.app_id !== null && !APP_ID_PATTERN.test(change.app_id)) {
      change = { type: "stream.resync", app_id: null, reason: "cursor" };
    }
    // Only construct payloads from fixed fields, never pass raw DB rows or credentials.
    let sanitized: AdminRealtimeChange;
    if (change.type === "presence.changed") {
      sanitized = { type: change.type, app_id: change.app_id };
    } else if (change.type === "resource.changed") {
      const allowed = ["apps", "licenses", "devices", "logs", "stats"];
      if (!allowed.includes(change.resource)) return;
      sanitized = { type: change.type, app_id: change.app_id, resource: change.resource };
      if (Number.isSafeInteger(change.source_version) && (change.source_version ?? 0) >= 0) {
        sanitized.source_version = change.source_version;
      }
    } else if (change.type === "stream.resync") {
      sanitized = { type: change.type, app_id: change.app_id,
        reason: ["cursor", "backlog", "log_overflow"].includes(change.reason) ? change.reason : "cursor" };
    } else { return; }
    const key = [sanitized.type, sanitized.app_id ?? "*",
      sanitized.type === "resource.changed" ? sanitized.resource :
      sanitized.type === "stream.resync" ? sanitized.reason : ""].join(":");
    if (!pendingChanges.has(key) && pendingChanges.size >= MAX_PENDING_CHANGES) {
      pendingChanges.clear();
      pendingChanges.set("resync:*", { type: "stream.resync", app_id: null, reason: "backlog" });
    } else {
      const old = pendingChanges.get(key);
      if (old?.type === "resource.changed" && sanitized.type === "resource.changed") {
        sanitized.source_version = Math.max(old.source_version ?? 0, sanitized.source_version ?? 0);
      }
      pendingChanges.set(key, sanitized);
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushChanges, CHANGE_DEBOUNCE_MS);
      flushTimer.unref?.();
    }
  }

  function cleanExpired(now = Date.now()): void {
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
    for (const [key, expiry] of revoked) if (expiry <= now) revoked.delete(key);
  }

  async function readAdminCredentials(): Promise<{ username: string; jwtSecret: string } | null> {
    const row = (await getDbClient().execute(
      "SELECT username, jwt_secret FROM admin_config LIMIT 1",
    )).rows[0];
    if (!row || typeof row.username !== "string" || typeof row.jwt_secret !== "string") return null;
    return { username: row.username, jwtSecret: row.jwt_secret };
  }

  function issueBootstrap(sessionToken: string): string | null {
    if (stopping || !ready() || sessionToken.length > 8192) return null;
    const now = Date.now();
    cleanExpired(now);
    const sessionHash = digest(sessionToken);
    if (revoked.has(sessionHash)) return null;
    // Only the newest one-use bootstrap per session remains usable.
    for (const [key, entry] of pending) if (entry.sessionHash === sessionHash) pending.delete(key);
    if (pending.size >= MAX_PENDING) return null;
    const proof = crypto.randomBytes(32).toString("base64url");
    pending.set(digest(proof), { sessionHash, expiresAt: now + BOOTSTRAP_TTL_MS });
    return `${ADMIN_REALTIME_PROOF_COOKIE}=${proof}; Path=${ADMIN_REALTIME_PATH}; Max-Age=30; HttpOnly; Secure; SameSite=Strict`;
  }

  function revokeSession(sessionToken: string): void {
    if (!sessionToken || sessionToken.length > 8192) return;
    const sessionHash = digest(sessionToken);
    cleanExpired();
    // Fail closed when a bound is exhausted; do not evict live revocations.
    if (revoked.size < MAX_REVOKED || revoked.has(sessionHash)) {
      revoked.set(sessionHash, Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else {
      stopping = true;
    }
    for (const [key, entry] of pending) if (entry.sessionHash === sessionHash) pending.delete(key);
    for (const entry of connected) {
      if (stopping || entry.sessionHash === sessionHash) entry.socket.close(4003, "admin session ended");
    }
  }

  async function sweepSessions(): Promise<void> {
    if (stopping || connected.size === 0) return;
    let current: Awaited<ReturnType<typeof readAdminCredentials>>;
    try {
      current = await readAdminCredentials();
    } catch {
      current = null;
    }
    const now = Date.now();
    cleanExpired(now);
    for (const entry of connected) {
      if (!current || entry.secretHash !== digest(current.jwtSecret) ||
          entry.username !== current.username || entry.expiresAt <= now ||
          revoked.has(entry.sessionHash)) {
        entry.socket.close(4003, "admin session expired");
      }
    }
  }

  const onUpgrade = async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
    let requested: URL;
    try {
      requested = new URL(req.url || "", "http://localhost");
    } catch {
      return;
    }
    if (requested.pathname !== ADMIN_REALTIME_PATH) return; // Preserve existing licensed WSS.
    socket.on("error", () => {});
    if (requested.search || requested.hash) { rejectUpgrade(socket, 400); return; }
    if (stopping || !ready()) { rejectUpgrade(socket, 503); return; }
    if (!isAllowedAdminRealtimeOrigin(req.headers.origin, req.headers.host)) {
      recordInternalDiagnostic("admin_ws", "ws_upgrade", "ADMIN_WS_ORIGIN_DENIED");
      rejectUpgrade(socket, 403);
      return;
    }
    if (connected.size + pendingUpgrades >= MAX_CONNECTED || pendingUpgrades >= 16) {
      rejectUpgrade(socket, 429);
      return;
    }
    const proof = getCookieValue(req.headers.cookie, ADMIN_REALTIME_PROOF_COOKIE);
    const sessionToken = getCookieValue(req.headers.cookie, ADMIN_SESSION_COOKIE);
    if (!proof || !/^[A-Za-z0-9_-]{43}$/.test(proof) || !sessionToken || sessionToken.length > 8192) {
      rejectUpgrade(socket, 401);
      return;
    }
    // One use: consume before doing any asynchronous work, including a failed auth check.
    const entry = pending.get(digest(proof));
    pending.delete(digest(proof));
    const now = Date.now();
    cleanExpired(now);
    const sessionHash = digest(sessionToken);
    if (!entry || entry.expiresAt <= now || entry.sessionHash !== sessionHash ||
        revoked.has(sessionHash)) {
      rejectUpgrade(socket, 401);
      return;
    }
    pendingUpgrades++;
    try {
      const admin = await readAdminCredentials();
      const identity = admin ? verifySessionToken(sessionToken, admin.jwtSecret) : null;
      if (!admin || !identity || identity.username !== admin.username ||
          !Number.isSafeInteger(identity.exp) || identity.exp * 1000 <= Date.now() ||
          !ready() || stopping || revoked.has(sessionHash)) {
        rejectUpgrade(socket, 401);
        return;
      }
      if (connected.size >= MAX_CONNECTED) { rejectUpgrade(socket, 429); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (stopping) { ws.close(1001, "server shutdown"); return; }
        const connection: Connection = {
          socket: ws, sessionHash, username: identity.username,
          secretHash: digest(admin.jwtSecret), expiresAt: identity.exp * 1000,
          scope: null, sequence: 0, streamId: crypto.randomUUID(),
        };
        connected.add(connection);
        ws.on("close", () => connected.delete(connection));
        ws.on("error", () => { connected.delete(connection); ws.terminate(); });
        // Only read-only per-app notification scoping is accepted.
        // The Admin identity is already authenticated and authorized globally.
        ws.on("message", raw => {
          let message: unknown;
          try { message = JSON.parse(raw.toString()); } catch { ws.close(1008, "invalid admin scope"); return; }
          const m = message as Record<string, unknown> | null;
          if (!m || Array.isArray(m) || m.type !== "admin.scope" ||
              (m.app_id !== null && (typeof m.app_id !== "string" || !APP_ID_PATTERN.test(m.app_id))) ||
              Object.keys(m).some(key => key !== "type" && key !== "app_id")) {
            ws.close(1008, "invalid admin scope");
            return;
          }
          connection.scope = m.app_id as string | null;
          ws.send(JSON.stringify({ type: "admin.scoped", app_id: connection.scope,
            observedAt: Date.now(), sequence: connection.sequence, stream_id: connection.streamId }));
        });
        ws.send(JSON.stringify({ type: "admin.ready", observedAt: Date.now(),
          sequence: 0, stream_id: connection.streamId }));
      });
    } catch {
      recordInternalDiagnostic("admin_ws", "ws_upgrade", "ADMIN_WS_UPGRADE_FAILED");
      rejectUpgrade(socket, 503);
    } finally {
      pendingUpgrades--;
    }
  };

  function attach(httpServer: HttpServer): void {
    if (server || stopping) throw new Error("Admin realtime already attached or stopped");
    server = httpServer;
    httpServer.on("upgrade", onUpgrade);
    maintenance = setInterval(() => { void sweepSessions(); }, SESSION_CHECK_MS);
    maintenance.unref?.();
  }

  async function stop(): Promise<void> {
    if (stopping && !server) return;
    stopping = true;
    if (maintenance) clearInterval(maintenance);
    maintenance = undefined;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    pendingChanges.clear();
    server?.off("upgrade", onUpgrade);
    server = null;
    pending.clear();
    revoked.clear();
    for (const entry of connected) entry.socket.terminate();
    connected.clear();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }

  return { issueBootstrap, revokeSession, attach, stop, sweepSessions, subscriberCount, publishChange };
}
