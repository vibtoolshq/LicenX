# Real user workflows

## Distribute licensed software

1. Administrator creates an **Application** (`/vcon/apps`) with its app slug and minimum supported version.
2. Issue a license from **License Keys** (`/vcon/licenses`) with app scope, tier, validity and device limit.
3. Deliver the license key and user-control PIN securely. The client application uses the trusted primary Python SDK configuration and performs signed login.
4. View bindings in **HWID Locks** or **Live Monitor**. Admin may edit license status or explicitly unbind a device. Do not test with real client keys accidentally.
5. License holder checks status or resets slots from the [Public portal](features/public-portal.md) when enabled.

## Publish an external tool

1. Set the **Buy License URL** in Site Settings if needed.
2. Configure ordered public links under **Nav Menu** and external tool cards under **Tools**.
3. Save and reload both lists. Verify links at `/` and enabled cards at `/tools`.
4. If no enabled tool cards exist, the gallery displays an empty state, not a publishing error.

## Recover server data

1. Verify off-host key and backup artifacts and retain separate host secrets.
2. Test R2 connectivity or choose a local destination; create a full backup.
3. Before restoration, use a disposable environment and obtain explicit approval; enter the required confirmation and current admin password.
4. Revalidate readiness, persisted state, license flow and asset URLs **after** restore.

## Investigate an issue

1. Verify `/api/health` versus `/api/ready`.
2. Check **Audit Trail** and **Server** diagnostic results.
3. Distinguish client version mismatch, an app/license status denial, invalid PIN/rate limit, and a disabled realtime transport.
4. Reproduce with disposable fixtures and focused tests; preserve production data.

**Evidence:** `src/App.tsx`, `src/components/*Tab.tsx`, `src/server/api.ts`, `src/server/backupControl.ts`.