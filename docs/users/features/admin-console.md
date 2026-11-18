# Administrator console and navigation

Access `/vcon` after first-owner setup, then sign in. `src/App.tsx` maps path-based tabs and loads authenticated page components; `src/components/Sidebar.tsx` defines group labels. Unauthorized users receive the login UI. The browser stores the last selected tab locally.

## Available pages

| Sidebar label | Path | Implemented purpose |
| --- | --- | --- |
| Overview | `/vcon` | System counters, recent activity and key-issuance shortcuts |
| Live Monitor | `/vcon/live-monitor` | Per-app device monitoring and optional realtime presence |
| Applications | `/vcon/apps` | List, search, enable/disable, edit and delete apps |
| License Keys | `/vcon/licenses` | Filter, issue, edit, bulk manage and export licenses |
| HWID Locks | `/vcon/devices` | Inspect active device bindings and unbind |
| Audit Trail | `/vcon/logs` | Validation logs and sanitized diagnostics |
| Live Validator | `/vcon/simulator` | Send a validation test with an app/version/device |
| Client SDK Hub | `/vcon/code` | Supported SDK integration and download |
| Server | `/vcon/server` | Server diagnostics / preflight |
| Admin APIs | `/vcon/admin-apis` | Scoped API credentials and restricted partner APIs |
| Admin Profile | `/vcon/profile` | Change credentials and account profile |
| Site Settings | `/vcon/site-settings` | Branding, SEO, support links and public policy |
| Backup | `/vcon/backup` | R2 accounts, backup jobs/schedule and restore |
| Storage & DB | `/vcon/settings` | Storage, DB and crypto configuration |
| Nav Menu | `/vcon/public-nav` | Publish ordered site navigation |
| Tools | `/vcon/public-tools` | Publish external tool cards |

**Sidebar group headings** such as “License Engine” or “Public” are not distinct routed pages. Some aliases appear in `src/App.tsx:70-114`, but the tab paths above are canonical.

## Sessions and account recovery

The administrator logs in with username/password via `/api/auth/login`, requests `/api/auth/me`, and logs out via `/api/auth/logout`. Profile credentials are changed through `/api/auth/update-credentials`; no public self-registration endpoint exists in the inspected server. Realtime admin updates need a separate runtime gate and must not replace login checks.

**Source:** `src/App.tsx:36-140,240-308,430-500`; `src/components/Sidebar.tsx:80-196`; `src/components/ProfileTab.tsx`; `src/server/api.ts:390-616`.