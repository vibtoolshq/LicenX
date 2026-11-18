# Diagnostics, audit logs and live validator

## Server diagnostics

The **Administration → Server** page invokes `POST /api/admin/server-diagnostics/run` through `ServerDiagnosticsTab`. The server probes loopback health, readiness and protected admin WebSocket access with a timeout/cooldown. It is not a complete external HTTPS or signing-key audit.

## Audit Trail

The **Audit Trail** tab loads persisted validation logs and sanitized in-memory diagnostics. SDK diagnostic submission accepts a short-lived capability and a bounded code vocabulary; admin diagnostics are rate-limited. The UI can delete persisted validation logs, so audit retention changes should be separately authorized.

## Live Validator

The **License Engine → Live Validator** tab asks for target app, license key, client app version and device metadata. It calls the **real license validation** API. This may create/update device binding and validation log entries; use a disposable test license, not a customer key, unless specifically authorized.

## Common failures

A denied validation is not necessarily a server crash. Inspect the returned code and app/version/device policy. Diagnostics deliberately redact identifiers; do not attempt to expose secrets to get “better logs”. An unavailable realtime socket can reflect a disabled gate; verify ordinary HTTPS first.

**Source:** `src/components/ServerDiagnosticsTab.tsx`, `SimulatorTab.tsx`, `LogsTab.tsx`, `src/server/serverDiagnostics.ts`, `src/server/diagnostics.ts`, `src/server/api.ts:76-126,2816-2920`.