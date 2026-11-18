# Configuration reference

Do not publish a populated `.env`. These are **configuration names**, sourced from `.env.example`, `deploy/env.vps.example`, `compose.yaml` and implementation `process.env` readers; runtime values and defaults depend on deployment mode.

## Database and host

| Variable | Used by | Behavior |
| --- | --- | --- |
| `DATABASE_PROVIDER` | `src/server/db.ts` | Selects PostgreSQL or libSQL path; production Compose selects `postgres` |
| `DATABASE_URL` | DB adapter / Compose | Private PostgreSQL connection string; Compose requires value |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | libSQL adapter | Remote libSQL connection and token for supported adapter |
| `PORT` | `server.ts` | Node listener, default 3000 in code |
| `NODE_ENV` | Node runtime | Production serves built `dist/`; dev mounts Vite middleware |
| `TRUSTED_PROXY_IP` | Express | Bounds trusted forwarding proxy identity |
| `APP_URL` | application/adapter configuration | Application base URL where used; verify specific runtime callers |
| `DOMAIN`, `ACME_EMAIL` | Caddy standalone Compose | TLS domain and certificate contact |

## Storage and first-owner setup

| Variable | Behavior |
| --- | --- |
| `STORAGE_PROVIDER` | `local` or supported R2 path; production Compose sets local |
| `LOCAL_STORAGE_PATH` | Absolute private file-store path; Compose mounts persistent `/var/lib/licenx/storage` |
| `OWNER_SETUP_CODE_SHA256` | PostgreSQL first-owner code digest; plain setup code must stay private |

## Optional security / realtime gates

| Variable | Default/effect from source |
| --- | --- |
| `PUBLIC_LICENSE_CHECK_ENABLED` | Server operator override for **restricted partner** membership endpoint; `false` disables it (Compose default string `true`) |
| `PUBLIC_LICENSE_CHECK_RATE_SECRET` | Additional key material for partner API quotas; fallback to persisted server secret where supported |
| `LICENX_REALTIME_TRANSPORT_ENABLED` | Default `false` in Compose; allows optional license SocketCore ticket/gateway |
| `LICENX_ADMIN_REALTIME_ENABLED` | Default `false` in Compose; allows optional authenticated admin WSS |

CI/test-focused names in source include `WS05_CI_RUN`, `WS05_MODE`, `WS05_CLIENTS`, `WS05_CA_FILE`, and `WS05_PUBLIC_KEY_FILE`; these are **not** normal production settings. Do not enable them outside their owned test harness.

## App-level policy (database, not environment)

`apps` stores `device_lease_seconds`, `ping_interval_seconds`, `offline_grace_seconds`, `realtime_websocket_enabled`, `keep_login_on_network_error`. Defaults and safe bounds are in `src/server/licensePolicy.ts`. Both realtime app policy and server gate must allow websocket use.

## Site Settings (persistent editable keys)

`src/types.ts:304-345` defines 17 editable fields: `siteName`, `siteTagline`, `siteTitle`, `metaDescription`, `logoUrl`, `faviconUrl`, `ogImageUrl`, `footerText`, `supportEmail`, `telegramUrl`, `discordUrl`, `docsUrl`, `buyLicenseUrl`, `allowPublicCheck`, `allowPublicReset`, `noticeBanner`, `noticeBannerEnabled`. Published `publicNavigation`/`publicTools` are separately managed catalog state, **not editable site settings fields**.

**Caution:** These tables are an implementation-oriented reference. Defaults in production can differ due to private environment settings; no live secrets or flags were read for this audit.

[Installation](../users/installation.md) · [Security](../dev/security.md).