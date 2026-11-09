# LicenX Admin Realtime — Release Gate and Rollback

**Source candidate:** `ADMIN-RT-01` five-phase upgrade on top of frozen source tag `baseline-2026-11-09-pre-admin-realtime`.
**Purpose:** auditable test/approval checklist; **not** permission to deploy or toggle runtime flags.
**Current release decision:** **NO-GO** until the live/staging criteria below have actual observed evidence and the owner grants separate approval. CI/source pass alone is NOT a production sign-off.

## Isolation and safety invariants
- Existing licensed Python SDK and signed HTTPS `/api/v1/*` license flows, ticket-authenticated `/api/realtime` WSS, and App/License/Device business semantics must remain backwards compatible.
- Browser Admin `/api/admin/realtime` is independent of SDK WSS and must require Admin HttpOnly session + one-use, short-lived Secure cookie, authenticated bootstrap POST with CSRF and same-origin enforcement. Never put JWT, CSRF, license key, HWID, IP or raw logs into URLs, socket messages or console.
- `LICENX_ADMIN_REALTIME_ENABLED` defaults `false`. It must remain OFF in production until separate release signoff. The existing SDK realtime gate is independent and must NOT be disabled for Admin fallback.
- On failure, browser Admin data must come from existing authenticated HTTPS; do not infer license authorization from an active WS connection. Distinguish **socket connected**, **bound active**, **stale lease**, **unknown report** and **signed license validity**.
- Client reconnect and stream gap/replay require authoritative HTTP snapshot; event messages only indicate invalidated resources. Same Node instance presence map is not a distributed/multinode count.
- Never change or remove existing named volumes, PostgreSQL records, private backups, production secrets, HTTPS certificates, current Caddy routing, public ports, or license-device binding data to test this feature.

## Gate A — versioned source & focused automated verification
| Required criterion | Evidence to record | Release-blocking when failed |
| --- | --- | --- |
| Reviewed commit, clean tree, immutable pre-change tag | Exact full SHA and `git status` | Yes |
| TypeScript and production UI + server bundles | `npm run lint`, `npm run build` result | Yes |
| Bootstrap auth, CSRF/Origin, replay, logout/expiry and two simultaneous Admin sessions | `tests/adminRealtimeAuth.test.ts` observed result | Yes |
| Scoped App change notifications, 50-event coalescing, bounded journal/log polling, sanitized payload | `tests/adminRealtimeEvents.test.ts` result | Yes |
| Shared browser client, reconnect, gap/replay/resync, visibility, offline fallback and no stale auth | `tests/adminRealtimeClient.test.ts` result | Yes |
| Six existing React components event subscription, unmount cleanup and layout controls | Source contract test + browser visual regression evidence | Yes |
| Real authenticated GET `/api/devices` with >100 in-memory fixture, page offset & total, per-visible WS report | `tests/realtimeAdmin.test.ts` result + staging browser | Yes |
| SDK license ticket, signed policy/event delivery, old client HTTP fallback, Python SDK regressions | `tests/realtimeIntegration.test.ts`; existing Python test suites | Yes |
| Ubuntu Docker/Compose disposable production build; HTTPS/health/backup route and existing installer regression | Existing Phase-05 CI job outcome on same SHA | Yes |

**Evidence labels must remain separate:** `SOURCE_PRESENT`, `LOCAL_TEST_PASS`, `CI_TEST_PASS`, `STAGING_LIVE_PASS`, `PRODUCTION_LIVE_PASS`, `NOT_RUN` / `BLOCKED`. A test inside Node mocks does not prove a real browser/cookie policy. A 128-device in-memory DB fixture does not prove a production load capacity. Do not publish an unsupported peak-concurrency number.

## Gate B — actual staging or explicitly authorized low-risk deployment (NOT included in Phase-05 source task)
1. Operator captures off-host verified PostgreSQL backup, app storage/uploads, TLS/proxy configuration, `.env` without leaking secrets; retains known-good tagged image and rollback instructions. Baseline Git tag alone does not restore a DB.
2. Operator verifies domain HTTPS TLS/Host/Origin, Caddy WebSocket Upgrade and strict same-origin Secure cookie behavior through a **real browser** with valid session, without exposing credential values.
3. Verify 401/403 invalid session/CSRF/Origin/replay, Admin logout/credential rotation and rapid reconnection on a real non-customer/staging setup; ensure no infinite rebootstrap after revoked authorization.
4. Test two Admin sessions and two separately scoped Apps, license changes, forced unbind, validation log/Overview refresh and per-App isolation; no cross-customer private values over WSS.
5. Seed or provision >100 **test** devices in staging only; check page >=6 at page size 20, server total, filter/page navigation, exact visible IDs and updated `last_ping_at`. Never seed customer data.
6. Test gate OFF, WSS proxy down, network offline/online, background-tab wake and missed-event cursor; user-visible `HTTP_FALLBACK`/`STALE`/`AUTH_EXPIRED` is truthful. Keep signed SDK validation working.
7. Record actual concurrent Admin sessions, event bursts, latency percentiles, frontend CPU/memory, server RSS/FD/CPU, DB QPS and log freshness on a controlled host. If only source tests were run, record `NOT_MEASURED`.
8. Record full CI job result, real-browser regression on existing UI controls, a specific rollback rehearsal, owner/date and go/no-go decision. No automatic production pull.

## Status fields (fill from observed proof at review time)
```text
Release candidate Git SHA: NOT_RECORDED_YET
Automated Node build/test: NOT_RECORDED_YET
Python SDK regression: NOT_RECORDED_YET
CI complete conclusion: NOT_RECORDED_YET
Real-browser HTTPS + Caddy WSS: NOT_RUN
Admin Origin/CSRF/session replay live: NOT_RUN
Two Admin sessions live: NOT_RUN
More than 100 test devices in real browser: NOT_RUN
Actual burst latency/p95 and capacity: NOT_MEASURED
Off-host backup and app-only rollback verified: NOT_VERIFIED_FOR_THIS_RELEASE
Approved deployment operator/signature/date: NOT_PROVIDED
Release decision: NO-GO
```

## Reversible rollout only after separate approval
- Start with the Admin WSS feature gate OFF, preserve the existing SDK license realtime feature independently and validate `/api/health`, `/api/ready` and signed license HTTP/SDK WSS clients.
- After recorded backup and explicit approval, operator can enable Admin gate separately and restart/recreate **only** the app service if the release plan requires it. Do not create a new public WSS/DB port.
- On any auth/session leak, wrong device scope, excessive resource consumption, stale data presented as live or license regression, turn only `LICENX_ADMIN_REALTIME_ENABLED=false` and restore the previous app image/commit if necessary. Do NOT run `docker compose down -v` or delete persistent volumes.
- Document the precise deployed SHA, image digest, backup location, post-change health/DB counts, customer-safe regression, operator approval and final decision in private operational notes.

## Ownership and limitations
- These are release **requirements** rather than observations. Use the private phase receipt and CI run results for actual test evidence.
- This document contains no credentials, tokens, internal database contents, customer identifiers or production IP addresses.
- A process-local realtime presence registry cannot be described as globally aggregated in a multi-node deployment; distributed presence requires separate owner-approved architecture.
