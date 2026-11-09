/**
 * Real Chromium browser acceptance against CI-only HTTPS Caddy.
 * Never points at a supplied host, production domain, or customer data.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, request } from "playwright";

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

  browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const a = captureSocket(pageA);
  const b = captureSocket(pageB);
  await login(pageA, process.env.CI_ADMIN_PASSWORD);
  await poll(() => a.frames.some(f => f.type === "admin.ready"),
    "first browser Admin WSS ready");
  await login(pageB, process.env.CI_ADMIN_PASSWORD);
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

  await navigate(pageA, "Applications");
  await poll(async () => (await pageA.locator("main").innerText()).includes("CI E2E Alpha"),
    "apps initial data loaded");
  const csrfB = await (await ctxB.request.get(origin + "/api/auth/csrf")).json();
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
  check("live change reached other browser without reload",
    a.frames.some(f => f.type === "resource.changed" && f.resource === "apps"));
  check("browser maintains singleton Admin socket",
    a.sockets.length === 1 && b.sockets.length === 1);
  await pageA.screenshot({ path: "ci-admin-evidence/apps-live-refresh.png" });
  console.log("CI_MUTATION_TO_UI_MS=" + mutationToUiMs + " (one sample; NOT p95)");

  const logout = await ctxB.request.post(origin + "/api/auth/logout", {
    headers: { origin, "x-csrf-token": csrfB.csrfToken }, data: {} });
  check("logout HTTPS request", logout.status() === 200);
  await poll(() => b.sockets[0].isClosed(), "session B WSS close on logout", 12000);
  check("other admin session remains active", !a.sockets[0].isClosed());
  check("second browser logout isolated", b.sockets[0].isClosed());

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
