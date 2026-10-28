<div align="center">

# 🛡️ LicenX

### Enterprise Software Licensing & Cryptographic Hardware Authorization Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B%20%7C%2020%2B-green.svg)](https://nodejs.org/)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages%20%26%20Workers-f38020.svg)](https://pages.cloudflare.com/)
[![Database](https://img.shields.io/badge/Database-Turso%20%7C%20libSQL%20%7C%20SQLite-4433ff.svg)](https://turso.tech/)
[![Security](https://img.shields.io/badge/Crypto-RSA--2048%20%26%20Ed25519-indigo.svg)](https://github.com/)
[![Python SDK](https://img.shields.io/badge/Client%20SDK-Python%203.8%2B-yellow.svg)](./SDK/x_license_python/)

<p align="center">
  A high-security, distributed software licensing server and hardware fingerprint authorization engine. Built for native execution on <b>Node.js / Docker</b> and <b>Cloudflare Pages Functions (Edge Workers)</b> with instant zero-cold-start verification, automated hardware locking (HWID), anti-tampering guards, and self-service customer device reset.
</p>

[Key Features](#-key-features) • [Architecture](#-architecture) • [Quick Start](#-quick-start) • [Cloudflare Deployment](#-cloudflare-pages-deployment) • [Python SDK](#-python-client-sdk) • [API Reference](#-api-endpoints) • [License](#-license)

</div>

---

## 🚀 Key Features

### 🔐 Cryptographic Integrity & Anti-Piracy

- **RSA-2048 / Ed25519 Asymmetric Signatures:** Every license payload is digitally signed by the server's private key. Client apps verify authenticity using standard public key cryptography without sending secrets.
- **Hardware Lock (HWID Fingerprinting):** Unique client device fingerprinting (CPU, motherboard, OS, disk UUID, and MAC address hashing) to strictly enforce machine limits per license.
- **Clock Tampering & Replay Protection:** Timestamp-drift detection, monotonic clock checks, and anti-replay nonce tracking.
- **Heartbeat & Session Tracking:** Background daemon ping worker maintaining active session state with automatic stale lease reclamation.

### ⚡ Dual-Runtime Architecture

- **Node.js / Express Server:** Run locally, on VPS, AWS, GCP, Render, or Docker with standard Node 18+.
- **Cloudflare Pages & Functions (Edge):** 100% serverless edge deployment with global low-latency responses, zero server maintenance, and automatic scaling.
- **Turso / libSQL / SQLite Support:** Distributed edge SQLite database with zero connection pooling bottlenecks.
- **Cloudflare R2 Bucket Storage:** Native cloud object storage for automatic bulk CSV license backups and custom brand assets (Logo, Favicon, OG share cards).

### 🎛️ Unified Admin Panel & Live Tools

- **Applications Hub:** Manage multi-tenant applications with custom slugs, version enforcement, and auto-generated client configs.
- **License Engine:** Issue single or bulk licenses (up to 2,000 keys per batch in a single atomic database transaction) with custom prefixes, validity tiers, device limits, and 4-digit PINs.
- **HWID Tracker & Device Inspector:** Live list of bound client hardware with one-click hardware detachment and force logout.
- **Real-Time Audit Trail:** Comprehensive logs recording IP addresses, HWID fingerprints, status codes, and request durations.
- **Cryptographic Simulator:** Interactive in-browser validator to test RSA signatures and test payload responses.
- **Site Settings & Branding Control:** Full white-label customization of App Logo, Favicon, OG Image, SEO tags, support links (Telegram, Discord, Email), announcement banners, and public portal rules.

### 🌐 Self-Service Customer License Portal

- **3-Metric Quick Check:** Safe public validation (status, device limit, and active bound count) without exposing private data.
- **Self-Service HWID Reset:** Customers can securely reset their hardware bindings anytime using their private 4-digit PIN without needing admin intervention.

---

## 🏛️ Architecture

```
                    ┌─────────────────────────┐
                    │      Client Apps        │
                    │   (Python, C#, Electron)│
                    └───────────┬─────────────┘
                                │ HTTPS Requests
                                ▼
         ┌──────────────────────────────────────────────┐
         │              LicenX Gateway                  │
         │  (Node.js Server or Cloudflare Edge Worker)  │
         └───────┬──────────────────────────────┬───────┘
                 │                              │
         ┌───────▼──────────────┐       ┌───────▼──────────────┐
         │     Turso / libSQL   │       │    Cloudflare R2     │
         │    Distributed SQLite│       │  Backup & Asset Store│
         └──────────────────────┘       └──────────────────────┘
```

---

## 📦 Quick Start

### 1. Prerequisites

- **Node.js 18+** or **20+**
- **npm** or **pnpm**
- _(Optional)_ A free [Turso](https://turso.tech/) database and [Cloudflare R2](https://www.cloudflare.com/developer-platform/r2/) bucket for cloud persistence.

### 2. Clone & Install

```bash
git clone https://github.com/your-username/LicenX.git
cd LicenX
npm install
```

### 3. Environment Setup

Create your `.env` file:

```bash
cp .env.example .env
```

Configure your environment variables:

```env
# Server Port
PORT=3000

# Turso / libSQL Cloud Database (Optional for local SQLite file fallback)
TURSO_DATABASE_URL="libsql://your-db-org.turso.io"
TURSO_AUTH_TOKEN="your-turso-auth-token"

# Cloudflare R2 Object Storage (Optional for backups & image uploads)
R2_ACCOUNT_ID="your-cloudflare-account-id"
R2_ACCESS_KEY_ID="your-r2-access-key-id"
R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"
R2_BUCKET_NAME="licenx-storage"
R2_PUBLIC_URL="https://assets.yourdomain.com"
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to access the Setup Wizard and initialize your administrator account.

### 5. Production Build

```bash
npm run build
npm start
```

---

## ⛅ Cloudflare Pages Deployment

LicenX includes first-class support for **Cloudflare Pages with Pages Functions**:

1. **Connect Repository:** Link your GitHub repository to Cloudflare Pages.
2. **Build Settings:**
   - **Framework preset:** `Vite`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
3. **Compatibility Flags:**
   - Ensure `nodejs_compat` is enabled under **Settings > Functions > Compatibility Flags**.
   - Compatibility Date: `2024-09-23` or newer.
4. **Environment Variables:**
   - Add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
   - Add R2 credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`).

---

## 🐍 Python Client SDK

LicenX provides a Python client SDK at [`SDK/x_license_python/`](./SDK/x_license_python/). Signed license-response verification requires `cryptography`; HTTP transport optionally uses `requests` and falls back to Python's standard-library `urllib`.

### Installation

Download `x_license_python.zip` directly from the Admin Panel or copy the `SDK/x_license_python/` folder into your project.

### Basic Integration

```python
from x_license_python import XLicenseClient, SDKConfig

# Download this app config from the Admin Panel and provision it through a trusted channel.
# It must contain the server's independently trusted public_key_pem.
config = SDKConfig.from_file("my_app_vcon_config.json")
# Set this to the release version of the application being run.
config.app_version = "2.4.1"

client = XLicenseClient(config)

# Authenticate with a license key.
result = client.login(license_key="LICX-ABCD-1234-EF56")

if result.success:
    print(f"License Activated! Tier: {client.get_tier()}")
    print(f"Hardware ID: {result.hwid}")
else:
    print(f"Activation Failed ({result.code}): {result.message}")
```

### Manual Heartbeat & Logout

```python
# Check health on-demand
status = client.ping()
print("Session active:", status.get("valid"))

# Release device slot on application exit
client.logout()
```

---

## 🔌 API Endpoints

### Public & Client Verification

| Method | Endpoint               | Description                                                       |
| :----- | :--------------------- | :---------------------------------------------------------------- |
| `POST` | `/v1/license/validate` | Authenticate license, register HWID, and receive RSA-signed token |
| `POST` | `/v1/license/ping`     | Heartbeat keep-alive verifying hardware binding                   |
| `POST` | `/v1/license/logout`   | Release hardware lock slot upon app termination                   |
| `GET`  | `/v1/public-key`       | Retrieve server RSA-2048 public PEM key                           |
| `GET`  | `/health`              | Server uptime and health probe                                    |

### Self-Service Customer Portal

| Method | Endpoint                 | Description                                                  |
| :----- | :----------------------- | :----------------------------------------------------------- |
| `POST` | `/v1/user/license/check` | Public quick status check (status, limit, active count only) |
| `POST` | `/v1/user/control/open`  | Open device manager with 4-digit PIN authentication          |
| `POST` | `/v1/user/control/reset` | Clear all bound hardware slots for license key               |

### Admin Management _(Bearer Auth Required)_

| Method     | Endpoint                      | Description                                                      |
| :--------- | :---------------------------- | :--------------------------------------------------------------- |
| `GET`      | `/api/stats`                  | System overview telemetry and 24h request counters               |
| `GET/POST` | `/api/apps`                   | List and register tenant applications                            |
| `GET/POST` | `/api/licenses`               | Filter licenses and generate single/bulk keys                    |
| `POST`     | `/api/licenses/bulk`          | High-performance single-batch key issuance (up to 2,000 keys)    |
| `POST`     | `/api/licenses/bulk-action`   | Bulk suspend, activate, revoke, reset, extend, or delete         |
| `POST`     | `/api/settings/upload`        | Upload branding assets (Logo, Favicon, OG card) to Cloudflare R2 |
| `GET/POST` | `/api/settings/site-settings` | Configure global white-label site metadata & rules               |

---

## 🔒 Security Best Practices

1. **Keep Private Keys Secure:** Never distribute the server's private cryptographic key. Client applications only require the public key.
2. **Use HTTPS:** Always serve LicenX behind SSL/TLS (Cloudflare provides this out of the box).
3. **Protect the Admin Password:** Admin passwords are hashed with `scrypt` using unique cryptographically random salts.

---

## 🤝 Contributing

Contributions, bug reports, and pull requests are welcome! Please read our [CONTRIBUTING.md](./CONTRIBUTING.md) guide before getting started.

---

## 📄 License

This project is open-source and licensed under the **[MIT License](./LICENSE)**.
Free for personal and commercial software distribution.

## Self-hosted production runtime (Phase-03 source)

The production build now emits both the Vite frontend and a runnable Node entry:

```sh
npm ci
npm run build
NODE_ENV=production DATABASE_PROVIDER=postgres DATABASE_URL='postgresql://...' npm start
```

Do **not** supply real secrets on a shared shell or commit them. Production requires a reachable, previously approved database and storage configuration. `GET /api/health` is liveness; `GET /api/ready` checks database connectivity and local storage availability (returns 503 when not ready). The production app serves its frontend, `/api`, `/v1`, and the Python SDK download endpoint. Development mode continues through `npm run dev`.

For a **new, isolated VPS** where 80/443 are free, review `deploy/env.vps.example`, create a private `.env` with distinct PostgreSQL credentials and matching URL-encoded `DATABASE_URL`, then run `docker compose --profile standalone-https up --build -d`. Caddy obtains public HTTPS certificates for a domain pointing at that host. Backups/branding use the app storage volume, PostgreSQL uses its own private persistent volume, and Caddy uses separate persistent TLS state. Docker and DNS must already be configured; quick installation is Phase-04. Do not use `docker compose down -v` for updates or rollback.

If **Coolify or another reverse proxy already owns 80/443**, do **not** enable the `standalone-https` profile or publish the database. Connect the existing proxy to the Compose `licenx_frontend` network and route its HTTPS hostname to `app:3000`. Set `TRUSTED_PROXY_IP` to **only** the proxy's actual container IP, then re-create the application container. The default trusted hop `172.30.3.2` is for the standalone Caddy configuration. The frontend bridge subnet must not conflict with existing Docker networks. Always verify the HTTPS Origin/CSRF/login flow on an authorized test environment before rollout.

Container builds whitelist only required source/static/SDK inputs through `.dockerignore`; the existing local `vcon_data.db`, ignored `notes/`, credentials and runtime data are not deployment inputs. This does **not** remediate previously published secrets in Git history. Review the unresolved security findings and rotate any reused exposed secrets before a real production rollout. Operational deployment, installer, complete database backup/restore and staging acceptance are outside this phase.

## Ubuntu 24.04 installer (Phase-04)

A clean Ubuntu 24.04 LTS VPS with Git, OpenSSL, Docker Engine and the Docker Compose plugin can run the following **from the checked-out LicenX repository root**. The installer will not replace existing services, install a different container runtime, alter firewall rules or remove existing volumes.

```sh
bash scripts/install-vps.sh --check --domain license.example.com --email operator@example.com
bash scripts/install-vps.sh --domain license.example.com --email operator@example.com
```

The preflight requires an available Docker daemon, supported OS, valid host/email, DNS resolution, and unoccupied ports 80/443 on a **fresh standalone-Caddy** install. Install Docker Engine and Compose first following the official Ubuntu guidance when missing; if Coolify already owns HTTPS ports, do not use the standalone installer—use the existing reverse-proxy integration from Phase-03. The `--check` flag performs **no installation or writes**.

On the first install, the script creates a private `.env` (mode 0600) with generated PostgreSQL credentials and **only a SHA-256 hash** of a random 256-bit owner claim code. The original owner code is available locally in `.env.owner-setup` (mode 0600) and printed only on an interactive terminal; **do not post it in chat, logs or Git**. Visit `https://YOUR_DOMAIN/vcon`, enter that owner setup code and a fresh admin password. An invalid code cannot initialize the VPS admin; the successful claim becomes immutable because the first-admin insert is serialized in PostgreSQL. Cloudflare/Turso legacy setup is unchanged. After setup, keep the owner file secured with your backup materials.

Running the same installer again using the exact same domain/email preserves the existing secrets/configuration, first-admin identity, PostgreSQL data, files and TLS volumes. A changed domain/email or invalid existing owner hash blocks the run rather than overwriting it. No automatic database restore, system package setup, arbitrary domain takeover or live VPS deployment has been performed here. Phase-05 remains responsible for real approved-target lifecycle, backup/restore and outstanding security remediation.

## Phase-05 security and disposable release verification

The Node and Cloudflare license-validation endpoints now accept an **optional** URL-safe `nonce` challenge. When supplied, `nonce` and the exact trimmed requested `app_name` are included in the server-signed payload alongside the normalized license key and HWID. Updated Python SDKs **always send** a random challenge and fail closed if any authenticated response identity/challenge differs; roll out the compatible server **before** the updated SDKs. Older clients remain accepted by the server but do not gain replay/request-binding protection retroactively. An updated SDK will reject an old server lacking these signed fields. This is an intentional protocol security boundary, not an optional client fallback.

Application-scoped external Admin API keys are checked when reading or managing existing licenses in both runtime implementations. Client logout and PIN self-service reset cannot remove administrative device blocks. Heartbeats stop renewing licenses whose parent application is inactive or missing. Both Python SDKs use UTF-8 JSON signature canonicalization and close local-IP sockets on exception paths. The alternate `licenx` Python package no longer writes/reloads reversible license keys in temporary session files; explicit login remains supported and legacy temp sessions are removed.

The populated `vcon_data.db` and literal recovery records are removed from **new Git HEAD content** without rewriting Git history. Private local data must be preserved during the Git pull using a verified offline snapshot. The replacement `scripts/restoreData.mjs` accepts only explicit private input, an existing target database and confirmation; it performs no automatic import. **Important:** historical public Git exposure remains actionable. Credential reuse, coordinated revocation/rotation, customer-data migration and historical purging are separate, explicitly authorized operations.

GitHub Actions `phase05-security.yml` uses **synthetic disposable** PostgreSQL, local storage and HTTPS services to verify API/SDK security, install/restart/update, snapshot, simulated mutation and restore. It is **not** a verified production backup/restore or a deployment to an existing Coolify VPS. Never run the destructive CI restore sequence against customer services. Full approved-target acceptance and any live credential recovery require separate authorization.

## New-VPS installation with automatic credentials and existing services preserved

**No manual .env file is needed.** `scripts/install-vps.sh` generates a fresh PostgreSQL password, internal connection URI and 256-bit one-time owner setup code; it stores private credentials in local mode-0600 `.env` and local owner code in `.env.owner-setup`. These files are ignored by Git and Docker. The new deployment never reuses the old repository's leaked credentials; **it does not automatically revoke any historically exposed keys in other installations**. Install in a separate directory and preserve the new private credentials and named volumes with encrypted off-server backups.

For a host that already runs other services on ports 80/443, use:

```bash
bash scripts/install-vps.sh --check --mode existing-proxy --domain license.example.com --email owner@example.com
bash scripts/install-vps.sh --mode existing-proxy --domain license.example.com --email owner@example.com
```

This creates **only the new LicenX Compose stack** with PostgreSQL on a private Docker network and the new app bound to `127.0.0.1:13001`. It **does not start Caddy**, bind public 80/443, or alter Coolify, Cloudflare, unrelated containers or firewall rules. `127.0.0.1:13001` is plain HTTP restricted to the VPS loopback; it is NOT a publicly usable production HTTPS endpoint. A separate, explicitly authorized proxy or DNS configuration is required to make the domain serve this application securely. If port 13001 is occupied, choose a different unprivileged port using `--host-port 13002`; verify no collision first. The installer is safe to rerun with the same domain/email, but do not change an existing host port without checking the original service binding.

For an otherwise empty VPS with free 80/443, `--mode standalone` (the default) starts the self-contained Caddy HTTPS stack. The installer requires Ubuntu 24.04, Docker Engine, the Docker Compose plugin, Git and OpenSSL. It neither installs missing Docker software nor rotates credentials for existing deployed applications. Never put the private owner code or generated `.env` in a public log, screenshot or Git repository.

## Administration: Backup & Recovery (Node / PostgreSQL VPS)

In the administration sidebar, open **Backup**. Full-system archives include PostgreSQL application tables and the app's private/public storage assets (including branding); this is separate from the legacy license-CSV export history. This feature is Node/VPS-only and does **not** alter the Cloudflare Pages runtime.

1. On first use, download the **32-byte recovery key** and store it safely OFF the VPS (preferably in an encrypted offline vault). The recovery key is required to decrypt `.lxbackup` archives after VPS loss; it is never part of the backup file. On a fresh VPS you can import the original recovery key before creating backup accounts/jobs. Never commit credentials, archives or keys to Git.
2. Under **R2 backup accounts**, enter a *new* bucket-scoped Cloudflare R2 Access Key and secret, save, then test the stored connection. Credentials are encrypted on local persistent storage, and the secret is never returned to the browser. Use a **private** R2 bucket; never public assets buckets.
3. For **Manual backup**, create a downloadable local encrypted archive or select an R2 account to upload directly. R2 uploads are checked by streaming the remote SHA-256 back. The job history shows success/error and download link for local archives.
4. To enable **Automatic backup**, select a cadence (1, 6, 12, 24, or 168 hours), destination and Enable. Only a lightweight timer runs in the existing server; the backup worker is spawned on demand and exits afterward. No separate VPS cron/systemd service is necessary. The app must be running at the scheduled time; it schedules a future run after restart if one was missed.
5. For **Restore**, stage an encrypted `.lxbackup` via upload or selected R2 object key, type `RESTORE LICENX`, enter the **current admin password**, and confirm. Before modifying live data, the worker verifies/decrypts the archive and generates an encrypted pre-restore recovery checkpoint. Backup/restore jobs cannot overlap. **Test recovery on a disposable installation before operating on production data.**

The backup system is intentionally low-memory: PostgreSQL binary COPY streaming, 8 MiB single-concurrency R2 multipart uploads, a short-lived worker with a 160 MiB **V8 heap** limit (not a total-process RSS limit), and reduced process priority. Streaming avoids loading entire databases in RAM, but local staging requires enough free disk space for temporary files.

**Recovery limitations:** `.lxbackup` covers the LicenX application database and app-storage asset folders, **not** Docker Compose `.env`, Caddy TLS certificates, or external provider secrets. Preserve those separately. This new format does not import previous operator-created `.tar.gz.enc` archives; maintain their separate original encryption password. Local backups have no automatic deletion/retention policy yet; choose a private R2 destination and monitor free VPS disk. Existing Cloudflare R2 access keys previously shared outside secure channels must be revoked before using them here.

Validation: scoped source changes passed TypeScript/production build and isolated GitHub Actions Docker/PostgreSQL test [run 40761861603](https://github.com/vibtoolshq/LicenX/actions/runs/40761861603), including encrypted backup, tamper rejection, database and file restore, and readiness. This CI evidence is **not** a real VPS production restore or live R2 credential test; validate those explicitly before relying on automated recovery.
