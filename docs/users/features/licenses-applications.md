# Applications and license key administration

## Register an application

Use **Applications →** new application action. Enter display name, app slug, optional description and minimum client version; set active status. Apps may be edited or disabled; changes affect acceptance of scoped licenses. Download the app integration configuration only through authenticated UI. Review the app's device lease, heartbeat and optional realtime policies before rollout.

**Source:** `src/components/AppsTab.tsx`, `CreateAppModal.tsx`, `EditAppModal.tsx`; server `src/server/api.ts:620-1018`; `src/server/licensePolicy.ts`.

## Issue a license

In **License Keys**, choose **Issue Key** or a bulk action. Select the target application and license tier, validity type/value, device limit and optional customer metadata. Successful issuance exposes a key and **four-digit security PIN**; save both through authorized channels. The PIN is used by the public user-control flow and must not be published.

For bulk issuance the UI supports quantity, prefix, validity and copying/exporting generated credentials. CSV export is implemented through the browser, but it is sensitive data: avoid committing it.

## Maintain licenses

Search/filter; inspect license devices; edit status or metadata; reset devices; and perform authorized bulk actions. Status can include active, suspended, revoked and expired. Deleting a license can cascade its devices via the database foreign key; treat deletion and reset as state-changing. Expiration can be recorded during status reads or validation.

**Validity is app/device-policy dependent.** A token/connection does not substitute for signed license validation; client version and lease/heartbeat checks still apply.

## Key APIs

`GET/POST /api/apps`, `PATCH/DELETE /api/apps/:id`, `GET/POST /api/licenses`, `POST /api/licenses/bulk`, `PATCH/DELETE /api/licenses/:id`, `POST /api/licenses/bulk-action`, `GET /api/licenses/:id/devices`.

**Source:** `src/components/CreateLicenseModal.tsx`, `BulkLicenseModal.tsx`, `LicensesTab.tsx`; `src/server/api.ts:1019-1535`; `src/server/deviceBinding.ts`; `src/server/database/postgresSchema.ts:50-113`.