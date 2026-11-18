# REST API reference — source-derived route inventory

The Node server mounts `apiRouter` under **`/api`**; it also retains a compatibility `/v1` mount (see `server.ts:91-95`). Paths below are shown in canonical `/api` form. Routes marked **admin session** use `requireAdminAuth` (session cookie and CSRF on browser mutations); **scoped key** uses the permission-specific API key middleware. See `src/server/api.ts`, `src/server/backupControl.ts`, `server.ts`. Exact field constraints and every error response are defined by those handlers; this guide does **not** imply full OpenAPI schema coverage.

## Health and bootstrap

| Method | Endpoint | Access | Contract overview |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Liveness: `status: online` |
| GET | `/api/ready` | Public | DB/storage readiness: 200 ready; 503 not_ready |
| GET | `/api/setup/status` | Public | Whether initial admin exists and whether setup needs owner claim |
| POST | `/api/setup/init` | First-run | Owner-code verified on PostgreSQL; username/password; optional R2 |
| GET | `/api/auth/csrf` | Browser | CSRF bootstrap cookie |
| POST | `/api/auth/login` | Username/password | Admin session, subject to throttling |
| POST | `/api/auth/logout` | Browser session | Logout and invalidation |
| GET | `/api/auth/me` | Admin session | User and public key |
| POST | `/api/auth/update-credentials` | Admin session | Credential change; session rotation |

## Application, license and device administration

| Method | Endpoint | Access |
| --- | --- | --- |
| GET, POST | `/api/apps` | Admin session |
| PATCH, DELETE | `/api/apps/:id` | Admin session |
| POST | `/api/apps/bulk-action` | Admin session |
| GET | `/api/apps/:id/config` | Admin session |
| GET, POST | `/api/licenses` | Admin session |
| POST | `/api/licenses/bulk` | Admin session |
| PATCH, DELETE | `/api/licenses/:id` | Admin session |
| POST | `/api/licenses/bulk-action` | Admin session |
| GET, DELETE | `/api/licenses/:id/devices` | Admin session |
| GET, DELETE | `/api/devices` and `/api/devices/:id` respectively | Admin session |
| GET | `/api/stats`, `/api/logs` | Admin session |
| DELETE | `/api/logs` | Admin session |
| GET | `/api/realtime/presence`, `/api/monitoring/devices` | Admin session |

## SDK and public license service

| Method | Endpoint | Access / effect |
| --- | --- | --- |
| GET | `/api/v1/public-key` | Public verification key (no private key) |
| POST | `/api/v1/license/validate` | SDK/client; signed validation, may bind device |
| POST | `/api/v1/license/ping` | SDK/client; active heartbeat |
| POST | `/api/v1/license/logout` | SDK/client; device release |
| POST | `/api/v1/license/deactivate` | Compatibility alias for logout path |
| POST | `/api/v2/license/logout` | Newer logout request contract |
| POST | `/api/v1/user/license/check` | Public portal; can mark expired status |
| POST | `/api/v1/user/control/open` | Public key + PIN; device inspection |
| POST | `/api/v1/user/control/reset` | Public key + PIN; mutates bindings |
| POST | `/api/v1/public/license/check` | Approved backend only; read-only membership, quotas |
| GET | `/api/sdk/download/python` | Maintained Python SDK archive |

### Verified public self-service examples

The browser sends the license key as `license_key` for quick status; successful response includes `status`, `device_limit`, `active_device_count`. A control-open request adds `pin`; successful response includes `license` and `devices`. **Do not send real keys/PINs in untrusted demos**. Server evidence `src/server/api.ts:1768-2058`.

Restricted partner request is `POST /api/v1/public/license/check` with JSON `{"license_key":"TEST-KEY"}`, an active **private** `Authorization: Bearer` credential, and `X-Licenx-Tool-Origin` matching a registered HTTPS origin. Browser `Origin` is rejected. Treat this as a backend-only integration, never a public webpage example.

## Catalog and site settings

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/public/site-settings` | Public safe projection |
| GET | `/api/public/site-catalog` | Public enabled links/cards |
| GET, POST | `/api/settings/site` | Admin session; editable 17-field settings |
| GET, PUT | `/api/admin/public-catalog` | Admin session; versioned catalog updates |
| POST | `/api/settings/upload` | Admin session; branded asset upload |
| GET | `/api/public/assets/*`, `/api/storage/file/*` | Public safe file proxy |
| GET | `/api/storage/backups/:id` | Admin session; private legacy archive |

Catalog update requires `{version, section:"navigation"|"tools", items:[...]}`. Allowed safe URLs and concurrent conflict behavior are implemented in `src/server/publicCatalog.ts`.

## Admin APIs, configuration, diagnostics and backup

| Method | Endpoint family | Access |
| --- | --- | --- |
| GET, POST, DELETE | `/api/admin-api-keys`, `/api/admin-api-keys/:id` | Admin session |
| POST | `/api/v1/admin/licenses` | Scoped key `licenses:create` |
| GET | `/api/v1/admin/licenses/:key` | Scoped key `licenses:read` |
| POST | `/api/v1/admin/licenses/:key/reset` | Scoped reset permission |
| PATCH | `/api/v1/admin/licenses/:key/status` | Scoped status permission |
| GET, PUT | `/api/public-license-api-control` | Admin session |
| POST, PATCH, DELETE | `/api/public-license-api-control/domains[/:id]` | Admin session |
| GET | `/api/settings`, `/api/r2/backups` | Admin session |
| POST | `/api/settings/r2`, `/api/settings/r2/test`, `/api/settings/crypto/rotate` | Admin session |
| POST | `/api/admin/server-diagnostics/run` | Admin session |
| GET, POST | `/api/diagnostics`, `/api/diagnostics/admin` | Admin session |
| POST | `/api/v1/diagnostics/report` | Short-lived diagnostic capability |
| GET | `/api/backup/status`, `/api/backup/recovery-key` | Admin session |
| POST, PUT | `/api/backup/accounts[/:id]` | Admin session |
| POST | `/api/backup/accounts/:id/test`, `/api/backup/schedule`, `/api/backup/run` | Admin session |
| GET | `/api/backup/download/:id` | Admin session |
| POST | `/api/backup/recovery-key/import`, `/api/backup/restore/upload`, `/api/backup/restore/start`, `/api/backup/restore/r2` | Admin session |
| POST | `/api/v1/realtime/ticket`, `/api/admin/realtime/bootstrap` | Protected optional realtime workflows |

**Reference completeness:** Route families above reflect actual Node handlers and should be used with `src/services/apiClient.ts` for active browser callers. Cloudflare handling is separate, not assumed identical. Full method-by-method input JSON Schema, detailed status code matrix and SDK cryptographic signatures are **not independently generated here**; inspect code before client generation. [Security](security.md) · [Source inventory](../reference/source-inventory.md).