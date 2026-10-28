import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAdminLicenseCreation, decodeAdminLicensePathKey } from "../src/server/adminApiInput.js";
import { createAdminApiRateLimiter } from "../src/server/adminApiRateLimiter.js";

test("Admin APIs accepts existing normal/default fields and numeric strings", () => {
  for (const value of [{}, {
    key: "APP-TEST", prefix: "STORE", tier: "Pro", app_slug: "my-app",
    device_limit: 1, validity_type: "daily", validity_value: 30,
    customer_name: "Customer", customer_email: "a@example.com", notes: "Order",
    expires_at: null,
  }, { device_limit: "3", validity_value: "24", expires_at: "1799999999999" }]) {
    assert.equal(validateAdminLicenseCreation(value), null);
  }
});

test("Admin APIs rejects malformed license request body and unsafe parameters", () => {
  const invalid: Array<[unknown, string]> = [
    [null, "body"], [[], "body"], ["request", "body"],
    [{ key: 42 }, "key"], [{ key: {} }, "key"],
    [{ prefix: null }, "fields"], [{ prefix: "ST\nORE" }, "prefix"],
    [{ app_slug: { x: 1 } }, "app_slug"],
    [{ device_limit: -1 }, "device_limit"], [{ device_limit: 1.5 }, "device_limit"],
    [{ device_limit: "Infinity" }, "device_limit"],
    [{ validity_type: "yearly" }, "validity_type"], [{ validity_value: -12 }, "validity_value"],
    [{ validity_value: "NaN" }, "validity_value"], [{ expires_at: -1 }, "expires_at"],
    [{ expires_at: "nonsense" }, "expires_at"], [{ tier: 1 }, "tier"],
  ];
  for (const [payload, error] of invalid) {
    assert.match(validateAdminLicenseCreation(payload) || "", new RegExp(error));
  }
});

test("Cloudflare license path decoder returns 400 sentinel instead of throwing", () => {
  assert.equal(decodeAdminLicensePathKey("app-ABC"), "APP-ABC");
  assert.equal(decodeAdminLicensePathKey("key%20one"), "KEY ONE");
  assert.equal(decodeAdminLicensePathKey("%ZZ"), null);
  assert.equal(decodeAdminLicensePathKey("%C3%28"), null);
});

test("Admin API rate limiter preserves existing 120/min semantics and resets after window", () => {
  const limiter = createAdminApiRateLimiter(120, 60_000, 10);
  for (let i = 0; i < 120; i++) assert.equal(limiter.check("clientA", 1000), true);
  assert.equal(limiter.check("clientA", 1000), false);
  assert.equal(limiter.check("clientB", 1000), true);
  assert.equal(limiter.check("clientA", 61_001), true);
});

test("Admin API rate limiter bounds state and cannot evict active limits", () => {
  const limiter = createAdminApiRateLimiter(2, 1000, 2);
  assert.equal(limiter.check("clientA", 1), true);
  assert.equal(limiter.check("clientA", 1), true);
  assert.equal(limiter.check("clientA", 1), false);
  assert.equal(limiter.check("clientB", 1), true);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.check("clientC", 1), false);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.check("clientA", 1), false);
  assert.equal(limiter.check("clientC", 1002), true);
  assert.equal(limiter.size(), 1);
});
