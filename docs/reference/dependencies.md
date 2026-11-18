# Dependencies and external systems

The following versions and package names are read from `package.json` and the primary Python SDK `pyproject.toml`. A caret (`^`) is a declared semver range, not proof of the actual installed package version.

## Runtime stack

| Dependency | Declared version | Principal use |
| --- | --- | --- |
| `react`, `react-dom` | `^19.0.1` | Browser application |
| `vite` | `^8.3.0` | Frontend bundling/development |
| `express` | `^4.21.2` | Node REST/HTTP service |
| `@libsql/client` | `^0.18.0` | libSQL/SQLite adapter |
| `pg` | `^8.23.1` | PostgreSQL driver |
| `pg-copy-streams` | `^7.0.0` | Streaming DB export/restore |
| `ws` | `8.22.0` | Admin WebSocket gateway |
| `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner` | `3.1159.0` each | R2/S3-compatible storage |
| `archiver` | `^8.0.0` | SDK ZIP archive |
| `cors` | `^2.8.6` | Express middleware |
| `dotenv` | `^17.2.3` | Local environment loading |
| `lucide-react` | `^0.546.0` | UI icons |

The manifest also declares `motion ^12.23.24` and `@google/genai ^2.4.0`, but their active product usage was **not established by the targeted implementation trace**; do not advertise AI generation as an implemented LicenX feature based on that dependency.

## Build and developer tools

`typescript ^7.0.2`, `tsx ^4.21.0`, `esbuild 0.28.2`, `tailwindcss ^4.3.3`, `@tailwindcss/vite ^4.3.3`, `@vitejs/plugin-react ^6.1.1`, `autoprefixer ^10.4.21`, and relevant TypeScript type packages.

Manifest `name = react-example`, `version = 0.0.5` are internal project metadata; the product brand is **LicenX** and the Python SDK independently declares `licenx 1.2.6`. Do not infer product release versions from the root npm package version.

## Python SDK

`SDK/client/python/licenx/pyproject.toml`: `name=licenx`, `version=1.2.6`, `requires-python >=3.8`, required `cryptography >=41.0.0`. Extras: `requests>=2.28.0` and optional `websocket-client>=1.7,<2` for realtime; verify chosen client install path.

## Runtime services and deployment

- **PostgreSQL**: `postgres:17.6-bookworm` in Compose.
- **Node base**: inspect pinned Node 24 base in `Dockerfile` before updating.
- **Caddy**: `caddy:2.10.2-alpine`, optional standalone-https profile.
- **Cloudflare Pages Functions, R2, Turso/libSQL**: supported integration paths, not mandatory components in every VPS installation.
- **GitHub Actions**: test/build/release orchestration; presence of a job is not proof its latest run passed.

**Evidence:** `package.json`, `package-lock.json`, `SDK/client/python/licenx/pyproject.toml`, `Dockerfile`, `compose.yaml`, `src/server/r2.ts`.