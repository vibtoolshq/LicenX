# Security architecture and operational boundaries

This document describes source-enforced controls; it is not a penetration-test certificate.

## Administrative authentication

`src/server/api.ts:170-246` defines `requireAdminAuth`. The setup endpoint `/api/setup/init` rejects unauthorized claims on PostgreSQL using a timed safe owner-code digest comparison (`src/server/bootstrap.ts`). Admin password hashes, sessions, CSRF cookies, rate limiting and credential rotation are handled by API/auth helpers. Mutations require an authenticated admin session and browser CSRF rules where applicable.

`src/server/adminAuthCookies.ts`, `crypto.ts`, `adminLoginRateLimit.ts` and `api.ts` are the reference files; never document a static/default production administrator password.

## License verification and device scope

The server signs validation responses using persisted signing keys. SDK consumers must bind the expected trusted verification key, server origin, application and actual client version. `src/server/deviceBinding.ts` enforces concurrent device limits transactionally; `licensePolicy.ts` enforces heartbeat/lease/grace bounds. App/license status, expiry and permission policies can deny access. Device reset and logout modify state.

## Scoped credentials and public endpoints

Admin API secrets are hashed in the DB and limited by permissions. The restricted external membership API requires an approved HTTPS origin and private non-app-scoped `licenses:check`-only credential; it denies browser Origin and enforces IP/global/credential quotas (`restrictedPublicLicenseCheck.ts`). Public status and PIN self-service are **separate** endpoints. The PIN service throttles failed attempts; no public caller may bypass an administrator-disabled operation.

## Realtime isolation

Admin WebSocket uses strict Origin, short-lived bootstrap proof, session checks, connection bounds, revocation and sanitized event payloads (`realtime/adminGateway.ts`). License SocketCore subscriptions are bound to ticketed device identity; runtime environment gates are separate. Leaving an optional transport OFF is a valid secure operating mode.

## Asset and backup trust boundaries

Public catalog validates URLs/text/icons, and avoids serving arbitrary HTML/SVG as tool icons. Private backup downloads and account manipulation require admin auth. Full backup archives use AES-GCM; the recovery key must be retained outside the host, preferably with a tested isolated restore. Restore is a high-impact operation and should never be exercised on live customer data during a docs/test task.

## Handling security failures

Keep error messages sanitized, avoid printing private request headers, redact license keys/PINs/user identifiers, and test only with authorized disposable fixtures. Report discovered implementation defects separately; **no security source changes were made by this documentation task**.

**Source:** `src/server/api.ts`, `src/server/bootstrap.ts`, `crypto.ts`, `adminApiInput.ts`, `publicCatalog.ts`, `restrictedPublicLicenseCheck.ts`, `src/server/realtime/`, `src/server/storage/`, `src/server/fullBackupWorker.ts`, `SECURITY.md`.