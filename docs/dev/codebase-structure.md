# Codebase structure and ownership

## Repository map

| Path | Primary responsibility |
| --- | --- |
| `src/App.tsx`, `src/main.tsx`, `src/index.css` | Browser entry, public/admin route selection, global styles |
| `src/components/` | Admin/public pages, modals, tables, site/header presentation |
| `src/context/` | React confirmation/context logic |
| `src/services/apiClient.ts` | Browser API transport, auth/session/error/cache, admin realtime hooks |
| `src/types.ts` | Shared UI data interfaces and site-settings shape |
| `server.ts` | Node Express bootstrap, readiness, HTTP/WS gateway lifetime |
| `src/server/api.ts` | REST route handlers, validation, admin/license operations |
| `src/server/db.ts`, `database/` | libSQL vs Postgres selection, schema, SQL adapters and transactions |
| `src/server/deviceBinding.ts`, `licensePolicy.ts` | Device limits, lease and heartbeat policy |
| `src/server/realtime/` | Ticket validation, device lease, event journal, admin WSS |
| `src/server/storage/`, `r2.ts` | Public branding, private files and R2 access |
| `src/server/publicCatalog.ts` | Safe public nav/tool validation, concurrency-protected updates |
| `src/server/backupControl.ts`, `fullBackupWorker.ts` | Backup API, key/account/job/schedule and isolated archive worker |
| `src/server/diagnostics.ts`, `serverDiagnostics.ts` | Safe diagnostic event ingestion and privileged server probes |
| `functions/`, `wrangler.toml` | Cloudflare Pages adapter and bindings |
| `SDK/client/python/licenx/` | Primary pip-installable Python SDK 1.2.6 and tests |
| `SDK/client/python/docs/` | SDK developer usage and configuration |
| `engine/socketcore/` | Optional SocketCore transport |
| `tests/`, `tests/e2e/` | Node API/security/contract tests and browser/CI scenarios |
| `scripts/` | VPS installer, archive generator, recovery helpers |
| `deploy/` | Caddy, Compose overlay and release-gate context |
| `.github/workflows/` | CI and versioned SDK release workflows |
| `docs/` | This generated documentation suite |
| `notes/` | **Ignored and private** local plans, tests and forensic receipts |

## UI component mapping

`Sidebar.tsx` contains all 16 routed tab definitions; `App.tsx` selects corresponding `OverviewTab`, `LiveMonitorTab`, `AppsTab`, `LicensesTab`, `DevicesTab`, `LogsTab`, `SimulatorTab`, `ClientCodeTab`, `ProfileTab`, `AdminApisTab`, `SiteSettingsTab`, `BackupTab`, `ServerDiagnosticsTab`, `PublicNavMenuTab`, `PublicToolsTab` and `SettingsTab`.

Other UI source includes `CreateAppModal`, `EditAppModal`, `CreateLicenseModal`, `BulkLicenseModal`, `ManageDevicesModal`, `LoginModal`, `SetupModal`, `ErrorBoundary`, `LandingPage`, `PublicHeader`, `PublicToolsPage` and table pagination. These are components, not extra top-level product routes.

## Boundaries to preserve

Do not merge Cloudflare and Node behavior without tests. Preserve schema/migrations, signed SDK response contracts, scoped API keys, private backing volumes, and published catalog fields. Do not treat ignored `notes/` or local `vcon_data.db` as shareable project docs.

[Architecture](architecture.md) · [Source inventory](../reference/source-inventory.md).