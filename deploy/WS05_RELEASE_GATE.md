# LicenX WS-05: Realtime production-release gate and rollback

**Status: NOT PRODUCTION APPROVED until all gates below have independent evidence.**
This guide describes the source/isolated-CI release gate, **not a production deployment procedure automatically executed by ChatGPT**. Code and synthetic CI tests do not establish live fleet capacity or domain trust.

## Current architecture and compatibility
- Existing signed HTTPS `/api/v1/license/validate`, `/api/v1/license/ping` and logout remain authoritative; existing reference SDK and old clients remain HTTP-only, and do not need updates.
- The newer Python SDK defaults `useWebSocket=False`. When opted in with `pip install 'licenx[realtime]'`, it first performs signed HTTPS login, obtains a short-lived single-use device-bound ticket, then opens WSS on the **same** 443/TLS frontend and existing Node port 3000. No extra public WebSocket port.
- Two independent **OFF-by-default** gates: Compose `LICENX_REALTIME_TRANSPORT_ENABLED=false`, and each App's `realtime_websocket_enabled=0`. Enabling either alone cannot grant WebSocket license access.
- Admin's `keep_login_on_network_error` defaults OFF. A new SDK recognizes it ONLY after a bound, RSA/Ed25519-signed `license.snapshot`; unknown, missing or tampered policy stays OFF. OFF invalidates after configured offline grace, ON preserves only an in-memory login-screen hint while unverified protected operations remain denied after grace. Both states immediately deny confirmed revoke/reset/expiry.
- On signed App policy-change event, new client performs a fresh signed HTTP check and reestablishes WSS to refresh signed policy. Existing host application's own UI/task queue must still explicitly honor SDK `is_authenticated()/is_valid()` and connection-state callbacks.
- Node-only presence is local to one process, refreshed at most once/15 seconds in Admin UI; database "bound active" is **not** connected presence. Multi-node requires shared tickets/presence or routing stickiness.

## CI-only verification and capacity claims
- GitHub Phase-05 workflow runs ordinary Node and old/new Python suites, isolated PostgreSQL/HTTP signatures, backup/restore and Caddy HTTPS checks.
- WS-05 additions include real Node gateway WebSocket handshake, one-use token rejection, wrong-App denial, server-signed policy and events, bounded 100 synthetic concurrent sessions in disposable PostgreSQL, p95/p99 handshake duration and sample server RSS/FD/CPU ticks, trusted local-CA Caddy WSS, real Python websocket-client login, restart/reconnect, and rollback gate with signed HTTP heartbeat.
- `scripts/loadRealtime.mjs` will **refuse** to run unless `GITHUB_ACTIONS=true` and `WS05_CI_RUN=1`. Fixture writes additionally refuse databases other than private `licenx_ci` on Docker network. CI cohort defaults to 100 and cap is 1000; counts 1000/5000/10000 are **not** established without separately authorized staging/host measurement.
- One short burst is **not sustained capacity**. A successful synthetic CI result must never be represented as verified support for 10,000 running devices, reliable 24-hour connections or tested production CPU/RAM consumption.
- Caddy reverse-proxy HTTP Upgrade/WSS is checked with its disposable local CA trusted in the CI test runner; public DNS/CDN/TLS and WSS through the actual domain remain **unverified**.

## Operator release preflight — human sign-off required
1. Verify legal right to redistribute reviewed SocketCore engine source. Upstream module lacked an explicit root LICENSE at earlier audit; owner or counsel must document redistribution permission. This repository's MIT license alone does not grant rights to external third-party code.
2. Confirm known historical signing-key, bootstrap/admin secret or exposed-code security findings are resolved; rotate affected credentials and tokens by an authorized operator. No automated history rewrite or secret rotation in WS-05.
3. Capture encrypted **private** database dump and application storage backup; test restore on a staging VPS with identical schema/volumes and ensure device-license counts and signing keys are preserved. **Do not test destructive restore on customer PostgreSQL.**
4. Validate domain-specific TLS chain, Caddy/Coolify/CDN WSS upgrade forwarding, owner firewall and single-proxy trust; confirm no extra public TCP 3000 and no direct PostgreSQL exposure. Require TLS 1.2+ and strict certificate validation. Private CA overrides are CI-only.
5. Verify multi-node expectations. In-memory WS tickets and Admin connected counts are process-local; out-of-order event journal commit IDs may delay immediate event fan-out under concurrent writers; conditional 60s lease revalidation and reconnect signed snapshot mitigate authorization risk, **not guaranteed immediate delivery**. Journal retention is not automated; plan bounded cleanup/backups and monitor event-table growth before public scale.
6. On a **separate non-production staging host**, measure 100, then 1000, 5000 and 10000 clients only as resources permit, recording CPU/RSS/fd, p95/p99 auth latency, PostgreSQL writes, reconnect bursts, teardown, network partitions and concurrent admin revocations. Stop when safety/resources thresholds are hit; no synthetic global capacity claim.
7. First rollout must keep both toggles OFF, prove old SDK HTTP traffic. Enable one low-risk App and a small opted-in new SDK cohort; monitor signed license errors, stale leases and DB journal growth. Gradual escalation requires explicit owner approval.
8. Verify application GUI integration: `has_login_session()` must **never** grant protected operations; `is_valid()` must gate them, and connection callback must be marshalled to the UI main thread. An offline SDK without a prior signed WS snapshot defaults Keep Login OFF; this is the safe fallback, not hidden remote enforcement.
9. Formally approve signed release, backup/restore rollback, owner credentials, documentation and customer communication. No server deployment is performed in this project phase.

## Emergency rollback (manual, authorized deployment only)
- In the approved Compose deployment env, set `LICENX_REALTIME_TRANSPORT_ENABLED=false` (default). Recreate **only the app service** with the existing checked-in Compose; do **not** remove PostgreSQL or volumes. This disables ticket issuance/WSS upgrades but preserves signed HTTPS validation/heartbeat.
- Optionally set per-App `realtime_websocket_enabled=false` using the authenticated existing Admin form. The previous data and SDK keys remain intact.
- Clients with new optional SDK fall back to HTTPS when WSS is unavailable; old SDKs always continue HTTPS. If local `keep_login_on_network_error` was previously signed ON, it may remain trusted until a fresh signed snapshot; authorization still fails closed when offline grace expires.
- Monitor signed HTTP validation, device-lease status and health; do not claim an instant logout for offline old clients. Reenable the feature only after the root cause is fixed and the owner explicitly approves.

## CI scope and file integrity
- Existing signed HTTP response payload and legacy SDK protocol are unchanged.
- Changes are additive to Docker Compose feature gate, signed realtime snapshot, new Python SDK policy enforcement, targeted tests/CI, docs and one existing Admin help text. No production DB schema/customer records, UI layout, DNS, VPS firewall or external domains are modified.
- CI uses disposable databases, temporary admin secrets and localhost TLS only.
