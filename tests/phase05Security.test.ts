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
test("client self-service logout and resets never erase blocked devices", () => {
  for (const file of ["src/server/api.ts", "src/server/cloudflareHandler.ts"]) {
    const code = source(file);
    assert.match(code, /last_ping_at = \? WHERE license_id = \? AND hwid = \? AND status = 'active'/);
    assert.match(code, /WHERE license_id = \? AND status = 'active'/);
  }
  assert.match(source("src/server/cloudflareHandler.ts"), /DELETE FROM devices WHERE license_id = \? AND status != 'blocked'/);
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
  for (const dir of ["SDK/x_license_python", "SDK/client/python/licenx"]) {
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
