/** LX-S01: bounded, process-local, privacy-minimal diagnostics (not an audit history). */
import crypto from "node:crypto";

const TOKEN_TTL_MS = 15 * 60_000;
const EVENT_TTL_MS = 60 * 60_000;
const MAX_TOKENS = 512;
const MAX_EVENTS = 200;
const MAX_ADMIN_EVENTS_PER_MIN = 20;
const SDK_CODES = new Set([
  "REALTIME_TLS_ERROR", "REALTIME_SOCKET_ERROR", "REALTIME_SECURITY_ERROR",
  "REALTIME_TICKET_ERROR", "REALTIME_TICKET_HTTP_ERROR", "REALTIME_TICKET_DISABLED", "REALTIME_TICKET_FORBIDDEN", "REALTIME_TICKET_UNAVAILABLE", "REALTIME_TICKET_RATE_LIMITED", "REALTIME_TICKET_TRANSPORT_ERROR",
  "SDK_HTTP_TLS_ERROR", "SDK_HTTP_NETWORK_ERROR", "SDK_HTTP_TIMEOUT",
  "SDK_HTTP_UNEXPECTED",
]);
const ADMIN_CODES = new Set(["ADMIN_UI_RENDER_ERROR", "ADMIN_WS_TRANSPORT_ERROR"]);
const INTERNAL_CODES = new Set(["VALIDATION_OK", "SERVER_API_FAILURE",
  "ADMIN_WS_ORIGIN_DENIED", "ADMIN_WS_UPGRADE_FAILED"]);
const SDK_STAGES = new Set(["ticket", "tls_handshake", "ws_upgrade", "snapshot", "heartbeat", "validate"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SafeDiagnostic {
  id: string;
  incident_id: string;
  observed_at: number;
  component: "sdk" | "admin_ui" | "admin_ws" | "server_api";
  stage: string;
  code: string;
  attempt: number;
  tls_verify_code?: number;
}
type Capability = { incidentId: string; expiresAt: number; remaining: number };
const tokens = new Map<string, Capability>();
const events: SafeDiagnostic[] = [];
let adminWindow = 0;
let adminCount = 0;
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const safeAttempt = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 20;

function prune(now: number): void {
  for (const [key, value] of tokens) if (value.expiresAt <= now) tokens.delete(key);
  while (events.length && events[0].observed_at < now - EVENT_TTL_MS) events.shift();
  while (events.length > MAX_EVENTS) events.shift();
}
function record(event: Omit<SafeDiagnostic, "id" | "observed_at">): SafeDiagnostic {
  const now = Date.now();
  prune(now);
  const saved: SafeDiagnostic = { id: crypto.randomUUID(), observed_at: now, ...event };
  events.push(saved);
  if (events.length > MAX_EVENTS) events.shift();
  return { ...saved };
}
export function issueSdkDiagnosticCapability(): { token: string; incident_id: string } {
  const now = Date.now();
  prune(now);
  if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value!);
  const token = crypto.randomBytes(32).toString("base64url");
  const incident_id = crypto.randomUUID();
  tokens.set(digest(token), { incidentId: incident_id, expiresAt: now + TOKEN_TTL_MS, remaining: 8 });
  return { token, incident_id };
}
export function recordInternalDiagnostic(
  component: "admin_ws" | "server_api",
  stage: string,
  code: string,
  incidentId?: string,
): SafeDiagnostic | null {
  if (!INTERNAL_CODES.has(code) || !["validate", "request", "ws_upgrade"].includes(stage)) return null;
  return record({ component, stage, code, incident_id: incidentId && UUID.test(incidentId) ? incidentId : crypto.randomUUID(), attempt: 0 });
}
export function ingestSdkDiagnostic(token: unknown, body: unknown):
  "accepted" | "unauthorized" | "invalid" | "rate_limited" {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return "unauthorized";
  const now = Date.now();
  prune(now);
  const key = digest(token);
  const entry = tokens.get(key);
  if (!entry || entry.expiresAt <= now) return "unauthorized";
  if (entry.remaining <= 0) return "rate_limited";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "invalid";
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(k => !["stage", "code", "attempt", "tls_verify_code"].includes(k))) return "invalid";
  if (typeof value.stage !== "string" || !SDK_STAGES.has(value.stage) ||
      typeof value.code !== "string" || !SDK_CODES.has(value.code) ||
      !safeAttempt(value.attempt)) return "invalid";
  const verifyCode = value.tls_verify_code;
  if (verifyCode !== undefined &&
      (value.stage !== "tls_handshake" || value.code !== "REALTIME_TLS_ERROR" && value.code !== "SDK_HTTP_TLS_ERROR" ||
       !Number.isSafeInteger(verifyCode) || Number(verifyCode) < 0 || Number(verifyCode) > 1024)) return "invalid";
  entry.remaining--;
  record({
    component: "sdk", incident_id: entry.incidentId, stage: value.stage, code: value.code,
    attempt: value.attempt as number,
    ...(verifyCode === undefined ? {} : { tls_verify_code: verifyCode as number }),
  });
  return "accepted";
}
export function ingestAdminDiagnostic(body: unknown): "accepted" | "invalid" | "rate_limited" {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "invalid";
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 1 || typeof value.code !== "string" || !ADMIN_CODES.has(value.code)) return "invalid";
  const now = Date.now();
  if (now - adminWindow >= 60_000) { adminWindow = now; adminCount = 0; }
  if (++adminCount > MAX_ADMIN_EVENTS_PER_MIN) return "rate_limited";
  record({
    component: "admin_ui", stage: value.code === "ADMIN_UI_RENDER_ERROR" ? "admin_ui" : "ws_upgrade",
    code: value.code, incident_id: crypto.randomUUID(), attempt: 0,
  });
  return "accepted";
}
export function listSafeDiagnostics(params: { limit?: number; code?: string; incident_id?: string } = {}):
  { entries: SafeDiagnostic[]; volatile: true } {
  prune(Date.now());
  const limit = Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(100, params.limit!)) : 50;
  const entries = events.filter(e =>
    (!params.code || e.code === params.code) &&
    (!params.incident_id || e.incident_id === params.incident_id)
  ).slice(-limit).reverse().map(e => ({ ...e }));
  return { entries, volatile: true };
}
export function isDiagnosticCode(value: unknown): value is string {
  return typeof value === "string" && (SDK_CODES.has(value) || ADMIN_CODES.has(value) || INTERNAL_CODES.has(value));
}
export function isIncidentId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
