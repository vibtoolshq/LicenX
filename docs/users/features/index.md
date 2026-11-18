# Feature guides — implemented LicenX capabilities

| Feature area | Guide | State |
| --- | --- | --- |
| Admin navigation, overview, profile | [Admin console](admin-console.md) | Implemented in browser UI |
| App registration, license creation, bulk actions | [Applications and license keys](licenses-applications.md) | Implemented |
| Device bindings, live monitor and logs | [Devices and monitoring](devices-monitoring.md) | Implemented; realtime gated |
| Public license status and PIN-controlled reset | [Public portal](public-portal.md) | Implemented; admin policy gates |
| Published navigation and tool cards | [Public catalog](public-catalog.md) | Implemented; empty catalog supported |
| Admin API credentials, restricted partner domain checks | [Admin and partner APIs](admin-apis.md) | Implemented with scope restrictions |
| Encrypted local/R2 backup/restore | [Backups](backups.md) | Implemented; restore must be tested separately |
| Server diagnostic probes, SDK diagnostic ingestion | [Diagnostics and validation](diagnostics.md) | Implemented; test tools can be stateful |
| Supported Python integration | [Python SDK](python-sdk.md) | Implemented; current 1.2.6 package |
| Optional realtime lease and admin updates | [Realtime](realtime.md) | Implemented source; runtime gates may be OFF |

**Meaning of “implemented”:** source contains a reachable handler/UI/service. It does **not** mean full live production lifecycle, payment checkout, backup restore or every optional deployment mode was acceptance-tested. See [Audit coverage](../../reference/audit-coverage.md).