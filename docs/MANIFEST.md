# Documentation manifest and file inventory

> Generated for the source-verified LicenX documentation suite, 2026-11-18. All paths below are relative to docs/. This is a documentation file inventory, not a Git commit record.

## Documentation organization

| Audience | Entry point |
| --- | --- |
| Everyone | [Documentation home](index.md) |
| Administrators and license holders | [User guides](users/index.md) |
| Developers and operators | [Developer reference](dev/index.md) |
| Auditors and integrators | [Reference and audit evidence](reference/index.md) |

## Files and navigation

| File | Title |
| --- | --- |
| [dev/api-reference.md](dev/api-reference.md) | REST API reference â€” source-derived route inventory |
| [dev/architecture.md](dev/architecture.md) | LicenX system architecture |
| [dev/building-packaging.md](dev/building-packaging.md) | Build, packaging, deployment and release |
| [dev/codebase-structure.md](dev/codebase-structure.md) | Codebase structure and ownership |
| [dev/contributing.md](dev/contributing.md) | Contributing to LicenX |
| [dev/database-schema.md](dev/database-schema.md) | Database schema and persistence |
| [dev/index.md](dev/index.md) | Developer and operator reference |
| [dev/local-setup.md](dev/local-setup.md) | Local development setup |
| [dev/security.md](dev/security.md) | Security architecture and operational boundaries |
| [dev/testing.md](dev/testing.md) | Tests and verification |
| [index.md](index.md) | LicenX documentation |
| [reference/api-route-inventory.md](reference/api-route-inventory.md) | API route inventory â€” extracted from implementation |
| [reference/audit-coverage.md](reference/audit-coverage.md) | Forensic audit coverage and verification report |
| [reference/configuration-reference.md](reference/configuration-reference.md) | Configuration reference |
| [reference/dependencies.md](reference/dependencies.md) | Dependencies and external systems |
| [reference/documentation-reconciliation.md](reference/documentation-reconciliation.md) | Existing-documentation reconciliation |
| [reference/glossary.md](reference/glossary.md) | LicenX glossary |
| [reference/index.md](reference/index.md) | Technical reference and forensic evidence |
| [reference/known-limitations.md](reference/known-limitations.md) | Feature status, exclusions and verification limits |
| [reference/source-inventory.md](reference/source-inventory.md) | Forensic source inventory â€” generated from workspace files |
| [users/configuration.md](users/configuration.md) | Configuration and site management |
| [users/faq.md](users/faq.md) | Frequently asked questions |
| [users/features/admin-apis.md](users/features/admin-apis.md) | Admin APIs and restricted partner license checks |
| [users/features/admin-console.md](users/features/admin-console.md) | Administrator console and navigation |
| [users/features/backups.md](users/features/backups.md) | Encrypted full-system backup and restore |
| [users/features/devices-monitoring.md](users/features/devices-monitoring.md) | Device management, live monitor and audit trail |
| [users/features/diagnostics.md](users/features/diagnostics.md) | Diagnostics, audit logs and live validator |
| [users/features/index.md](users/features/index.md) | Feature guides â€” implemented LicenX capabilities |
| [users/features/licenses-applications.md](users/features/licenses-applications.md) | Applications and license key administration |
| [users/features/public-catalog.md](users/features/public-catalog.md) | Public navigation and tools catalog |
| [users/features/public-portal.md](users/features/public-portal.md) | Public license portal and self-service |
| [users/features/python-sdk.md](users/features/python-sdk.md) | Integrating a Python application with LicenX |
| [users/features/realtime.md](users/features/realtime.md) | Optional realtime license and admin updates |
| [users/getting-started.md](users/getting-started.md) | Getting started with LicenX |
| [users/index.md](users/index.md) | User and administrator guides |
| [users/installation.md](users/installation.md) | Installing LicenX on an Ubuntu VPS |
| [users/troubleshooting.md](users/troubleshooting.md) | Troubleshooting LicenX |
| [users/workflows.md](users/workflows.md) | Real user workflows |
| [MANIFEST.md](MANIFEST.md) | Documentation manifest and file inventory (this file) |

## Coverage and safety

- [Feature audit matrix](reference/audit-coverage.md): **26 source-backed feature groups** with paths and guide references.
- [Source inventory](reference/source-inventory.md): workspace source/config and external-document content inspection counts and exclusions.
- [API route inventory](reference/api-route-inventory.md): handler declarations from source; review actual auth policies before use.
- [Documentation reconciliation](reference/documentation-reconciliation.md): verified old-document conflicts, with out-of-scope files left intact.
- The suite does not contain production secrets or private notes/ material. No Git operation, build, runtime change or production deployment was performed by the documentation workflow.


## Final validation summary

- Source inventory: 250 non-generated eligible files, 241 text/config content reads, 208 code/config entries and 29 previously existing non-private document entries.
- API route index: 84 literal HTTP handler declarations plus dynamically registered and array routes documented separately.
- Feature coverage: 26 source-reachable product groups with guide and implementation references.
- Local navigation: 172 links checked, no broken relative paths in the pre-final pass. Source reference sampling: 51 unique paths checked, zero unresolved (one deliberately removed SDK path is documented as **absent**, not treated as an implementation dependency).
- **Not claimed:** complete branch coverage, executing setup/install commands, full live SDK activation, production backup restore, current optional WebSocket enablement, Cloudflare runtime parity, or fresh Git verification.