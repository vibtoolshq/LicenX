# Installing LicenX on an Ubuntu VPS

LicenX's supported self-hosted mode uses Docker Compose, PostgreSQL and Node/Express. A dedicated host may use the included Caddy HTTPS profile; a host with an existing proxy can use the existing-proxy installer mode. This guide reflects `scripts/install-vps.sh`, `compose.yaml`, `Dockerfile` and `README.md`; **the commands were source-reviewed, not executed on a new server during this documentation audit**.

## Prerequisites

Ubuntu host, Docker Engine and Docker Compose, correctly configured DNS, domain ownership, HTTPS access and enough storage for PostgreSQL/backup files. For standalone HTTPS, public ports 80/443 must be available.

## Review and preflight

```bash
git clone https://github.com/vibtoolshq/LicenX.git
cd LicenX

# If another proxy already controls 80/443:
bash scripts/install-vps.sh --check --mode existing-proxy --domain license.example.com --email admin@example.com

# Dedicated VPS with free 80/443:
bash scripts/install-vps.sh --check --mode standalone --domain license.example.com --email admin@example.com
```

Run **only the chosen mode** after inspecting its preflight output:

```bash
bash scripts/install-vps.sh --mode standalone --domain license.example.com --email admin@example.com
```

For an existing proxy use `--mode existing-proxy` instead. In that mode the installer uses a loopback HTTP listener (documented default `127.0.0.1:13001`) and does not configure your DNS/proxy/TLS.

## First administrator

The installer provisions a private `.env` and owner setup code file `.env.owner-setup` for first-owner setup. Keep both out of source control. Open `https://YOUR_DOMAIN/vcon`, enter the one-time code and set a new strong admin password. See [Getting started](getting-started.md).

## Post-install checks

```bash
docker compose ps
curl -fsS https://YOUR_DOMAIN/api/ready
```

A successful readiness response has `status: "ready"`. `/api/health` reports liveness and does **not** prove DB/storage readiness. A backup restore and real license login require separate controlled validation.

## Updating an existing installation

Check the currently deployed source, available disk, a **restorable** off-host backup and an identified rollback image **before** an approved update. Use safe fast-forward source synchronization and **app-only** Compose build/recreate; retain PostgreSQL/Caddy state, volumes, TLS state and private environment files. Never run `docker compose down -v` in production.

**Source:** `README.md:31-82`, `scripts/install-vps.sh`, `compose.yaml`, `server.ts:33-53`, `src/server/bootstrap.ts`. [Deployment architecture](../dev/building-packaging.md).