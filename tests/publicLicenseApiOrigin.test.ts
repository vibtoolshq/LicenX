import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAllowedToolOrigin } from "../src/server/publicLicenseApiControl.js";

test("Admin Public API domains must be exact HTTPS origins", () => {
  assert.equal(normalizeAllowedToolOrigin("https://tools.example"), "https://tools.example");
  assert.equal(normalizeAllowedToolOrigin("https://tools.example/"), "https://tools.example");
  assert.equal(normalizeAllowedToolOrigin("https://tools.example:444"), "https://tools.example:444");
  for (const value of [
    "http://tools.example", "https://*.example.com", "https://foo.example/path",
    "https://foo.example?x=1", "https://foo.example/#fragment",
    "https://user:password@tools.example", " https://tools.example",
    "javascript:alert(1)", "", "https://foo.example.com.evil.example/path",
  ]) assert.equal(normalizeAllowedToolOrigin(value), null, value);
});
