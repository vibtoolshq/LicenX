# Device management, live monitor and audit trail

LicenX associates client device fingerprints with licenses. The server tracks device status, first binding, last heartbeat, operating system/device name and IP details as available.

## Inspect devices

Use **HWID Locks** (`/vcon/devices`) to search devices, review the bound license and last heartbeat, and unbind a selected device. **License Keys → Manage Devices** opens a license-scoped device inspector with unbind and reset actions. Unbinding and resetting alter device status; they are not safe read-only probes.

## Monitor activity

**Live Monitor** (`/vcon/live-monitor`) loads per-app device snapshots via `/api/monitoring/devices` and optional session presence via `/api/realtime/presence`. Presence is meaningful only when its realtime subsystem is enabled; absence of presence does not necessarily prove a device lacks a valid signed HTTP lease.

**Audit Trail** (`/vcon/logs`) displays validation logs and recent sanitized SDK/server diagnostics. The admin can clear log records through `DELETE /api/logs` — an irreversible action unless recovered by a backup.

## Binding and lease semantics

Device binding is enforced within a database transaction by `bindDeviceWithinLimit`; existing devices can refresh, while a full limit rejects a new active binding. The app device lease must be longer than heartbeat interval plus offline grace plus the heartbeat request timeout. Default policy values: lease 7200 seconds, heartbeat 1200 seconds, grace 0; heartbeat must be 60–1200 seconds.

**Source:** `src/components/DevicesTab.tsx`, `ManageDevicesModal.tsx`, `LiveMonitorTab.tsx`, `LogsTab.tsx`, `src/server/api.ts:1495-1766`, `src/server/deviceBinding.ts`, `src/server/licensePolicy.ts`, `src/server/realtime/presence.ts`.