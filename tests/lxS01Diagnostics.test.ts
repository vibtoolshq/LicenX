import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ingestAdminDiagnostic, ingestSdkDiagnostic, issueSdkDiagnosticCapability,
  isDiagnosticCode, listSafeDiagnostics, recordInternalDiagnostic,
} from "../src/server/diagnostics.js";

test("LX-S01: diagnostics issued only from an opaque bounded capability", () => {
  const capability = issueSdkDiagnosticCapability();
  assert.match(capability.incident_id, /^[0-9a-f-]{36}$/i);
  assert.match(capability.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ingestSdkDiagnostic(null, {stage:"tls_handshake",code:"REALTIME_TLS_ERROR",attempt:0}), "unauthorized");
  assert.equal(ingestSdkDiagnostic("bad", {stage:"tls_handshake",code:"REALTIME_TLS_ERROR",attempt:0}), "unauthorized");
  assert.equal(ingestSdkDiagnostic(capability.token, {
    stage:"tls_handshake",code:"REALTIME_TLS_ERROR",attempt:0,license_key:"SECRET-SENTINEL",
  }), "invalid");
  assert.equal(ingestSdkDiagnostic(capability.token, {
    stage:"tls_handshake",code:"REALTIME_TLS_ERROR",attempt:0,tls_verify_code:100000,
  }), "invalid");
  assert.equal(ingestSdkDiagnostic(capability.token, {
    stage:"tls_handshake",code:"REALTIME_TLS_ERROR",attempt:2,tls_verify_code:20,
  }), "accepted");
  const result = listSafeDiagnostics({incident_id:capability.incident_id});
  assert.equal(result.volatile, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].incident_id, capability.incident_id);
  assert.equal(result.entries[0].code, "REALTIME_TLS_ERROR");
  assert.equal(result.entries[0].tls_verify_code, 20);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("SECRET-SENTINEL"));
  assert.ok(!serialized.includes(capability.token), "token must never be in reports");
});

test("LX-S01: diagnostic token cannot create arbitrary events or exceed its report quota", () => {
  const { token } = issueSdkDiagnosticCapability();
  for (let i=0;i<8;i++) {
    assert.equal(ingestSdkDiagnostic(token, {stage:"ticket",code:"REALTIME_TICKET_DISABLED",attempt:0}), "accepted");
  }
  assert.notEqual(ingestSdkDiagnostic(token, {stage:"ticket",code:"REALTIME_TICKET_DISABLED",attempt:0}), "accepted");
  assert.equal(ingestSdkDiagnostic(token, {stage:"ticket",code:"SECRET_SENTINEL",attempt:0}), "rate_limited");
});

test("LX-S01: server/Admin diagnostics are fixed-code, in-memory and never arbitrary strings", () => {
  assert.equal(isDiagnosticCode("PRIVATE_SECRET"), false);
  assert.ok(recordInternalDiagnostic("server_api", "validate", "VALIDATION_OK"));
  assert.equal(recordInternalDiagnostic("server_api", "validate", "PRIVATE_SECRET"), null);
  assert.equal(ingestAdminDiagnostic({ code:"ADMIN_UI_RENDER_ERROR", password:"sentinel" }), "invalid");
  assert.equal(ingestAdminDiagnostic({ code:"ADMIN_UI_RENDER_ERROR" }), "accepted");
  const result = listSafeDiagnostics({code:"ADMIN_UI_RENDER_ERROR"});
  assert.ok(result.entries.length>=1);
  assert.ok(result.entries.every(x=>x.component==="admin_ui"));
  assert.ok(!JSON.stringify(result).includes("sentinel"));
});
