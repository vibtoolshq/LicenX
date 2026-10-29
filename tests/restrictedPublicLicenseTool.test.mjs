import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLicenseMembership, allowedApiOrigin } from "../examples/restricted-license-tool/licenxClient.mjs";
import { createToolServer } from "../examples/restricted-license-tool/server.mjs";

const TOKEN = "vcon_sec_" + "a".repeat(48);
const API = "https://licenx.example";
const TOOL = "https://tools.example";
const NOW = 1790000000000;
const valid = { valid: true, status: "active", expires_at: NOW + 60_000, checked_at: NOW };
const mock = (data, status = 200, headers = {}) => async (_url, init) => {
  assert.equal(_url, API + "/api/v1/public/license/check");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer " + TOKEN);
  assert.equal(init.headers["X-LicenX-Tool-Origin"], TOOL);
  assert.equal(JSON.parse(init.body).license_key, "ABC-123");
  return new Response(JSON.stringify(data), { status, headers });
};
async function start(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    url: base,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
const post = (url, licenseKey = "ABC-123", headers = {}) => fetch(url + "/tool/run", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ license_key: licenseKey }),
});

test("connector rejects unsafe upstream URLs, missing credentials and unauthorized results", async () => {
  assert.equal(allowedApiOrigin("http://licenx.example"), null);
  assert.equal(allowedApiOrigin("https://someone:password@licenx.example/"), null);
  assert.equal(allowedApiOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  const base = { apiBaseUrl: API, consumerToken: TOKEN, toolOrigin: TOOL, licenseKey: "abc-123", now: NOW };
  assert.equal((await checkLicenseMembership({ ...base, consumerToken: "" })).code, "NOT_CONFIGURED");
  assert.deepEqual(await checkLicenseMembership({ ...base, fetchImpl: mock(valid) }), { allowed: true, code: "OK" });
  assert.equal((await checkLicenseMembership({ ...base, fetchImpl: mock({ valid: false, status: "not_valid" }) })).code, "LICENSE_NOT_VALID");
  assert.equal((await checkLicenseMembership({ ...base, fetchImpl: mock({ ...valid, expires_at: NOW - 1 }) })).allowed, false);
  assert.equal((await checkLicenseMembership({ ...base, fetchImpl: mock({ ...valid, checked_at: NOW - 500_000 }) })).allowed, false);
  assert.equal((await checkLicenseMembership({ ...base, fetchImpl: mock({}, 401) })).code, "VALIDATOR_UNAVAILABLE");
  const throttle = await checkLicenseMembership({ ...base, fetchImpl: mock({}, 429, { "Retry-After": "120" }) });
  assert.deepEqual(throttle, { allowed: false, code: "RATE_LIMITED", retryAfter: 120 });
  assert.equal((await checkLicenseMembership({ ...base, fetchImpl: async () => { throw Error("no upstream"); } })).allowed, false);
});

test("backend protects action server-side; browser never receives token or raw license key", async () => {
  let calls = 0;
  const server = createToolServer({
    apiBaseUrl: API, consumerToken: TOKEN, toolOrigin: TOOL, now: () => NOW,
    fetchImpl: async (...args) => { calls++; return mock(valid)(...args); },
  });
  const { url, close } = await start(server);
  try {
    const badOrigin = await post(url, "ABC-123", { Origin: "https://evil.example" });
    assert.equal(badOrigin.status, 403);
    assert.equal(calls, 0);
    const invalid = await post(url, "not valid :(");
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    const good = await post(url, "abc-123", { Origin: TOOL });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("access-control-allow-origin"), null);
    assert.equal(good.headers.get("cache-control"), "no-store");
    const text = await good.text();
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes("ABC-123"), false);
    assert.equal(calls, 1);
    await post(url, "abc-123");
    assert.equal(calls, 2, "membership rechecked every protected action");
  } finally { await close(); }
});

test("backend fails closed, rate-limits and never executes protected action on an upstream deny", async () => {
  const forbidden = createToolServer({
    apiBaseUrl: API, consumerToken: TOKEN, toolOrigin: TOOL, now: () => NOW,
    rateMax: 2, fetchImpl: mock({ valid: false, status: "expired" }),
  });
  const { url, close } = await start(forbidden);
  try {
    assert.equal((await post(url)).status, 403);
    assert.equal((await post(url)).status, 403);
    const limited = await post(url);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally { await close(); }
  const misconfigured = createToolServer({ apiBaseUrl: API, toolOrigin: TOOL, consumerToken: "" });
  const next = await start(misconfigured);
  try { assert.equal((await post(next.url)).status, 503); }
  finally { await next.close(); }
});
