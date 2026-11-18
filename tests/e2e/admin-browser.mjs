/**
 * Real Chromium browser acceptance against CI-only HTTPS Caddy.
 * Never points at a supplied host, production domain, or customer data.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, request } from "playwright";
import WebSocket from "ws";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.LICENX_ADMIN_E2E_CI !== "1" ||
    !/^licenx_admin_ci_[0-9]+$/.test(process.env.COMPOSE_PROJECT_NAME ?? "") ||
    !process.env.OWNER_CODE ||
    !process.env.CI_ADMIN_PASSWORD) {
  throw new Error("Admin browser test is restricted to disposable GitHub CI");
}

const origin = "https://localhost";
const evidence = { scope: "DISPOSABLE_CI_ONLY", browser: "chromium",
  publicDomainTLS: "NOT_TESTED", production: "NOT_TOUCHED", checks: {},
  devices: 150, adminSocketMaxConfigured: 32, adminCapacity: "NOT_MEASURED" };
let browser;
let setupClient;

function check(name, condition) {
  assert.ok(condition, name);
  evidence.checks[name] = "PASS";
  console.log("PASS " + name);
}
async function poll(checkFn, label, durationMs = 18000) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    if (await checkFn()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Timeout waiting for " + label);
}
function captureSocket(page) {
  const sockets = [];
  const frames = [];
  page.on("websocket", ws => {
    if (!ws.url().startsWith("wss://localhost/api/admin/realtime")) return;
    sockets.push(ws);
    ws.on("framereceived", frame => {
      try { frames.push(JSON.parse(String(frame.payload))); } catch { /* invalid frame is not a pass */ }
    });
  });
  return { sockets, frames };
}

/** CI-only WSS upgrade probe: use disposable Caddy's trusted CA. */
async function rawUpgrade(options = {}) {
  const ca = await readFile(process.env.RUNNER_TEMP + "/licenx-ci-local-ca.pem");
  const headers = { Origin: options.originHeader ?? origin };
  if (options.cookie) headers.Cookie = options.cookie;
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://localhost" + (options.path ?? "/api/admin/realtime"), {
      headers, ca, handshakeTimeout: 7000
    });
    let finished = false;
    const timer = setTimeout(() => finish(new Error("WSS upgrade probe timed out")), 10000);
    function finish(error, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(code);
    }
    ws.once("unexpected-response", (req, res) => {
      // An explicit listener takes over this HTTP response from ws. Close it;
      // otherwise the CI Node process may linger on an idle upgrade socket.
      const status = res.statusCode;
      finish(null, status);
      res.destroy();
      req.destroy();
    });
    ws.once("open", () => {
      finish(null, 101);
      ws.terminate(); // CI-only probe, never a persistent Admin session.
    });
    ws.once("error", error => finish(error));
  });
}
function sessionCookie(cookies) {
  return cookies.find(c => c.name === "vcon_admin_session");
}
function proofCookieHeader(cookies) {
  const auth = sessionCookie(cookies);
  const proof = cookies.find(c => c.name === "vcon_admin_realtime_proof");
  if (!auth || !proof) throw new Error("Missing CI session/proof cookie");
  return "vcon_admin_session=" + auth.value + "; vcon_admin_realtime_proof=" + proof.value;
}
async function sameSecondLoginProbe(password) {
  const contexts = await Promise.all([0, 1].map(() =>
    request.newContext({ baseURL: origin, ignoreHTTPSErrors: true })));
  try {
    const csrf = await Promise.all(contexts.map(async ctx =>
      (await (await ctx.get("/api/auth/csrf")).json()).csrfToken));
    let unique = false;
    let matchedSecond = false;
    // Independent requests must agree on second-resolution expiry to prove
    // that uniqueness does not accidentally come from different timestamps.
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 1020 - (Date.now() % 1000)));
      const replies = await Promise.all(contexts.map((ctx, i) =>
        ctx.post("/api/auth/login", {
          headers: { origin, "x-csrf-token": csrf[i] },
          data: { username: "ci_owner", password }
        })));
      if (!replies.every(r => r.status() === 200)) throw new Error("Concurrent login non-200");
      const cookies = await Promise.all(contexts.map(async ctx => sessionCookie((await ctx.storageState()).cookies)));
      if (!cookies.every(Boolean)) throw new Error("Concurrent login cookie absent");
      const claims = cookies.map(c => JSON.parse(Buffer.from(c.value.split(".")[1], "base64url").toString("utf8")));
      if (claims[0].exp === claims[1].exp) {
        matchedSecond = true;
        unique = cookies[0].value !== cookies[1].value &&
          /^[0-9a-f-]{36}$/i.test(claims[0].jti ?? "") &&
          /^[0-9a-f-]{36}$/i.test(claims[1].jti ?? "") &&
          claims[0].jti !== claims[1].jti;
        break;
      }
    }
    check("same-second Admin logins issue distinct signed sessions", matchedSecond && unique);
  } finally {
    await Promise.all(contexts.map(c => c.dispose()));
  }
}

async function login(page, password) {
  await page.goto(origin + "/vcon", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="password"]').waitFor({ timeout: 20000 });
  await page.locator('input[type="text"]').first().fill("ci_owner");
  await page.locator('input[type="password"]').first().fill(password);
  const loginResult = page.waitForResponse(res =>
    res.url().endsWith("/api/auth/login") && res.request().method() === "POST", { timeout: 25000 });
  await page.getByRole("button", { name: "Authenticate & Open Dashboard" }).click();
  check("browser login HTTP 200", (await loginResult).status() === 200);
  await page.locator('input[type="password"]').first().waitFor({ state: "hidden", timeout: 20000 });
}
async function navigate(page, text) {
  await page.locator("aside button").filter({ hasText: text }).last().click();
}
try {
  await mkdir("ci-admin-evidence", { recursive: true });
  setupClient = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const unauth = await setupClient.get("/api/devices");
  check("unauthenticated devices denied", unauth.status() === 401);
  const unauthStats = await setupClient.get("/api/licenses/ci_e2e_license_a/device-stats");
  check("SDK-STAT-01 Admin statistics require authenticated session", unauthStats.status() === 401);
  const noStatsToken = await setupClient.post("/api/v1/device/stats", {
    data: { stats: { Total: 1 } },
  });
  check("SDK-STAT-01 anonymous client cannot write statistics", [401, 403].includes(noStatsToken.status()));
  const unauthWs = await setupClient.post("/api/admin/realtime/bootstrap", {
    headers: { origin, "content-type": "application/json" }, data: {} });
  check("unauthenticated WSS bootstrap denied", unauthWs.status() === 401);

  const initial = await setupClient.get("/api/auth/csrf");
  check("CSRF bootstrap", initial.status() === 200);
  const { csrfToken } = await initial.json();
  const initialize = await setupClient.post("/api/setup/init", {
    headers: { origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { username: "ci_owner", password: process.env.CI_ADMIN_PASSWORD,
      ownerSetupCode: process.env.OWNER_CODE }
  });
  check("fresh isolated Admin initialization", initialize.status() === 200);

  await sameSecondLoginProbe(process.env.CI_ADMIN_PASSWORD);

  browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  evidence.browserPageErrors = [];
  pageA.on("pageerror", error => {
    evidence.browserPageErrors.push(String(error.message).slice(0, 300));
  });
  const a = captureSocket(pageA);
  const b = captureSocket(pageB);
  await login(pageA, process.env.CI_ADMIN_PASSWORD);
  await poll(() => a.frames.some(f => f.type === "admin.ready"),
    "first browser Admin WSS ready");
  // Phase-03: rapid logins must also receive independent JWTs.
  await login(pageB, process.env.CI_ADMIN_PASSWORD);
  const firstSession = (await ctxA.cookies()).find(c => c.name === "vcon_admin_session");
  const secondSession = (await ctxB.cookies()).find(c => c.name === "vcon_admin_session");
  check("independent Admin login tokens",
    !!firstSession && !!secondSession && firstSession.value !== secondSession.value);
  await poll(() => b.frames.some(f => f.type === "admin.ready"),
    "second browser Admin WSS ready");
  check("two real browser WSS sessions", a.sockets.length === 1 && b.sockets.length === 1);
  check("trusted localhost Caddy WSS upgrade",
    a.sockets[0].url() === "wss://localhost/api/admin/realtime" &&
    b.sockets[0].url() === "wss://localhost/api/admin/realtime");

  const cookies = await ctxA.cookies();
  const session = cookies.find(c => c.name === "vcon_admin_session");
  check("secure HttpOnly strict admin session cookie",
    !!session && session.secure && session.httpOnly &&
    session.sameSite === "Strict" && session.path === "/api");

  const csrfA = await (await ctxA.request.get(origin + "/api/auth/csrf")).json();
  const missingCsrf = await ctxA.request.post(origin + "/api/admin/realtime/bootstrap", {
    headers: { origin }, data: {} });
  check("live browser session blocks missing CSRF", missingCsrf.status() === 403);
  const badOrigin = await ctxA.request.post(origin + "/api/admin/realtime/bootstrap", {
    headers: { origin: "https://untrusted.example.invalid", "x-csrf-token": csrfA.csrfToken }, data: {} });
  check("live browser session blocks wrong Origin", badOrigin.status() === 403);


  // Phase-03: reject invalid/unauthorized WSS upgrades over trusted local CA.
  const sessionHeader = "vcon_admin_session=" + session.value;
  check("WSS upgrade without one-time proof denied",
    await rawUpgrade({ cookie: sessionHeader }) === 401);
  check("WSS upgrade denies wrong Origin",
    await rawUpgrade({ cookie: sessionHeader, originHeader: "https://untrusted.example.invalid" }) === 403);
  check("WSS upgrade denies query parameters",
    await rawUpgrade({ cookie: sessionHeader, path: "/api/admin/realtime?unexpected=1" }) === 400);
  check("WSS invalid bootstrap proof denied",
    await rawUpgrade({ cookie: sessionHeader + "; vcon_admin_realtime_proof=" + "A".repeat(43) }) === 401);
  const freshBootstrap = await ctxA.request.post(origin + "/api/admin/realtime/bootstrap", {
    headers: { origin, "x-csrf-token": csrfA.csrfToken }, data: {}
  });
  check("one-use WSS bootstrap HTTP 200", freshBootstrap.status() === 200);
  const oneUseHeader = proofCookieHeader(await ctxA.cookies());
  check("first one-use proof grants WSS upgrade",
    await rawUpgrade({ cookie: oneUseHeader }) === 101);
  check("replayed WSS bootstrap proof rejected",
    await rawUpgrade({ cookie: oneUseHeader }) === 401);
  const expiringBootstrap = await ctxA.request.post(origin + "/api/admin/realtime/bootstrap", {
    headers: { origin, "x-csrf-token": csrfA.csrfToken }, data: {}
  });
  check("expiring bootstrap proof issued", expiringBootstrap.status() === 200);
  const expiringHeader = proofCookieHeader(await ctxA.cookies());
  await new Promise(r => setTimeout(r, 31000));
  check("expired WSS bootstrap proof denied",
    await rawUpgrade({ cookie: expiringHeader }) === 401);

  // LM-RG01: Live Monitor acceptance on the SAME isolated PostgreSQL/Chromium
  // fixture; these are authenticated read-only requests, not license mutations.
  // /api/setup/init issues an Admin session cookie to setupClient; use a
  // brand-new context so this negative probe is genuinely unauthenticated.
  const anonymousMonitorContext = await request.newContext({
    baseURL: origin, ignoreHTTPSErrors: true
  });
  try {
    const anonMonitor = await anonymousMonitorContext.get(
      "/api/monitoring/devices?app_id=ci_e2e_app_a");
    check("LM-RG01 unauthenticated device monitoring denied", anonMonitor.status() === 401);
  } finally {
    await anonymousMonitorContext.dispose();
  }
  await navigate(pageA, "Live Monitor");
  await poll(() => new URL(pageA.url()).pathname === "/vcon/live-monitor" &&
    pageA.getByText("Live Client Monitor").isVisible(), "Live Monitor route and header");
  const appSection = pageA.locator('main section[aria-label="Application connections"]');
  await poll(async () => (await appSection.locator("tbody tr").count()) === 10 &&
    (await appSection.innerText()).includes("CI E2E Alpha") &&
    (await appSection.innerText()).includes("CI E2E Beta"),
  "Live Monitor scoped 10-application first page", 25000);
  check("LM-RG01 global cards preserve separate WS/bound/stale semantics",
    await pageA.getByText("WS Connected", { exact: true }).count() === 1 &&
    await pageA.getByText("WS Sockets", { exact: true }).count() === 1 &&
    await pageA.getByText("Bound Active", { exact: true }).count() === 1 &&
    await pageA.getByText("Stale Leases", { exact: true }).count() === 1);
  check("LM-RG01 app table uses server-authoritative total 152",
    (await appSection.innerText()).includes("Applications: 152"));
  const alpha = appSection.locator("tbody tr").filter({ hasText: "CI E2E Alpha" });
  const beta = appSection.locator("tbody tr").filter({ hasText: "CI E2E Beta" });
  check("LM-RG01 per-app bound totals are not combined with global count",
    (await alpha.innerText()).includes("149") && (await beta.innerText()).includes("1"));

  // Real PostgreSQL GET route, real selected-app Chromium UI, no secrets.
  const alphaApi = await ctxA.request.get(origin +
    "/api/monitoring/devices?app_id=ci_e2e_app_a&limit=25&offset=0");
  check("LM-RG01 real PostgreSQL app-scoped endpoint",
    alphaApi.status() === 200 && (await alphaApi.json()).total === 149);
  await alpha.getByRole("button", { name: "Inspect CI E2E Alpha devices" }).click();
  const inspector = pageA.locator('main [aria-label="Selected application devices"]');
  await poll(async () => (await inspector.locator("tbody tr").count()) === 25 &&
    (await inspector.innerText()).includes("Matching active devices: 149"),
  "LM-RG01 real PostgreSQL inspector first 25 devices", 16000);
  check("LM-RG01 inspector does not expose keys/HWIDs or cross-app devices",
    !(await inspector.innerText()).includes("ci-e2e-hwid") &&
    !(await inspector.innerText()).includes("CI-E2E-LICENSE") &&
    !(await inspector.innerText()).includes("ci_e2e_device_149"));
  for (let page = 2; page <= 6; page++) {
    await inspector.getByRole("button", { name: "Next" }).click();
    await poll(async () => (await inspector.innerText()).includes("Page " + page + " / 6") &&
      await inspector.locator("tbody tr").count() === (page === 6 ? 24 : 25),
    "LM-RG01 inspected page " + page + " device row count");
  }
  check("LM-RG01 149 devices paginated 25/25/25/25/25/24", true);
  await inspector.getByRole("button", { name: "Close device inspector" }).click();
  await beta.getByRole("button", { name: "Inspect CI E2E Beta devices" }).click();
  await poll(async () => (await inspector.locator("tbody tr").count()) === 1 &&
    (await inspector.innerText()).includes("ci_e2e_device_149"),
  "LM-RG01 Beta app isolated device inspector");
  check("LM-RG01 Beta inspector does not reveal Alpha devices",
    !(await inspector.innerText()).includes("ci_e2e_device_148"));
  await inspector.getByRole("button", { name: "Close device inspector" }).click();

  await pageA.locator("#live-monitor-filter").selectOption("inactive");
  await poll(async () => (await appSection.innerText()).includes("Applications: 30") &&
    (await appSection.locator("tbody tr").count()) === 10,
  "LM-RG01 inactive app status filter", 18000);
  await appSection.getByRole("button", { name: "Next" }).click();
  await poll(async () => (await appSection.innerText()).includes("Page 2 / 3"),
  "LM-RG01 filtered applications paginate");
  await pageA.locator("#live-monitor-filter").selectOption("all");
  await poll(async () => (await appSection.innerText()).includes("Applications: 152") &&
    (await appSection.innerText()).includes("CI E2E Alpha"),
  "LM-RG01 all-app filter resets page");

  // Simulate a disabled SDK transport at the Browser HTTP snapshot boundary.
  // This is CI-only network mocking and cannot disable any real server/client.
  await pageA.route("**/api/realtime/presence?*", async route => {
    const appId = new URL(route.request().url()).searchParams.get("app_id");
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        scope: appId, transportEnabled: false, connectedNow: 0,
        activeSockets: 0, boundActive: appId ? 1 : 150, staleBound: 0,
        connectedDeviceIds: [], observedAt: Date.now()
      })
    });
  });
  await navigate(pageA, "Applications");
  await navigate(pageA, "Live Monitor");
  await poll(async () => (await pageA.locator("main").innerText()).includes("SDK WebSocket transport disabled") &&
    (await appSection.innerText()).includes("WS disabled"),
  "LM-RG01 browser reports disabled WS as Unknown", 24000);
  check("LM-RG01 disabled client WS never mislabels online device total",
    (await pageA.getByText("WS Connected", { exact: true }).locator("..").locator("..").innerText())
      .includes("Unknown"));
  await pageA.unroute("**/api/realtime/presence?*");
  await navigate(pageA, "Applications");
  await navigate(pageA, "Live Monitor");
  await poll(async () => (await appSection.innerText()).includes("CI E2E Alpha"),
    "LM-RG01 browser restores trusted live monitor snapshots");

  // A scoped response older than 60s is unavailable, never a confirmed No WS.
  await pageA.route("**/api/monitoring/devices?*", async route => {
    const requested = new URL(route.request().url()).searchParams;
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        appId: requested.get("app_id"), observedAt: Date.now() - 65_000,
        total: 1, limit: Number(requested.get("limit") ?? 25),
        offset: Number(requested.get("offset") ?? 0), devices: []
      })
    });
  });
  await appSection.getByRole("button", { name: "Inspect CI E2E Alpha devices" }).click();
  await poll(async () => (await inspector.innerText()).includes("Device snapshot unavailable or stale"),
    "LM-RG01 stale inspector fails safe");
  await inspector.getByRole("button", { name: "Close device inspector" }).click();
  await pageA.unroute("**/api/monitoring/devices?*");
  await pageA.screenshot({ path: "ci-admin-evidence/live-monitor-apps.png" });

  await navigate(pageA, "HWID Locks");
  await poll(async () => (await pageA.locator("main").innerText()).includes("Total Bound: 150"),
    "150 devices visible in browser");
  check("first page 20 devices", await pageA.locator("main tbody tr").count() === 20);
  const nextPage = pageA.waitForResponse(res =>
    res.url().includes("/api/devices?") && res.url().includes("offset=140"), { timeout: 12000 });
  await pageA.locator('main button[title="Last Page"]').click();
  const pageResponse = await nextPage;
  check("page eight uses HTTP offset 140", pageResponse.status() === 200);
  await poll(async () => await pageA.locator("main tbody tr").count() === 10,
    "last page 10 devices");
  check("server pagination reflects last devices",
    (await pageA.locator("main tbody").innerText()).includes("ci-e2e-hwid-00"));
  await pageA.screenshot({ path: "ci-admin-evidence/devices-page8.png" });

  // Phase-02: >100 Apps and Licenses, >150 historical logs; all CI-only.
  await navigate(pageA, "Applications");
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 152 applications") &&
    await pageA.locator("main tbody tr").count() === 20, "152 Apps server-paged");
  const appsLast = pageA.waitForResponse(res => res.url().includes("/api/apps?") &&
    new URL(res.url()).searchParams.get("offset") === "140", { timeout: 12000 });
  await pageA.locator('main button[title="Last Page"]').click();
  const appsLastResponse = await appsLast;
  check("Apps last page server offset 140 and total 152",
    appsLastResponse.status() === 200 &&
    (await appsLastResponse.json()).total === 152);
  await poll(async () => await pageA.locator("main tbody tr").count() === 12 &&
    (await pageA.locator("main tbody").innerText()).includes("CI Browser App 000"),
    "Apps page 8 of 152 records");
  check("Apps records beyond initial 100 accessible", true);
  await pageA.locator('main button[title="First Page"]').click();
  await poll(async () => (await pageA.locator("main tbody").innerText()).includes("CI E2E Alpha"),
    "Apps first page");
  await pageA.locator('main select').first().selectOption("inactive");
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 30 applications") &&
    await pageA.locator("main tbody tr").count() === 20, "Apps server status filter");
  check("Apps server filter covers all 30 inactive fixtures", true);
  await pageA.locator('main select').first().selectOption("all");
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 152 applications"),
    "Apps filter cleared");
  const appSearchForm = pageA.locator("main form").first();
  await appSearchForm.locator('input').fill("CI Browser App 123");
  await appSearchForm.getByRole("button", { name: "Search" }).click();
  await poll(async () => await pageA.locator("main tbody tr").count() === 1 &&
    (await pageA.locator("main tbody").innerText()).includes("CI Browser App 123"),
    "Apps server search beyond 100");
  check("Apps remote search sees filtered middle record", true);
  await appSearchForm.locator('input').fill("");
  await appSearchForm.getByRole("button", { name: "Search" }).click();
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 152 applications"),
    "Apps search cleared");

  await navigate(pageA, "License Keys");
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 152 licenses") &&
    await pageA.locator("main tbody tr").count() === 20, "152 Licenses server-paged");
  const licenseLast = pageA.waitForResponse(res => res.url().includes("/api/licenses?") &&
    new URL(res.url()).searchParams.get("offset") === "140", { timeout: 12000 });
  await pageA.locator('main button[title="Last Page"]').click();
  const licenseLastResponse = await licenseLast;
  const licensePageData = await licenseLastResponse.json();
  check("Licenses page 8 fetched beyond 100",
    licenseLastResponse.status() === 200 && licensePageData.total === 152 &&
    licensePageData.licenses.length === 12 &&
    licensePageData.licenses.some(x => x.id === "ci_e2e_license_000"));
  await poll(async () => await pageA.locator("main tbody tr").count() === 12, "Licenses last page");
  await poll(async () => await pageA.locator('main select option[value="ci_e2e_app_149"]').count() === 1,
    "License app filter has all 152 Apps");
  await pageA.locator('main select').first().selectOption("ci_e2e_app_149");
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 1 licenses") &&
    await pageA.locator("main tbody tr").count() === 1, "License App-scoped filter");
  check("License app filter works beyond first 50 Apps", true);
  await pageA.locator('main select').first().selectOption("all");
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 152 licenses"),
    "License App filter cleared");
  await pageA.locator('main select').nth(2).selectOption("Pro");
  await poll(async () => (await pageA.locator("main").innerText()).includes("of 38 licenses"),
    "License tier filter across >100");
  check("License server tier filter covers all fixtures", true);
  await pageA.locator('main select').nth(2).selectOption("all");

  // SDK-STAT-01: find a deterministic disposable license with bound devices.
  const statsSearch = pageA.locator("main form").first();
  await statsSearch.locator("input").fill("CI-E2E-LICENSE-A");
  await statsSearch.getByRole("button", { name: "Search" }).click();
  await poll(async () => await pageA.locator('main tbody span[title="Click to copy: CI-E2E-LICENSE-A"]').count() === 1,
    "SDK-STAT-01 CI license search");

  // SDK-STAT-01: synthetic browser presentation without touching user data.
  await pageA.route("**/api/licenses/ci_e2e_license_a/device-stats", async route => {
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ devices: Array.from({ length: 150 }, (_, i) => ({
        device_id: "ci_e2e_device_" + String(i).padStart(3, "0"),
        stats: { Total: 5000, Send: 200, Failed: 4800 },
        reported_at: Date.now(), active: true,
      })) }),
    });
  });
  const groupRow = pageA.locator("main tbody tr").filter({
    has: pageA.locator('span[title="Click to copy: CI-E2E-LICENSE-A"]'),
  }).first();
  await groupRow.locator('button[title="Click to view & unbind locked hardware"]').click();
  const hwidInspector = pageA.locator("div.fixed").filter({ hasText: "HWID Lock Inspector:" }).last();
  await poll(async () => await hwidInspector.locator("summary").count() > 0,
    "SDK-STAT-01 HWID Inspector dynamic section");
  await hwidInspector.locator("summary").first().click();
  check("SDK-STAT-01 custom JSON labels and values render",
    (await hwidInspector.innerText()).includes("Total") &&
    (await hwidInspector.innerText()).includes("5,000") === false &&
    (await hwidInspector.innerText()).includes("5000") &&
    (await hwidInspector.innerText()).includes("Failed") &&
    (await hwidInspector.innerText()).includes("4800"));
  check("SDK-STAT-01 preserves Unbind and Reset actions",
    await hwidInspector.getByText("Unbind HWID").count() > 0 &&
    await hwidInspector.getByText("Reset All Devices").count() > 0);
  await hwidInspector.getByRole("button", { name: "Close" }).click();
  await pageA.unroute("**/api/licenses/ci_e2e_license_a/device-stats");

  // Isolate HTTP contract from browser rendering; never mask API errors.
  const historyResponse = await ctxA.request.get(origin + "/api/logs?limit=20");
  check("Logs authenticated history HTTP 200", historyResponse.status() === 200);
  const historyPage = await historyResponse.json();
  check("Logs history API returns total 180 and 20 bounded rows",
    historyPage.total === 180 && historyPage.logs?.length === 20);
  await navigate(pageA, "Audit Trail");
  await new Promise(r => setTimeout(r, 750));
  evidence.auditNavigationPath = new URL(pageA.url()).pathname;
  evidence.auditVisibleMain = await pageA.locator("main").count()
    ? (await pageA.locator("main").innerText()).slice(0, 350)
    : "MAIN_NOT_PRESENT";
  await pageA.screenshot({ path: "ci-admin-evidence/audit-trail-navigation.png" });
  await poll(async () => (await pageA.locator("main").innerText()).includes("AUDIT LOG TRAIL"),
    "Audit Trail view is mounted");
  await poll(async () => (await pageA.locator("main").innerText()).includes("AUDIT LOG TRAIL (180)") &&
    await pageA.locator("main tbody tr").count() === 20, "180 historical logs server-paged");
  const logsLast = pageA.waitForResponse(res => res.url().includes("/api/logs?") &&
    new URL(res.url()).searchParams.get("offset") === "160", { timeout: 12000 });
  await pageA.locator('main button[title="Last Page"]').click();
  const logsLastResponse = await logsLast;
  const logsLastData = await logsLastResponse.json();
  check("Logs oldest history beyond initial 150 accessible",
    logsLastResponse.status() === 200 && logsLastData.total === 180 &&
    logsLastData.logs.length === 20 &&
    logsLastData.logs.some(x => x.id === "ci_e2e_log_000"));
  await poll(async () => await pageA.locator("main tbody tr").count() === 20,
    "Logs historical last page");
  await pageA.locator('main select').first().selectOption("reject");
  await poll(async () => (await pageA.locator("main").innerText()).includes("AUDIT LOG TRAIL (90)"),
    "Logs action filter total");
  check("Logs action filter counts all 90 rejected rows", true);
  await pageA.locator('main select').first().selectOption("all");

  await navigate(pageA, "Applications");
  await poll(async () => (await pageA.locator("main").innerText()).includes("CI E2E Alpha"),
    "apps initial data loaded");
  const csrfB = await (await ctxB.request.get(origin + "/api/auth/csrf")).json();
  const beforeCreationFrames = a.frames.length;
  const start = performance.now();
  const created = await ctxB.request.post(origin + "/api/apps", {
    headers: { origin, "x-csrf-token": csrfB.csrfToken },
    data: { app_slug: "ci-e2e-live-created", display_name: "CI E2E Live Created App" }
  });
  check("second session mutates CI-only app via authenticated HTTP",
    created.status() === 200);
  await poll(async () => (await pageA.locator("main").innerText())
    .includes("CI E2E Live Created App"), "Admin WSS-triggered UI refresh", 20000);
  const mutationToUiMs = Math.round(performance.now() - start);
  evidence.ciMutationToUiMs = mutationToUiMs;
  // Either an App invalidation or a cursor-boundary resync is valid, but
  // require the frame to arrive after the App POST began.
  check("live change reached other browser without reload",
    a.frames.slice(beforeCreationFrames).some(f =>
      (f.type === "resource.changed" && f.resource === "apps") ||
      f.type === "stream.resync"));
  check("browser maintains singleton Admin socket",
    a.sockets.length === 1 && b.sockets.length === 1);
  await poll(async () => (await pageB.locator("main .cursor-pointer").filter({ hasText: "Apps" }).first().innerText()).includes("153"),
    "second browser Overview Apps metric updates after creation");
  check("Overview Apps metric synchronizes across Admin sessions", true);
  await pageA.screenshot({ path: "ci-admin-evidence/apps-live-refresh.png" });
  console.log("CI_MUTATION_TO_UI_MS=" + mutationToUiMs + " (one sample; NOT p95)");

  // Phase-01: prove complementary display-field updates and the other
  // transactionally created resources notify a second real browser session.
  const newApp = (await created.json()).app;
  check("CI app creation has an ID", typeof newApp?.id === "string");
  const appBeforeEdit = a.frames.filter(f => f.type === "resource.changed" && f.resource === "apps").length;
  const metadataEdit = await ctxB.request.patch(origin + "/api/apps/" + encodeURIComponent(newApp.id), {
    headers: { origin, "x-csrf-token": csrfB.csrfToken },
    data: { display_name: "CI E2E Metadata Updated" }
  });
  check("metadata-only App PATCH", metadataEdit.status() === 200);
  await poll(() => a.frames.filter(f => f.type === "resource.changed" && f.resource === "apps").length > appBeforeEdit,
    "metadata update event", 12000);
  await poll(async () => (await pageA.locator("main").innerText()).includes("CI E2E Metadata Updated"),
    "metadata update UI", 12000);
  check("metadata-only App update reaches other browser", true);

  // Phase-04: repeated synthetic HTTP mutation -> visible other-Chromium UI.
  // Nearest-rank percentiles characterize this small disposable CI sample only.
  const uiSamplesMs = [];
  for (let i = 0; i < 12; i++) {
    const displayName = "CI E2E P04 Pulse " + String(i).padStart(2, "0");
    const t0 = performance.now();
    const updated = await ctxB.request.patch(
      origin + "/api/apps/" + encodeURIComponent(newApp.id), {
        headers: { origin, "x-csrf-token": csrfB.csrfToken },
        data: { display_name: displayName }
      });
    if (updated.status() !== 200) throw new Error("Phase-04 synthetic metadata PATCH failed");
    await poll(async () =>
      (await pageA.locator("main tbody").innerText()).includes(displayName),
      "Phase-04 HTTP-to-Chromium visible event " + i, 16000);
    uiSamplesMs.push(Math.round(performance.now() - t0));
  }
  const orderedSamples = [...uiSamplesMs].sort((x, y) => x - y);
  const percentile = p => orderedSamples[Math.ceil(p * orderedSamples.length) - 1];
  evidence.performance = {
    scope: "DISPOSABLE_CI_ONLY",
    series: "authenticated App PATCH start -> other Chromium table shows new value",
    sampleCount: uiSamplesMs.length,
    samplesMs: uiSamplesMs,
    p50Ms: percentile(0.50),
    p95Ms: percentile(0.95),
    minMs: orderedSamples[0],
    maxMs: orderedSamples.at(-1),
    estimator: "nearest-rank small-sample percentiles; not production latency",
    cpu: "SEPARATELY_MEASURED_IN_LOAD_ARTIFACT",
    databaseQps: "SEPARATELY_MEASURED_IN_LOAD_ARTIFACT"
  };
  check("12 measured cross-browser UI latency observations",
    uiSamplesMs.length === 12 && uiSamplesMs.every(x => Number.isFinite(x) && x >= 0));
  check("bounded CI-only p50/p95 derived from observed samples",
    evidence.performance.p50Ms <= evidence.performance.p95Ms &&
    evidence.performance.p95Ms <= evidence.performance.maxMs);
  console.log("CI_ONLY_UI_LATENCY " + JSON.stringify({
    n: 12, p50Ms: evidence.performance.p50Ms,
    p95Ms: evidence.performance.p95Ms
  }));

  const licenseCount = a.frames.filter(f => f.type === "resource.changed" && f.resource === "licenses").length;
  const newLicense = await ctxB.request.post(origin + "/api/licenses", {
    headers: { origin, "x-csrf-token": csrfB.csrfToken },
    data: { key: "CI-E2E-LIVE-LICENSE", app_id: newApp.id,
      device_limit: 2, customer_name: "CI-only Browser Fixture" }
  });
  check("CI-only license INSERT HTTP", newLicense.status() === 200);
  await poll(() => a.frames.filter(f => f.type === "resource.changed" && f.resource === "licenses").length > licenseCount,
    "license INSERT WSS notification", 12000);
  check("license INSERT causes sanitized Admin notification", true);
  await poll(async () => (await pageB.locator("main .cursor-pointer").filter({ hasText: "Total Keys" }).first().innerText()).includes("153"),
    "second browser Overview License metric updates");
  check("Overview License metric synchronizes across Admin sessions", true);

  await navigate(pageA, "Audit Trail");
  await poll(async () => (await pageA.locator("main").innerText()).includes("AUDIT LOG TRAIL (180)"),
    "audit page mounted before real validation log");
  const deviceCount = a.frames.filter(f => f.type === "resource.changed" && f.resource === "devices").length;
  const validation = await ctxB.request.post(origin + "/api/v1/license/validate", {
    data: { license_key: "CI-E2E-LIVE-LICENSE", hwid: "ci-e2e-live-device",
      app_name: "ci-e2e-live-created", app_version: "1.0.0",
      device_name: "CI-only Device", os_info: "CI test" }
  });
  check("synthetic SDK validation binds new device", validation.status() === 200);
  await poll(() => a.frames.filter(f => f.type === "resource.changed" && f.resource === "devices").length > deviceCount,
    "device INSERT WSS notification", 12000);
  check("device INSERT causes sanitized Admin notification", true);
  await poll(async () => (await pageA.locator("main").innerText()).includes("AUDIT LOG TRAIL (181)") &&
    (await pageA.locator("main tbody").innerText()).includes("CI-E2E-LIVE-LICENSE"),
    "Logs page live updates from CI-only validation");
  await poll(async () => (await pageB.locator("main").innerText()).includes("CI-E2E-LIVE-LICENSE"),
    "Overview recent activity live refresh");
  check("Logs and Overview synchronize after CI validation", true);
  await navigate(pageA, "HWID Locks");
  // The earlier pagination check intentionally left this tab on page 8.
  // Restore page 1 before asserting the newly bound, most-recent device.
  await pageA.locator('main button[title="First Page"]').click();
  await poll(async () => (await pageA.locator("main").innerText()).includes("Total Bound: 151") &&
    (await pageA.locator("main tbody").innerText()).includes("ci-e2e-live-device"),
    "Devices page reflects new CI-only binding");
  check("Devices table synchronizes new binding across Admin sessions", true);

  // SDK-STAT-01: real encrypted-transport reporting on CI-only license/device.
  const reportSession = await ctxB.request.post(origin + "/api/v1/license/validate", {
    data: { license_key: "CI-E2E-LIVE-LICENSE", hwid: "ci-e2e-live-device",
      app_name: "ci-e2e-live-created", app_version: "1.0.0",
      device_name: "CI-only Device", os_info: "CI test",
      nonce: "CI_STATS_ONLY_NONCE_0123456789", stats_capability_version: 1 }
  });
  check("SDK-STAT-01 CI device capability from verified-signed server path", reportSession.status() === 200);
  const signedReport = await reportSession.json();
  check("SDK-STAT-01 report capability is independently scoped and opaque",
    typeof signedReport.signature === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(signedReport.stats_capability ?? "") &&
    signedReport.stats_capability !== signedReport.device_logout_proof);
  const reportResult = await setupClient.post("/api/v1/device/stats", {
    headers: { Authorization: "Bearer " + signedReport.stats_capability },
    data: { stats: { Total: 5000, Send: 200, Failed: 4800 } }
  });
  check("SDK-STAT-01 device statistics accepted on disposable PostgreSQL", reportResult.status() === 202);
  const ciLicenseId = (await newLicense.json()).license.id;
  const adminReport = await ctxA.request.get(origin + "/api/licenses/" + ciLicenseId + "/device-stats");
  check("SDK-STAT-01 authenticated inspector returns matching device statistics",
    adminReport.status() === 200 &&
    (await adminReport.json()).devices.some(d => d.stats?.Send === 200 && d.stats?.Failed === 4800));
  const adminReportText = JSON.stringify(await (await ctxA.request.get(
    origin + "/api/licenses/" + ciLicenseId + "/device-stats")).json());
  check("SDK-STAT-01 Admin never receives bearer or token hash",
    !adminReportText.includes(signedReport.stats_capability) &&
    !adminReportText.includes("report_token_hash"));

  check("Admin WSS contains no license key, HWID or private payload",
    !a.frames.some(f => JSON.stringify(f).includes("CI-E2E-LIVE-LICENSE") ||
      JSON.stringify(f).includes("ci-e2e-live-device")));

  const logout = await ctxB.request.post(origin + "/api/auth/logout", {
    headers: { origin, "x-csrf-token": csrfB.csrfToken }, data: {} });
  check("logout HTTPS request", logout.status() === 200);
  await poll(() => b.sockets[0].isClosed(), "session B WSS close on logout", 12000);
  check("other admin session remains active", !a.sockets[0].isClosed());
  check("second browser logout isolated", b.sockets[0].isClosed());

  // Phase-03: simulate an Admin WSS feature-gate outage without touching the server.
  await navigate(pageA, "Audit Trail");
  const socketsBeforeFallback = a.sockets.length;
  await pageA.route("**/api/admin/realtime/bootstrap", route => route.fulfill({
    status: 404, contentType: "application/json",
    body: JSON.stringify({ code: "ADMIN_REALTIME_DISABLED" })
  }));
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await poll(async () => (await pageA.locator("main").innerText()).includes("HTTP fallback"),
    "browser shows HTTP fallback when WSS unavailable", 15000);
  const fallbackLogs = await ctxA.request.get(origin + "/api/logs?limit=20");
  check("HTTP history accessible during WSS fallback",
    fallbackLogs.status() === 200 && (await fallbackLogs.json()).total >= 181);
  check("WSS unavailable is not misreported as a new live socket",
    a.sockets.length === socketsBeforeFallback);
  await pageA.unroute("**/api/admin/realtime/bootstrap");
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await poll(() => a.sockets.length > socketsBeforeFallback,
    "new WSS opens after transport restored", 18000);
  await poll(async () => (await pageA.locator("main").innerText()).includes("Live updates"),
    "browser returns to live after WSS restored", 18000);
  check("WSS recovered without losing HTTP access", !a.sockets.at(-1).isClosed());

  // Phase-03: rotating Admin signing credentials invalidates older sessions.
  const beforeRotation = a.sockets.at(-1);
  const rotated = await ctxA.request.post(origin + "/api/auth/update-credentials", {
    headers: { origin, "x-csrf-token": csrfA.csrfToken },
    data: { currentPassword: process.env.CI_ADMIN_PASSWORD }
  });
  check("Admin credential rotation accepted in disposable CI", rotated.status() === 200);
  await poll(() => beforeRotation.isClosed(),
    "previous Admin WSS closed after credential rotation", 25000);
  check("credential rotation invalidates old WSS", beforeRotation.isClosed());
  const oldJwtAccess = await setupClient.get("/api/auth/me", {
    headers: { authorization: "Bearer " + firstSession.value }
  });
  check("credential rotation rejects old JWT", oldJwtAccess.status() === 401);
  const expiredMonitorAccess = await setupClient.get("/api/monitoring/devices?app_id=ci_e2e_app_a", {
    headers: { authorization: "Bearer " + firstSession.value }
  });
  check("LM-RG01 expired Admin session rejects new monitor endpoint",
    expiredMonitorAccess.status() === 401);
  const freshJwtAccess = await ctxA.request.get(origin + "/api/auth/me");
  check("credential rotation preserves new authorized HTTP session", freshJwtAccess.status() === 200);
  await poll(async () => (await pageA.locator("main").innerText()).includes("Session expired"),
    "browser marks prior WSS session expired", 12000);
  check("expired realtime view is not labeled live",
    !(await pageA.locator("main").innerText()).includes("Live updates"));

  evidence.acceptance = "CI_BROWSER_PARTIAL_PASS";
  evidence.publicCaddyTrust = "DISPOSABLE_LOCAL_CA_ONLY";
  evidence.productionApproval = "NO_GO_PENDING_REAL_STAGING";
} catch (error) {
  evidence.acceptance = "FAIL";
  evidence.error = String(error?.message ?? error).slice(0, 260);
  process.exitCode = 1;
  console.error("ADMIN_BROWSER_ACCEPTANCE_FAILED (details in sanitized evidence)");
} finally {
  await writeFile("ci-admin-evidence/result.json",
    JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 }).catch(() => {});
  await browser?.close().catch(() => {});
  await setupClient?.dispose().catch(() => {});
}
