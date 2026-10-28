import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ownerBootstrapRequired, validOwnerSetupCode } from "../src/server/bootstrap.js";
const code = "a".repeat(64);
const env = { DATABASE_PROVIDER: "postgres", OWNER_SETUP_CODE_SHA256: createHash("sha256").update(code).digest("hex") };
test("PostgreSQL owner setup requires a valid 256-bit one-time code", () => {
  assert.equal(ownerBootstrapRequired(env), true);
  assert.equal(validOwnerSetupCode(code, env), true);
  assert.equal(validOwnerSetupCode("b".repeat(64), env), false);
  assert.equal(validOwnerSetupCode(undefined, env), false);
  assert.equal(validOwnerSetupCode("not-hex", env), false);
  assert.equal(validOwnerSetupCode(code, { DATABASE_PROVIDER: "postgres" }), false);
  assert.equal(validOwnerSetupCode(code, { ...env, OWNER_SETUP_CODE_SHA256: "junk" }), false);
});
test("existing Turso/Cloudflare setup path is unchanged", () => {
  const legacy = { DATABASE_PROVIDER: "libsql" };
  assert.equal(ownerBootstrapRequired(legacy), false);
  assert.equal(validOwnerSetupCode(undefined, legacy), true);
});
test("PostgreSQL URL detection protects unspecified provider", () => {
  assert.equal(ownerBootstrapRequired({ DATABASE_URL: "postgresql://localhost/any" }), true);
});
