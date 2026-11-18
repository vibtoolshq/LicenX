# Local development setup

**Source of truth:** `package.json`, `server.ts`, `.env.example`, `vite.config.ts`, `SDK/client/python/licenx/pyproject.toml`. The following commands were checked against declared scripts, **not executed during this docs-only audit**.

## Node and browser UI

Use the Node version compatible with the repository and CI's pinned images (runtime Dockerfile uses a Node 24 base; check `Dockerfile` before matching it locally). From repository root:

```bash
npm ci
npm run dev
```

`npm run dev` executes `tsx server.ts`; the non-production Node app mounts Vite middleware and shared API routes. Configure only your own disposable database and private development secrets; inspect `.env.example` and [Configuration reference](../reference/configuration-reference.md).

## TypeScript checks and build

```bash
npm run lint
npm run build
npm start
```

`lint` calls `tsc --noEmit`. The build first generates the distributable Python SDK archive, then Vite assets and esbuild Node server/worker bundles. `npm start` runs the prebuilt `build/server.js`; it is not a substitute for setting required production DB/storage variables.

## Python SDK

```bash
python -m pip install ./SDK/client/python/licenx
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

Use a Python version supported by the installed SDK and its dependencies. Never run SDK live tests against customer licenses without consent: successful validation can bind a device.

## Avoid using real production data

Use ephemeral test databases/fixtures. PostgreSQL integration tests require a dedicated database with project-specific test naming; do not substitute production `DATABASE_URL`. No `.env`, real keys, legacy local DB file or `notes/` content belongs in version control.

[Testing](testing.md) · [Install VPS](../users/installation.md).