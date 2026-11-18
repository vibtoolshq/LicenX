# Admin APIs and restricted partner license checks

## Create and revoke credentials

Open **Administration → Admin APIs** (`/vcon/admin-apis`). The UI provides API key management, endpoint documentation, sandbox tests and a **Public API** domain section. Create named API keys with the allowed permission scopes and optional application restriction; store a newly revealed secret immediately and securely. Revocation deletes the saved key record and prevents further use.

Authenticated admin key administration: `GET/POST /api/admin-api-keys`, `DELETE /api/admin-api-keys/:id`. Scoped backend endpoints include `POST /api/v1/admin/licenses`, `GET /api/v1/admin/licenses/:key`, `POST /api/v1/admin/licenses/:key/reset`, and `PATCH /api/v1/admin/licenses/:key/status`.

## Restricted public license membership API

This is **not** the browser quick-check service. It is a server-to-server, read-only license-membership query for an approved external tools backend: `POST /api/v1/public/license/check`. A registered HTTPS tool origin, private Bearer credential, exactly `licenses:check` permission, global-enabled switch and strict quotas are required. The request must not contain a browser `Origin` header; its declared tool origin is checked against the registered allowed domain.

The endpoint does not activate, renew, reset, bind or unbind a license. Application lookup uses the license's associated app; an app-scoped key cannot be used for the global membership check. Administrators may disable the global API or revoke approved domains.

**Security:** Never embed the Bearer key in JavaScript delivered to visitors or put secrets in screenshots/tickets. The API fails closed for missing permissions, disallowed origins and disabled service; see [API reference](../../dev/api-reference.md) and [Security](../../dev/security.md).

**Source:** `src/components/AdminApisTab.tsx`, `PublicLicenseApiTab.tsx`, `src/server/api.ts:3463-3918`, `src/server/restrictedPublicLicenseCheck.ts:116-195`, `src/server/publicLicenseApiControl.ts`.