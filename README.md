# LicenX

**Self-hosted software licensing, device authorization and Python application integration.**

LicenX provides a browser administration console, license and device lifecycle APIs, signed validation responses, PostgreSQL-backed VPS deployment and encrypted full-system backup/restore. The production deployment path is Docker Compose; a separate Cloudflare handler is retained for its supported runtime.

> **Python SDK:** The primary integration package is **[`licenx`](SDK/client/python/licenx/README.md)** at `SDK/client/python/licenx/`. The older [`x_license_python`](SDK/x_license_python/README.md) tree is **reference/compatibility only**. The currently served `x_license_python.zip` is a reference archive, **not** the `licenx` distribution.

## Start here

| Task | Documentation |
| --- | --- |
| Install LicenX on a VPS | [Installation](#vps-installation) |
| Configure the first administrator | [First login](#first-login-and-administration) |
| Integrate a Python application | [Primary Python SDK](#primary-python-sdk) |
| Review REST endpoints | [API surface](#api-surface) |
| Configure encrypted backups | [Backup and restore](#backup-and-restore) |
| Understand product behavior | [Project guide](project/README.md) |
| Contribute or report security issues | [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

## System architecture

- **Admin console:** `/vcon`; apps, licenses, devices, settings, branding, diagnostics, Admin APIs and backup control.
- **Server:** Node.js/Express on VPS; REST validation, scoped API keys, signed responses and device/heartbeat management.
- **Persistence:** PostgreSQL and private application storage on persistent Docker volumes. Do not delete named volumes during upgrades.
- **HTTPS:** existing reverse proxy (Coolify/Caddy/etc.) or the optional standalone Caddy service.
- **Cloudflare adapter:** separate Pages Functions-compatible handler; deployment behavior and data access differ from the VPS stack.
- **Python client:** installable `licenx` package (Python 3.8+) verifies signed responses, binds an app/device and manages heartbeats and logout.

## VPS installation

**Prerequisites:** Ubuntu host with Docker Engine and Docker Compose; a domain under your control; working DNS and HTTPS routing. For the standalone mode, ports 80/443 must be free. Review [`scripts/install-vps.sh`](scripts/install-vps.sh), [`compose.yaml`](compose.yaml) and [`deploy/env.vps.example`](deploy/env.vps.example) before production installation.

```bash
git clone https://github.com/vibtoolshq/LicenX.git
cd LicenX

# Existing HTTPS proxy / Coolify already owns ports 80 and 443:
bash scripts/install-vps.sh --check --mode existing-proxy --domain license.example.com --email admin@example.com
bash scripts/install-vps.sh --mode existing-proxy --domain license.example.com --email admin@example.com
```

The `existing-proxy` mode binds the new app on **`127.0.0.1:13001` over HTTP** (unless `--host-port` selects another available loopback port). Configure your *existing* reverse proxy to publish the domain over HTTPS; the installer **does not** modify Coolify, public DNS, firewall or existing proxy configuration.

For a dedicated VPS with free public 80/443 and correct DNS, use standalone HTTPS instead:

```bash
bash scripts/install-vps.sh --check --mode standalone --domain license.example.com --email admin@example.com
bash scripts/install-vps.sh --mode standalone --domain license.example.com --email admin@example.com
```

On the first installation, the script creates a private `.env` with generated PostgreSQL settings and an owner-claim code in `.env.owner-setup` (both mode 0600). **Do not share those files or the code.** Use the same mode/domain/email when rerunning the installer; it is designed to preserve existing configuration and volumes. New deployments use the generated values rather than copying any old secrets.

### First login and administration

1. Open `https://YOUR_DOMAIN/vcon` after the HTTPS proxy is configured.
2. On first visit, provide the one-time owner setup code stored in `.env.owner-setup` and choose your own administrator username/password. There is **no production default admin password** to rely on.
3. Create an application, review its app slug/version policy and obtain its trusted public verification key.
4. Create licenses and configure optional app-scoped external API keys in **Admin APIs**.

Check deployment health without printing credentials:

```bash
docker compose ps
curl -fsS https://YOUR_DOMAIN/api/ready
```

A successful readiness response contains `{"status":"ready"}`; `/api/health` is a separate liveness endpoint. A successful health check does not replace authorized end-to-end authentication and backup/restore verification.

### Safe updates

From the existing VPS checkout, after reviewing the target commit and confirming a clean working tree:

```bash
git pull --ff-only
docker compose build app
docker compose up -d --no-deps --wait --wait-timeout 120 app
```

Preserve the PostgreSQL and app-storage volumes, private `.env`, setup credentials, reverse-proxy TLS state and off-server backups. **Never run `docker compose down -v` on production.**

## Primary Python SDK

**Source:** [`SDK/client/python/licenx/`](SDK/client/python/licenx/README.md) · **Import:** `licenx` · **Package version:** 1.2.3 (as declared in the repository package manifest).

```bash
python -m pip install ./SDK/client/python/licenx
```

Create an app-root `licenx.config.py` with a literal `app_config` dictionary that includes the actual running `app_version`, licensed `app_name`, HTTPS `server_url` and a **trusted** `public_key_pem` obtained through the administrator. See the [configuration guide](SDK/client/python/docs/CONFIGURATION.md).

```python
from licenx import XLicenseClient

client = XLicenseClient()  # discovers your app-root licenx.config.py
result = client.login(input("License key: ").strip())
if not result.success:
    raise SystemExit(f"License denied: {result.message} ({result.code})")
try:
    print("License active:", client.get_tier())
    # Run licensed application features.
finally:
    client.logout()
```

The SDK does not persist license keys automatically. Login requires online validation; signed responses require `cryptography`. Its release workflow attaches `licenx` wheel/sdist assets to GitHub releases **but does not automatically publish to PyPI**. See the [English guide](SDK/client/python/docs/GUIDE_EN.md) or [বাংলা guide](SDK/client/python/docs/GUIDE_BN.md).

**Legacy/reference archive:** `/api/sdk/download/python` and `public/x_license_python.zip` are generated by `scripts/buildPythonSdkArchive.mjs` from `SDK/x_license_python`. They are not the recommended install path for new Python consumers.

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health`, `/api/ready` | Liveness and readiness |
| GET | `/api/setup/status` | First-run initialization status |
| POST | `/api/setup/init` | One-time owner-verified initialization |
| POST | `/api/v1/license/validate` | License validation, signed response and device binding |
| POST | `/api/v1/license/ping` | Session heartbeat |
| POST | `/api/v1/license/logout` | Release client device binding |
| GET/POST/DELETE | `/api/admin-api-keys` | Authenticated administrator key management |
| POST | `/api/v1/admin/licenses` | Scoped API-key license issuance |
| GET | `/api/v1/admin/licenses/:key` | Scoped license inspection |
| POST | `/api/v1/admin/licenses/:key/reset` | Scoped device reset |
| PATCH | `/api/v1/admin/licenses/:key/status` | Scoped license status update |

Admin routes require a session or a scope-authorized Bearer key; do not expose tokens in browser logs or code repositories. The source handlers remain authoritative for detailed field contracts.

## Backup and restore

The **Administration → Backup** feature on the Node/PostgreSQL VPS supports local backups and encrypted Cloudflare R2 archives. Full-system `.lxbackup` archives cover application database and app-managed public/private assets, not host `.env`, proxy certificates or arbitrary external secrets. Protect the separately supplied recovery key **offline**.

Create the first encrypted backup manually, verify its completion, and practice restore **only in an isolated environment** before relying on scheduled backups. Keep older backup formats and keys separately; this feature does not automatically import unrelated archives. Follow your defined retention/storage policy; avoid storing backups in public buckets.

## Development and verification

```bash
npm ci
npm run lint
npm test
npm run build
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

Tests must use disposable datasets. A successful isolated CI workflow does not itself prove a live production restore.

## Security and project policy

Keep admin credentials, license keys, signing keys, backup recovery keys and private storage outside Git. Use HTTPS, least-privilege API scopes and regular encrypted backups. Report vulnerabilities via [SECURITY.md](SECURITY.md). The project's non-negotiable development rules remain in [AGENTS.md](AGENTS.md) and [AI_INSTRUCTIONS.md](AI_INSTRUCTIONS.md).

**License:** [MIT](LICENSE).
