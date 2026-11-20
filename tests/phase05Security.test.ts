import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (name: string) => readFileSync(name, "utf8");
test("external admin read/manage routes deny cross-application keys in both runtimes", () => {
  for (const file of ["src/server/api.ts", "src/server/cloudflareHandler.ts"]) {
    const code = source(file);
    const guards = code.match(/application scope mismatch/g) ?? [];
    assert.ok(guards.length >= 3, file + " must guard details, device reset and license status");
    assert.match(code, /SELECT id, status, app_id FROM licenses WHERE key = \? LIMIT 1/);
  }
});
test("Node proof-bound logout denies legacy mutation; Cloudflare blocked-device check remains", () => {
  const node = source("src/server/api.ts");
  assert.match(node, /LOGOUT_PROOF_REQUIRED/);
  assert.match(node, /takeDeviceLogoutProof\(token\)/);
  assert.match(node, /WHERE id = \? AND license_id = \? AND hwid = \? AND status = 'active'/);
  const cloudflare = source("src/server/cloudflareHandler.ts");
  assert.match(cloudflare, /WHERE d\.id = \? AND d\.license_id = \? AND d\.hwid = \? AND d\.status = 'active' AND d\.last_ping_at = \? LIMIT 1/);
  assert.match(cloudflare, /UPDATE devices SET status = 'logged_out', last_ping_at = CASE WHEN last_ping_at >= \? THEN last_ping_at \+ 1 ELSE \? END WHERE id = \? AND license_id = \? AND hwid = \? AND status = 'active' AND last_ping_at = \? RETURNING id/);
  assert.match(cloudflare, /args: \[now, now, claim\.device, claim\.license, claim\.hwid, claim\.generation\]/);
  assert.match(cloudflare, /crypto\.timingSafeEqual\(supplied, expected\)/);
  assert.match(cloudflare, /WHERE license_id = \? AND status = 'active'/);
  assert.match(cloudflare, /DELETE FROM devices WHERE license_id = \? AND status != 'blocked'/);
});
test("app scoped heartbeats deny disabled or missing parent in both runtimes", () => {
  for (const file of ["src/server/api.ts", "src/server/cloudflareHandler.ts"]) {
    const code = source(file);
    const start = code.indexOf('"/v1/license/ping"');
    const end = code.indexOf('"/v1/license/logout"', start);
    const body = code.slice(start, end);
    assert.match(body, /SELECT status FROM apps WHERE id = \? LIMIT 1/);
    assert.match(body, /APP_NOT_FOUND/);
    assert.match(body, /APP_INACTIVE/);
  }
});
test("Python SDK signed payload stays UTF-8 and local discovery closes sockets", () => {
  for (const dir of ["SDK/client/python/licenx"]) {
    assert.match(source(dir + "/server.py"), /ensure_ascii=False/);
    assert.match(source(dir + "/device.py"), /with socket.socket\(/);
  }
});
test("embedded recovery values no longer ship as a fixture", () => {
  assert.doesNotMatch(source("SDK/client/python/licenx/storage.py"), /base64.b64encode|base64.b64decode/);
  const code = source("scripts/restoreData.mjs");
  assert.match(code, /--confirm-local-import/);
  assert.doesNotMatch(code, /app_secret:|'sec_[a-f0-9]{20}/);
  assert.match(source(".gitignore"), /\/\*\.db/);
});
