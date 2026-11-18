# Forensic audit coverage and verification report

**Product:** LicenX — browser licensing admin, self-service, Node/PostgreSQL server and maintained Python `licenx` SDK. **Audit method:** read-only workspace inventory and source-content scan, detailed targeted handler/UI/schema tracing, documentation generation, relative-link/path checks. **No Git commands, application source edits, production changes, installer execution or destructive operations were used.**

## Coverage matrix

The table defines **26 implemented feature groups** for audit reporting. “Implemented” refers to source-reachable UI/handler/service; optional runtime gates and live acceptance are listed separately.

| # | Feature group | Implementation evidence | Documentation |
| ---: | --- | --- | --- |
| 1 | First-owner initialization | `src/components/SetupModal.tsx`; `src/server/bootstrap.ts` | [Getting started](../users/getting-started.md) |
| 2 | Admin session/profile/CSRF | `api.ts:170-616`; `ProfileTab.tsx` | [Admin console](../users/features/admin-console.md), [Security](../dev/security.md) |
| 3 | Overview statistics | `OverviewTab.tsx`; `api.ts:2816-2855` | [Admin console](../users/features/admin-console.md) |
| 4 | Applications CRUD & policy | `AppsTab.tsx`; `api.ts:620-1018` | [Applications](../users/features/licenses-applications.md) |
| 5 | License issuance/edit/status | `LicensesTab.tsx`; `api.ts:1019-1494` | [Licenses](../users/features/licenses-applications.md) |
| 6 | Bulk issuance/actions/export | `BulkLicenseModal.tsx`; `LicensesTab.tsx` | [Licenses](../users/features/licenses-applications.md) |
| 7 | HWID binding/unbinding | `DevicesTab.tsx`; `deviceBinding.ts` | [Devices](../users/features/devices-monitoring.md) |
| 8 | Live device monitor | `LiveMonitorTab.tsx`; `api.ts:1536-1725` | [Monitoring](../users/features/devices-monitoring.md) |
| 9 | Audit log history | `LogsTab.tsx`; `api.ts:2856-2921` | [Monitoring](../users/features/devices-monitoring.md) |
| 10 | Live Validator test tool | `SimulatorTab.tsx`; `api.ts:2091-2550` | [Diagnostics](../users/features/diagnostics.md) |
| 11 | SDK Hub/download | `ClientCodeTab.tsx`; `api.ts:2793-2815` | [Python SDK](../users/features/python-sdk.md) |
| 12 | Admin scoped API credentials | `AdminApisTab.tsx`; `api.ts:3380-3918` | [Admin APIs](../users/features/admin-apis.md) |
| 13 | Partner restricted global check | `restrictedPublicLicenseCheck.ts`; `publicLicenseApiControl.ts` | [Admin APIs](../users/features/admin-apis.md) |
| 14 | Branding & Site Settings | `SiteSettingsTab.tsx`; `publicCatalog.ts` | [Configuration](../users/configuration.md) |
| 15 | Published navigation | `PublicNavMenuTab.tsx`; `PublicHeader.tsx` | [Public catalog](../users/features/public-catalog.md) |
| 16 | Published external tools | `PublicToolsTab.tsx`; `PublicToolsPage.tsx` | [Public catalog](../users/features/public-catalog.md) |
| 17 | Storage/R2 controls | `SettingsTab.tsx`; `src/server/storage/` | [Configuration](../users/configuration.md) |
| 18 | Local encrypted backups | `BackupTab.tsx`; `backupControl.ts` | [Backups](../users/features/backups.md) |
| 19 | R2 backup accounts/restore | `backupControl.ts`; `fullBackupWorker.ts` | [Backups](../users/features/backups.md) |
| 20 | Server diagnostics | `ServerDiagnosticsTab.tsx`; `serverDiagnostics.ts` | [Diagnostics](../users/features/diagnostics.md) |
| 21 | Public license quick check | `LandingPage.tsx`; `api.ts:1768-1822` | [Public portal](../users/features/public-portal.md) |
| 22 | Public PIN control/reset | `LandingPage.tsx`; `api.ts:1823-2060` | [Public portal](../users/features/public-portal.md) |
| 23 | Signed validate/ping/logout | `api.ts:2091-2792`; `licensePolicy.ts` | [API](../dev/api-reference.md) |
| 24 | Optional SocketCore license WSS | `server.ts`; `engine/socketcore/` | [Realtime](../users/features/realtime.md) |
| 25 | Optional authenticated admin WSS | `realtime/adminGateway.ts`; `adminEventBridge.ts` | [Realtime](../users/features/realtime.md) |
| 26 | Primary Python client SDK | `SDK/client/python/licenx/client.py`; `config.py` | [Python SDK](../users/features/python-sdk.md) |

## Distinction by status

- **Implemented in current source:** all 26 groups above have reachable modules/handlers. Their exact operating conditions vary; no universal production PASS is implied.
- **Gated / partially operational without configuration:** Node/PostgreSQL backup needs local storage and recoverable key; R2 requires external credentials; optional realtime needs server and app policy flags; restricted partner API needs enabled global policy and approved domain.
- **Not a verified built-in product feature:** payment checkout, auto-sync of cross-IDE chat histories, unattended live license activation test.
- **Historic/deprecated path:** `SDK/x_license_python/` is not part of the currently inspected source tree; legacy docs are retained as history outside `docs/`.
- **Not inspected deeply:** individual branches in every historical SDK test, all exhaustive Cloudflare compatibility cases, output from a fresh VPS installation, live production backup restore. Do not claim 100% branch coverage.

## Verification method and limits

- Machine-read and enumerated source, manifests and external docs. Exact totals come from [Source inventory](source-inventory.md) and the final QA summary.
- Manually traced admin navigation, setup, core license lifecycle, public endpoints, catalog projection, policy/device binding, PostgreSQL migration and adapter, SDK client/config, backup worker/routes, realtime gateway, installer and Compose.
- Site Settings HF-01 owner acceptance (last recorded) and older CI evidence are **historical supplied evidence**; this documentation pass did not repeat them.
- Final docs QA covers path/link existence, file inventory, duplicate headings, Markdown fences and traceable source references; any unverified examples remain labeled.

## Exclusions / future evidence

Full API request/response schema generation (OpenAPI), all UI conditional branches, live Cloudflare parity, production restore, current production realtime flags, full test-suite runtime output, performance SLA and operator-specific DNS/TLS state are outside this documentation-only audit.

[Reconciliation](documentation-reconciliation.md) · [Known limitations](known-limitations.md) · [Documentation manifest](../MANIFEST.md).
## Final documentation QA receipt — 2026-11-18

| Measurement | Observed result |
| --- | --- |
| Eligible non-generated workspace files inventoried (excluding the new docs/) | **250** |
| Text/config file contents read by automated inventory | **241** |
| Code/config text entries inventoried | **208** |
| Existing non-private documents read in inventory | **29** |
| Additional text metadata files read | **4** |
| Non-text/binary entries excluded from content scan | **9** |
| Deeply traced feature groups | **26** |
| Literal HTTP handler declarations indexed | **84** plus dynamic/array routes described |
| Documentation Markdown files generated | **39** |
| Relative Markdown links validated | **172** at pre-final link QA |
| Unique cited source paths checked | **51**; missing **0** |
| Markdown heading/fence validation | **39/39 H1 present**; **24 balanced fence markers** at pre-final QA |
| Existing doc conflicts recorded | **7** in [Reconciliation](documentation-reconciliation.md) |
| Application/runtime/production test execution | **Not performed** (docs-only scope) |
| Git/branch/commit state in this task | **Not re-queried** — all Git operations prohibited |

The 241 text-content reads were machine-level inventory work; the deeper targeted manual trace covered entry points, UI tabs, backend routes, key policy handlers, schema migrations, realtime, backup and Python SDK. The distinction matters: **241 scanned files does not equal 241 individually branch-reviewed modules**, and the 26 groups are a feature taxonomy rather than complete test coverage of all paths.

All writes were confined to the new `docs/` tree. No existing external docs, source/config files or production resources were modified. Local commands were **static validation only**, so installation examples have not been demonstrated on a new VPS in this audit.

**Release/acceptance status of this documentation:** documentation navigation and traceability PASS; runtime execution and deployment acceptance are **not claimed**.