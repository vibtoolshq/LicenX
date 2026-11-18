# Developer and operator reference

LicenX's implementation is a React browser UI, shared TypeScript server logic, an Express/Node VPS runtime, a separate Cloudflare adapter, and one maintained Python SDK. Use the source evidence links when modifying it.

| Topic | Document |
| --- | --- |
| Runtime topology, data and auth flows | [Architecture](architecture.md) |
| Source directory and code ownership | [Codebase structure](codebase-structure.md) |
| Local development | [Local setup](local-setup.md) |
| REST route families and contracts | [API reference](api-reference.md) |
| PostgreSQL tables and migrations | [Database schema](database-schema.md) |
| Authentication, keys and trust boundaries | [Security](security.md) |
| Docker, package and release pipeline | [Build/packaging/deployment](building-packaging.md) |
| Tests, fixtures and CI | [Testing](testing.md) |
| Contribution and docs maintenance | [Contributing](contributing.md) |

For exact runtime switches and environment variable names see [Configuration reference](../reference/configuration-reference.md). For the current audit coverage and non-verified areas see [Coverage](../reference/audit-coverage.md).