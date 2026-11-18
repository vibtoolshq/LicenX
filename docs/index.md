# LicenX documentation

> Source-verified documentation for the LicenX software licensing platform. Audience: product administrators, license holders, application developers, and VPS operators. Audit snapshot: 2026-11-18; current workstation source and declared manifests, **not** a substitute for fresh production checks.

LicenX is a browser-managed license, application, device and signing service with a Python client SDK. It provides public license self-service, restricted partner membership checks, admin controls, optional realtime transports, and encrypted backups.

## Choose your path

| I want to… | Read |
| --- | --- |
| Use a license key or recover a device slot | [Public license portal](users/features/public-portal.md) |
| Install the server or create the first admin | [Installation](users/installation.md) and [Getting started](users/getting-started.md) |
| Manage applications, licenses and devices | [Administration](users/features/admin-console.md), [Licenses](users/features/licenses-applications.md) |
| Publish navigation links and tools | [Public catalog](users/features/public-catalog.md) |
| Integrate a Python application | [Python SDK](users/features/python-sdk.md) |
| Manage APIs and domain approvals | [Admin and partner APIs](users/features/admin-apis.md) |
| Configure and restore backups | [Backups](users/features/backups.md) |
| Understand implementation | [Architecture](dev/architecture.md), [API reference](dev/api-reference.md), [Database](dev/database-schema.md) |
| Audit supported vs unverified behavior | [Audit coverage](reference/audit-coverage.md) |

## Documentation map

[User guides](users/index.md) · [Developer reference](dev/index.md) · [Technical reference](reference/index.md) · [Document manifest](MANIFEST.md)

**Evidence policy.** Each major feature links to implementation paths. Production states are qualified; for example the HF-01 Site Settings Save browser acceptance was reported by the owner, while a real production SDK activation or backup restore was not part of that acceptance. Do not paste live credentials into examples.

**Scope.** These files describe the inspected workspace. No application, schema, dependency, production deployment, Git history or configuration was changed to produce them.