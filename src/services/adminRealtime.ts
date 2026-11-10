/**
 * Browser-only Admin WSS notification transport. It never carries license/customer records.
 * The sole source of authoritative data remains authenticated, same-origin HTTP.
 */
import type { AdminRealtimeChange, AdminRealtimeState, RealtimePresenceReport } from "../types";

type Change = AdminRealtimeChange;
export type AdminRealtimeNotice =
  | { type: "state"; state: AdminRealtimeState }
  | { type: "snapshot"; report: RealtimePresenceReport }
  | { type: "change"; change: Change }
  | { type: "resync" };

export interface AdminBrowserSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface AdminRealtimeDependencies {
  bootstrap(signal: AbortSignal): Promise<unknown>;
  snapshot(signal: AbortSignal): Promise<RealtimePresenceReport>;
  invalidate(change: Change | null): void;
  reportDiagnostic?(): Promise<void>;
  socket(url: string): AdminBrowserSocket;
  origin(): string;
  isVisible?(): boolean;
  onVisibility?(callback: () => void): () => void;
  random?(): number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  fallbackMs?: number;
}

const APP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STREAM_ID = /^[0-9a-f-]{1,64}$/i;
const MAX_RETRIES = 6;
const MAX_EVENT_SIZE = 4096;
const VALID_RESOURCES = new Set(["apps", "licenses", "devices", "logs", "stats"]);
const WS_PATH = "/api/admin/realtime";

function validScope(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && APP_ID.test(value));
}
function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeChange(value: unknown): Change | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (!validScope(m.app_id) || !validSequence(m.sequence) ||
      typeof m.stream_id !== "string" || !STREAM_ID.test(m.stream_id) ||
      !Number.isFinite(m.observedAt) || typeof m.observedAt !== "number") return null;
  if (m.type === "presence.changed" && Object.keys(m).every(k =>
    ["type", "app_id", "sequence", "stream_id", "observedAt"].includes(k))) {
    return m as unknown as Change;
  }
  if (m.type === "resource.changed" && VALID_RESOURCES.has(m.resource as string) &&
      (m.source_version === undefined || validSequence(m.source_version)) &&
      Object.keys(m).every(k =>
        ["type", "app_id", "resource", "source_version", "sequence", "stream_id", "observedAt"].includes(k))) {
    return m as unknown as Change;
  }
  if (m.type === "stream.resync" && ["cursor", "backlog", "log_overflow"].includes(m.reason as string) &&
      Object.keys(m).every(k =>
        ["type", "app_id", "reason", "sequence", "stream_id", "observedAt"].includes(k))) {
    return m as unknown as Change;
  }
  return null;
}
function authStatus(error: unknown): number {
  const status = error && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : 0;
}
export function adminRealtimeSocketUrl(origin: string): string {
  const url = new URL(WS_PATH, origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Admin realtime requires an HTTP(S) origin");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class AdminRealtimeClient {
  private running = false;
  private generation = 0;
  private ws: AdminBrowserSocket | null = null;
  private controller: AbortController | null = null;
  private snapshotController: AbortController | null = null;
  private snapshotBusy = false;
  private snapshotAgain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private offVisibility: (() => void) | null = null;
  private attempts = 0;
  private connecting = false;
  private state: AdminRealtimeState = "HTTP_FALLBACK";
  private currentStream: string | null = null;
  private lastSequence = 0;
  private lastSuccessAt: number | null = null;
  private report: RealtimePresenceReport | null = null;
  private listeners = new Set<(notice: AdminRealtimeNotice) => void>();

  constructor(private readonly options: AdminRealtimeDependencies) {}

  getStatus(): { state: AdminRealtimeState; lastSuccessAt: number | null; report: RealtimePresenceReport | null } {
    return { state: this.state, lastSuccessAt: this.lastSuccessAt, report: this.report };
  }

  subscribe(listener: (notice: AdminRealtimeNotice) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "state", state: this.state });
    if (this.report) listener({ type: "snapshot", report: this.report });
    return () => { this.listeners.delete(listener); };
  }

  private notify(notice: AdminRealtimeNotice): void {
    for (const listener of this.listeners) {
      try { listener(notice); } catch { /* A consumer must not interrupt the transport. */ }
    }
  }
  private setState(state: AdminRealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.notify({ type: "state", state });
  }
  private visible(): boolean { return this.options.isVisible?.() ?? true; }

  /** One shared browser session; repeated login/getMe calls never start duplicate sockets. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.attempts = 0;
    this.setState("RECONNECTING");
    this.offVisibility = this.options.onVisibility?.(() => {
      if (!this.running || !this.visible()) return;
      void this.refreshSnapshot();
      if (!this.ws && !this.connecting && !this.retryTimer) this.connect(generation);
    }) ?? null;
    this.fallbackTimer = setInterval(() => {
      if (this.running && this.visible() && this.state !== "CONNECTED") void this.refreshSnapshot();
    }, this.options.fallbackMs ?? 15_000);
    this.fallbackTimer.unref?.();
    // Obtain an authenticated HTTP baseline before opening any Admin WebSocket.
    void this.refreshSnapshot().finally(() => {
      if (this.running && generation === this.generation) this.connect(generation);
    });
  }

  /** Logout, auth failure or page cleanup: abort all background work and close the shared socket. */
  stop(state: AdminRealtimeState = "HTTP_FALLBACK"): void {
    ++this.generation;
    this.running = false;
    this.connecting = false;
    this.attempts = 0;
    this.controller?.abort();
    this.controller = null;
    this.snapshotController?.abort();
    this.snapshotController = null;
    this.snapshotAgain = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    this.offVisibility?.();
    this.offVisibility = null;
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null;
      old.close();
    }
    this.currentStream = null;
    this.lastSequence = 0;
    if (state === "AUTH_EXPIRED") this.options.invalidate(null);
    this.report = null;
    this.lastSuccessAt = null;
    this.setState(state);
  }

  async refreshSnapshot(): Promise<void> {
    if (!this.running || !this.visible()) return;
    if (this.snapshotBusy) { this.snapshotAgain = true; return; }
    this.snapshotBusy = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.snapshotController = controller;
    try {
      const report = await this.options.snapshot(controller.signal);
      if (this.running && generation === this.generation && !controller.signal.aborted) {
        this.report = report;
        this.lastSuccessAt = Date.now();
        this.notify({ type: "snapshot", report });
        if (this.ws && this.currentStream) this.setState("CONNECTED");
        else this.setState("HTTP_FALLBACK");
      }
    } catch (error) {
      if (this.running && generation === this.generation && !controller.signal.aborted) {
        if (authStatus(error) === 401 || authStatus(error) === 403) this.stop("AUTH_EXPIRED");
        else this.setState("STALE");
      }
    } finally {
      this.snapshotBusy = false;
      if (this.snapshotController === controller) this.snapshotController = null;
      if (this.snapshotAgain && this.running && generation === this.generation) {
        this.snapshotAgain = false;
        void this.refreshSnapshot();
      }
    }
  }

  private connect(generation: number): void {
    if (!this.running || generation !== this.generation || !this.visible() ||
        this.connecting || this.ws) return;
    this.connecting = true;
    const controller = new AbortController();
    this.controller = controller;
    void (async () => {
      try {
        await this.options.bootstrap(controller.signal);
        if (!this.running || generation !== this.generation || controller.signal.aborted) return;
        const socket = this.options.socket(adminRealtimeSocketUrl(this.options.origin()));
        this.ws = socket;
        socket.onopen = () => { /* Await admin.ready and a fresh HTTP snapshot before CONNECTED. */ };
        socket.onmessage = event => this.receive(event.data, socket, generation);
        socket.onerror = () => {
          // Browser hides the HTTP upgrade status; send only a fixed safe category.
          if (this.options.reportDiagnostic) {
            void this.options.reportDiagnostic().catch(() => {});
          }
        };
        socket.onclose = event => {
          if (this.ws !== socket || generation !== this.generation) return;
          this.ws = null;
          this.currentStream = null;
          this.lastSequence = 0;
          if (event.code === 4003 || event.code === 1008) {
            this.stop("AUTH_EXPIRED");
            return;
          }
          this.setState("HTTP_FALLBACK");
          this.scheduleRetry(generation);
        };
      } catch (error) {
        if (!this.running || generation !== this.generation || controller.signal.aborted) return;
        const status = authStatus(error);
        if (status === 401 || status === 403) {
          this.stop("AUTH_EXPIRED");
        } else if (status === 404) {
          // Gate OFF: keep existing authenticated HTTP, no pointless WSS retries.
          this.setState("HTTP_FALLBACK");
        } else {
          this.setState("HTTP_FALLBACK");
          this.scheduleRetry(generation);
        }
      } finally {
        if (this.controller === controller) this.controller = null;
        this.connecting = false;
      }
    })();
  }

  private scheduleRetry(generation: number): void {
    if (!this.running || this.retryTimer || this.attempts >= MAX_RETRIES || !this.visible()) return;
    const base = this.options.retryBaseMs ?? 600;
    const max = this.options.retryMaxMs ?? 30_000;
    const jitter = 0.75 + Math.max(0, Math.min(1, this.options.random?.() ?? Math.random())) * 0.5;
    const delay = Math.min(max, base * 2 ** this.attempts++) * jitter;
    this.setState("RECONNECTING");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running && generation === this.generation) this.connect(generation);
    }, delay);
    this.retryTimer.unref?.();
  }

  private forceResync(): void {
    this.setState("STALE");
    this.options.invalidate(null);
    this.notify({ type: "resync" });
    void this.refreshSnapshot();
  }

  private receive(raw: unknown, socket: AdminBrowserSocket, generation: number): void {
    if (!this.running || generation !== this.generation || this.ws !== socket ||
        typeof raw !== "string" || raw.length > MAX_EVENT_SIZE) {
      if (raw && typeof raw === "string" && raw.length > MAX_EVENT_SIZE) this.forceResync();
      return;
    }
    let message: unknown;
    try { message = JSON.parse(raw); } catch { this.forceResync(); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.forceResync(); return;
    }
    const m = message as Record<string, unknown>;
    if (m.type === "admin.ready") {
      if (!validSequence(m.sequence) || m.sequence !== 0 ||
          typeof m.stream_id !== "string" || !STREAM_ID.test(m.stream_id)) {
        this.forceResync(); return;
      }
      this.currentStream = m.stream_id;
      this.lastSequence = 0;
      this.attempts = 0;
      this.setState("RECONNECTING");
      this.forceResync();
      return;
    }
    if (m.type === "admin.scoped") {
      if (m.stream_id !== this.currentStream || !validSequence(m.sequence) ||
          !validScope(m.app_id)) this.forceResync();
      return;
    }
    const change = safeChange(m);
    if (!change || !this.currentStream || change.stream_id !== this.currentStream) {
      this.forceResync(); return;
    }
    if (change.sequence <= this.lastSequence) return; // Replay/duplicate: ignored.
    if (change.sequence !== this.lastSequence + 1) {
      this.lastSequence = change.sequence;
      this.forceResync();
      return;
    }
    this.lastSequence = change.sequence;
    if (change.type === "stream.resync") { this.forceResync(); return; }
    this.options.invalidate(change);
    this.notify({ type: "change", change });
    if (change.type === "presence.changed") void this.refreshSnapshot();
  }
}

export function createAdminRealtimeClient(options: AdminRealtimeDependencies): AdminRealtimeClient {
  return new AdminRealtimeClient(options);
}
