/**
 * Phase-04 disposable GitHub-only Admin WSS capacity + resource evidence.
 * No public host, production data, customer secrets, or product-source changes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { request } from "playwright";
import WebSocket from "ws";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.LICENX_ADMIN_E2E_CI !== "1" ||
    process.env.DOMAIN !== "localhost" ||
    process.env.COMPOSE_PROJECT_NAME !== "licenx_admin_ci_" + process.env.GITHUB_RUN_ID ||
    !process.env.CI_ADMIN_PASSWORD || !process.env.RUNNER_TEMP) {
  throw new Error("Refusing Phase-04 load probe outside disposable GitHub runner");
}

const origin = "https://localhost";
const held = [];
let ctx;
const report = {
  scope: "DISPOSABLE_GITHUB_CI_ONLY",
  production: "NOT_TOUCHED",
  publicDomainTLS: "NOT_TESTED",
  configuredMaxSockets: 32,
  seededDevices: 150,
  runtime: {
    runnerLabel: "ubuntu-24.04",
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    versions: { playwright: "NOT_MEASURED", ws: "NOT_MEASURED" }
  },
  checks: {},
  metrics: {
    dbQps: "NOT_MEASURED",
    transactionRatePerSecond: "NOT_MEASURED",
    dockerCpu: "NOT_MEASURED",
    appRssKiB: "NOT_MEASURED",
    appFileDescriptors: "NOT_MEASURED",
    resourceSamples: []
  },
  capacity: {},
  reconnect: {},
  result: "FAIL"
};
function check(name, passed) {
  assert.ok(passed, name);
  report.checks[name] = "PASS";
  console.log("PASS " + name);
}
function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}
function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8", timeout: 12000, stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function optionalMetric(getter) {
  try { return getter(); } catch { return "NOT_MEASURED"; }
}
function pgValue(sql) {
  // The credential expands INSIDE the isolated PostgreSQL container, never in
  // logs or a host process argument. Return only a numeric aggregate.
  const line = 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c ' +
    JSON.stringify(sql);
  const value = Number(docker("compose", "exec", "-T", "postgres", "sh", "-c", line));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("DB metric unavailable");
  return value;
}
function resourceSample(phase) {
  const containerId = docker("compose", "ps", "-q", "app");
  if (!containerId) throw new Error("CI app container missing");
  const raw = optionalMetric(() => JSON.parse(
    docker("stats", "--no-stream", "--format", "{{json .}}", containerId)
  ));
  const cpuPercent = raw !== "NOT_MEASURED" ? Number.parseFloat(raw.CPUPerc) : NaN;
  const proc = optionalMetric(() =>
    docker("compose", "exec", "-T", "app", "sh", "-c",
      "grep '^VmRSS:' /proc/1/status; ls -1 /proc/1/fd | wc -l"));
  const vm = proc !== "NOT_MEASURED" ? /^VmRSS:\s*(\d+)\s*kB/m.exec(proc) : null;
  const fd = proc !== "NOT_MEASURED" ? /\n\s*(\d+)\s*$/.exec(proc) : null;
  const snapshot = {
    phase,
    nodePid: 1,
    cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : "NOT_MEASURED",
    dockerMemoryUsage: raw !== "NOT_MEASURED" ? String(raw.MemUsage ?? "NOT_MEASURED") : "NOT_MEASURED",
    appRssKiB: vm ? Number(vm[1]) : "NOT_MEASURED",
    appFileDescriptors: fd ? Number(fd[1]) : "NOT_MEASURED",
    cpuMeaning: "Docker daemon instantaneous % sample, not average CPU",
    rssMeaning: "Node PID 1 VmRSS from disposable container /proc/1/status"
  };
  report.metrics.resourceSamples.push(snapshot);
  return snapshot;
}
function sessionCookie(cookies) {
  const session = cookies.find(c => c.name === "vcon_admin_session");
  const proof = cookies.find(c => c.name === "vcon_admin_realtime_proof");
  if (!session || !proof) throw new Error("No CI Admin session/proof cookies");
  return "vcon_admin_session=" + session.value + "; vcon_admin_realtime_proof=" + proof.value;
}
async function issueProof() {
  const res = await ctx.post(origin + "/api/admin/realtime/bootstrap", {
    headers: { origin, "x-csrf-token": csrf }, data: {}
  });
  if (res.status() !== 200) throw new Error("Disposable Admin bootstrap status " + res.status());
  return sessionCookie((await ctx.storageState()).cookies);
}
let csrf;
let trustedCA;
async function openConnected() {
  const proofHeader = await issueProof();
  const ws = new WebSocket("wss://localhost/api/admin/realtime", {
    headers: { Origin: origin, Cookie: proofHeader },
    ca: trustedCA, handshakeTimeout: 8500
  });
  ws.on("error", () => {}); // Avoid unhandled events during forced CI cleanup.
  const started = performance.now();
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      const timeout = setTimeout(() => settle(new Error("Admin WSS readiness timeout")), 10000);
      function settle(error) {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve();
      }
      ws.on("message", data => {
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === "admin.ready" && msg.sequence === 0) settle(null);
        } catch { settle(new Error("Invalid sanitized WSS readiness frame")); }
      });
      ws.once("close", () => settle(new Error("Admin socket closed before ready")));
      ws.once("error", () => settle(new Error("Admin WSS handshake error")));
    });
  } catch (error) {
    ws.terminate();
    throw error;
  }
  held.push(ws);
  return Math.round(performance.now() - started);
}
async function rejected33rd() {
  const proof = await issueProof();
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://localhost/api/admin/realtime", {
      headers: { Origin: origin, Cookie: proof },
      ca: trustedCA, handshakeTimeout: 8500
    });
    let done = false;
    const timeout = setTimeout(() => settle(new Error("33rd WSS upgrade timeout")), 10000);
    function settle(error, status) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(status);
    }
    ws.once("unexpected-response", (req, res) => {
      const status = res.statusCode;
      settle(null, status);
      res.destroy();
      req.destroy();
    });
    ws.once("open", () => {
      ws.terminate();
      settle(null, 101);
    });
    ws.on("error", () => {});
    ws.once("error", () => settle(new Error("33rd WSS client error")));
  });
}
async function dropLast() {
  const ws = held.pop();
  if (!ws) throw new Error("No existing socket for reconnect probe");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket did not close")), 5000);
    ws.once("close", () => { clearTimeout(timer); resolve(); });
    ws.terminate();
  });
  // Let the server process its own close event before the replacement upgrade.
  await new Promise(resolve => setTimeout(resolve, 250));
}
try {
  await mkdir("ci-admin-evidence", { recursive: true });
  report.runtime.versions.playwright = JSON.parse(
    await readFile("node_modules/playwright/package.json", "utf8")).version;
  report.runtime.versions.ws = JSON.parse(
    await readFile("node_modules/ws/package.json", "utf8")).version;
  check("pinned disposable Playwright and ws runtime",
    report.runtime.versions.playwright === "1.56.1" &&
    report.runtime.versions.ws === "8.22.0" &&
    report.runtime.platform === "linux");
  trustedCA = await readFile(process.env.RUNNER_TEMP + "/licenx-ci-local-ca.pem");
  ctx = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const csrfResponse = await ctx.get("/api/auth/csrf");
  check("CI-only CSRF bootstrap ready", csrfResponse.status() === 200);
  csrf = (await csrfResponse.json()).csrfToken;
  const login = await ctx.post("/api/auth/login", {
    headers: { origin, "x-csrf-token": csrf },
    data: { username: "ci_owner", password: process.env.CI_ADMIN_PASSWORD }
  });
  check("load probe authenticated to disposable Admin", login.status() === 200);
  const t0 = performance.now();
  const startTxn = optionalMetric(() => pgValue(
    "SELECT (xact_commit+xact_rollback)::bigint FROM pg_stat_database WHERE datname=current_database()"
  ));
  const startCalls = optionalMetric(() => pgValue(
    "SELECT COALESCE(SUM(calls),0)::bigint FROM pg_stat_statements"
  ));
  const connectionMs = [];
  for (let index = 0; index < 32; index++) connectionMs.push(await openConnected());
  check("32 simultaneous Admin WSS sockets receive ready", held.length === 32 &&
    held.every(ws => ws.readyState === WebSocket.OPEN));
  const rejectStatus = await rejected33rd();
  check("33rd Admin WSS connection rejected with HTTP 429", rejectStatus === 429);
  report.capacity = {
    simultaneousReadySockets: 32, extraAttemptHttpStatus: rejectStatus,
    initialConnectionLatencyMs: {
      sampleCount: connectionMs.length, p50Ms: pct(connectionMs, 0.50),
      p95Ms: pct(connectionMs, 0.95)
    }
  };
  resourceSample("32_sockets_open");
  const reconnectSamplesMs = [];
  for (let n = 0; n < 5; n++) {
    const start = performance.now();
    await dropLast();
    await openConnected();
    reconnectSamplesMs.push(Math.round(performance.now() - start));
  }
  check("bounded reconnect restores exactly 32 live WSS sockets",
    held.length === 32 && held.every(ws => ws.readyState === WebSocket.OPEN));
  report.reconnect = {
    sampleCount: reconnectSamplesMs.length, samplesMs: reconnectSamplesMs,
    p50Ms: pct(reconnectSamplesMs, 0.50), p95Ms: pct(reconnectSamplesMs, 0.95),
    measurement: "synthetic socket close -> new one-use bootstrap -> new ready"
  };
  await new Promise(resolve => setTimeout(resolve, 2000));
  resourceSample("32_sockets_after_reconnect");
  const elapsedSeconds = (performance.now() - t0) / 1000;
  const endTxn = optionalMetric(() => pgValue(
    "SELECT (xact_commit+xact_rollback)::bigint FROM pg_stat_database WHERE datname=current_database()"
  ));
  const endCalls = optionalMetric(() => pgValue(
    "SELECT COALESCE(SUM(calls),0)::bigint FROM pg_stat_statements"
  ));
  if (typeof startTxn === "number" && typeof endTxn === "number" && endTxn >= startTxn) {
    report.metrics.transactionRatePerSecond =
      Number(((endTxn - startTxn) / elapsedSeconds).toFixed(3));
  }
  if (typeof startCalls === "number" && typeof endCalls === "number" && endCalls >= startCalls) {
    report.metrics.dbQps = Number(((endCalls - startCalls) / elapsedSeconds).toFixed(3));
  }
  report.metrics.dbQpsMeaning = "pg_stat_statements SUM(calls) delta / CI observation seconds; NOT_MEASURED if extension unavailable";
  report.metrics.transactionRateMeaning = "pg_stat_database completed transaction delta / CI observation seconds; not SQL query QPS";
  report.metrics.intervalSeconds = Number(elapsedSeconds.toFixed(3));
  const snapshots = report.metrics.resourceSamples;
  report.metrics.dockerCpu = snapshots.some(x => typeof x.cpuPercent === "number")
    ? snapshots.map(x => x.cpuPercent) : "NOT_MEASURED";
  report.metrics.appRssKiB = snapshots.some(x => typeof x.appRssKiB === "number")
    ? snapshots.map(x => x.appRssKiB) : "NOT_MEASURED";
  report.metrics.appFileDescriptors = snapshots.some(x => typeof x.appFileDescriptors === "number")
    ? snapshots.map(x => x.appFileDescriptors) : "NOT_MEASURED";
  check("capacity and reconnect metrics contain observed bounded samples",
    report.capacity.initialConnectionLatencyMs.sampleCount === 32 &&
    report.reconnect.sampleCount === 5);
  report.result = "PASS";
  console.log("CI_ONLY_ADMIN_CAPACITY " + JSON.stringify({
    sockets: 32, rejected33rd: rejectStatus,
    reconnectP95Ms: report.reconnect.p95Ms,
    dbQps: report.metrics.dbQps
  }));
} catch (error) {
  process.exitCode = 1;
  report.result = "FAIL";
  report.error = String(error?.message ?? error).slice(0, 180);
  console.error("CI_ADMIN_CAPACITY_FAILED (details in sanitized evidence)");
} finally {
  held.forEach(ws => { try { ws.terminate(); } catch {} });
  await ctx?.dispose().catch(() => {});
  await writeFile("ci-admin-evidence/admin-load.json",
    JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }).catch(() => {});
}
