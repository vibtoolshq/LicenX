import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePublicLicense } from "../src/server/restrictedPublicLicenseCheck.js";

test("restricted read-only membership evaluator computes status without persistence", () => {
  const now = 1234567890;
  const active = { status: "active", app_status: "active", validity_type: "lifetime", activated_at: null, expires_at: null };
  assert.deepEqual(evaluatePublicLicense(active, now), {
    valid: true, status: "active", app: null, validity_type: "lifetime",
    validity_value: null, expires_at: null, expires_in_seconds: null, checked_at: now,
  });
  const globalResult = evaluatePublicLicense({
    ...active, app_name: "Example App", app_slug: "example-app", validity_value: 0,
  }, now);
  assert.deepEqual(globalResult.app, { name: "Example App", slug: "example-app" });
  assert.equal(globalResult.validity_type, "lifetime");
  assert.equal(evaluatePublicLicense(null, now).status, "not_valid");
  assert.equal(evaluatePublicLicense({ ...active, app_status: "inactive" }, now).status, "inactive_app");
  for (const status of ["revoked", "suspended", "expired"]) {
    assert.equal(evaluatePublicLicense({ ...active, status }, now).status, status);
  }
  assert.equal(evaluatePublicLicense({ ...active, validity_type: "daily" }, now).status, "not_activated");
  assert.equal(evaluatePublicLicense({ ...active, validity_type: "hourly", activated_at: now - 50 }, now).valid, false, "activated timed license missing expiry fails closed");
  assert.equal(evaluatePublicLicense({ ...active, expires_at: now - 1 }, now).status, "expired");
  const valid = evaluatePublicLicense({ ...active, expires_at: now + 2100 }, now);
  assert.equal(valid.valid, true);
  assert.equal(valid.expires_in_seconds, 3);
});
