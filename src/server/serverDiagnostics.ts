/**
 * SD-01: Fixed, read-only, bounded local probes. Not a Docker/host inspector.
 * Never forwards the caller's headers, cookies, URLs or session.
 */
import WebSocket from "ws";
import type { ServerDiagnosticsReport, ServerDiagnosticsCheck } from "../types.js";

const CHECK_TIMEOUT_MS = 2500;
const COOLDOWN_MS = 10000;
const ALLOWED_PATHS = new Set([
  "/api/health",
  "/api/ready",
  "/api/monitoring/devices?app_id=preflight",
]);

export interface DiagnosticsProbes {
  httpStatus(path: string, timeoutMs: number): Promise<number>;
  wsUnauthStatus(timeoutMs: number): Promise<number>;
  wsEnabled(): boolean;
  now(): number;
}

function port(): number {
  const n = Number(process.env.PORT ?? "3000");
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 3000;
}

export const defaultDiagnosticsProbes: DiagnosticsProbes = {
  async httpStatus(path, timeoutMs) {
    if (!ALLOWED_PATHS.has(path)) throw new Error("Unapproved diagnostic path");
    const response = await fetch("http://127.0.0.1:" + port() + path, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status;
  },
  wsUnauthStatus(timeoutMs) {
    return new Promise<number>(resolve => {
      const address = "127.0.0.1:" + port();
      const client = new WebSocket("ws://" + address + "/api/admin/realtime", {
        origin: "https://" + address,
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
      });
      let settled = false;
      const timer = setTimeout(() => finish(0), timeoutMs);
      const finish = (status: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.terminate();
        resolve(status);
      };
      client.on("unexpected-response", (_request, response) => {
        response.resume();
        finish(response.statusCode ?? 0);
      });
      client.on("open", () => finish(101));
      client.on("error", () => finish(0));
      client.on("close", () => finish(0));
    });
  },
  wsEnabled: () => process.env.LICENX_ADMIN_REALTIME_ENABLED === "true",
  now: () => Date.now(),
};

type RunnerOutcome =
  | { status: 200; report: ServerDiagnosticsReport }
  | { status: 409 | 429; error: "DIAGNOSTICS_BUSY" | "DIAGNOSTICS_COOLDOWN" };

export function createServerDiagnosticsRunner(probes: DiagnosticsProbes = defaultDiagnosticsProbes) {
  let running = false;
  let previousStart = Number.NEGATIVE_INFINITY;

  return async (): Promise<RunnerOutcome> => {
    if (running) return { status: 409, error: "DIAGNOSTICS_BUSY" };
    const startedAt = probes.now();
    if (startedAt - previousStart < COOLDOWN_MS) {
      return { status: 429, error: "DIAGNOSTICS_COOLDOWN" };
    }
    running = true;
    previousStart = startedAt;
    const checks: ServerDiagnosticsCheck[] = [];

    async function check(
      id: string, label: string, expected: number,
      run: () => Promise<number>, success: string,
    ) {
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let status = 0;
      try {
        status = await Promise.race([
          run(),
          new Promise<number>(resolve => { timer = setTimeout(() => resolve(0), CHECK_TIMEOUT_MS + 100); }),
        ]);
      } catch {
        status = 0;
      } finally {
        if (timer) clearTimeout(timer);
      }
      checks.push({
        id, label,
        state: status === expected ? "PASS" : "FAIL",
        detail: status === expected ? success :
          status === 0 ? "Probe unavailable or timed out" : "Unexpected HTTP status " + status,
        durationMs: Math.max(0, Date.now() - started),
      });
    }

    try {
      await check("api_health", "Internal HTTP liveness", 200,
        () => probes.httpStatus("/api/health", CHECK_TIMEOUT_MS), "HTTP 200");
      await check("api_ready", "API / PostgreSQL / storage readiness", 200,
        () => probes.httpStatus("/api/ready", CHECK_TIMEOUT_MS),
        "HTTP 200 (readiness includes database and storage)");
      await check("monitor_auth", "Unauthenticated Live Monitor protection", 401,
        () => probes.httpStatus("/api/monitoring/devices?app_id=preflight", CHECK_TIMEOUT_MS),
        "HTTP 401 (anonymous access denied)");
      if (probes.wsEnabled()) {
        await check("admin_ws_auth", "Unauthenticated Admin WebSocket protection", 401,
          () => probes.wsUnauthStatus(CHECK_TIMEOUT_MS), "HTTP 401 (anonymous upgrade denied)");
      } else {
        checks.push({
          id: "admin_ws_auth", label: "Unauthenticated Admin WebSocket protection",
          state: "SKIPPED", detail: "Admin WebSocket disabled by configuration", durationMs: 0,
        });
      }
      const summary = {
        pass: checks.filter(c => c.state === "PASS").length,
        fail: checks.filter(c => c.state === "FAIL").length,
        warn: checks.filter(c => c.state === "WARN").length,
        skipped: checks.filter(c => c.state === "SKIPPED").length,
      };
      return {
        status: 200,
        report: { startedAt, finishedAt: probes.now(), checks, summary },
      };
    } finally {
      running = false;
    }
  };
}

/** Single in-process throttle, scoped only to this diagnostic endpoint. */
export const runServerDiagnostics = createServerDiagnosticsRunner();
