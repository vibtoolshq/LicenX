# Database schema and persistence

LicenX supports PostgreSQL on the VPS, with a separate libSQL/SQLite-compatible implementation. PostgreSQL schema setup is transactional/versioned; `src/server/database/postgresSchema.ts:migratePostgres` holds a transaction, takes an advisory lock and tracks migrations **1–5** in `licenx_schema_migrations`. Do not apply this document as a standalone migration script.

## Core PostgreSQL tables

| Table | Key fields and usage |
| --- | --- |
| `admin_config` | Admin username/password hash/session secret, signature keys, R2 JSON and site settings JSON |
| `apps` | Slug, name, status, minimum version, app secret, device lease/ping/grace, optional realtime policy flags |
| `licenses` | Key, app scope, status, tier, device limit, validity, activation/expiry, customer metadata, PIN |
| `devices` | License FK, HWID, status, first bound, last ping, device/OS/IP |
| `validation_logs` | Event action/status/time and sanitized diagnostic context |
| `admin_api_keys` | Hashed private secret, prefix, scopes, optional app scope, lifecycle |
| `admin_login_attempts` | Failed login throttling |
| `user_control_pin_attempts` | Public PIN rate limiting |
| `public_license_check_limits` | Restricted membership API per-bucket quotas |
| `public_license_api_settings` | Global membership API state and secret |
| `public_license_api_domains` | Approved HTTPS origins and linked credentials |
| `r2_backups` | Legacy database/R2 backup metadata |
| `realtime_events` | Sanitized app/license/device change journal for browser subscribers |
| `licenx_schema_migrations` | Applied PostgreSQL schema versions |

`devices.license_id` references `licenses.id` with `ON DELETE CASCADE`; a unique `(license_id,hwid)` index prevents duplicate bindings. Important query indices cover license keys/status/app, app slugs/status, device HWIDs/lease activity, logs time/action and realtime event time.

## Migration stages

1. Core admin, apps, licenses, devices, logs, R2 metadata and API keys.
2. Public membership rate limiting.
3. Restricted partner API state and approved domains.
4. App realtime policy columns, event journal, trigger generation.
5. Additional audited create/UI-change triggers.

The triggers in migrations 4–5 record changed resource IDs, not full customer rows. Core transactional device binding also uses PostgreSQL per-license row locking (`src/server/database/postgres.ts:PostgresTransaction.lockLicense`).

## Storage beyond SQL

Full-system backup controller state and AES-GCM recovery key live in private `LOCAL_STORAGE_PATH/.backup-manager/`; managed public/private files are under the storage provider. PostgreSQL persists application/license/device data separately from those files. Named Docker volumes in `compose.yaml` preserve app and database data across app container replacement.

## Avoid schema assumptions

The SQLite/libSQL schema is assembled in `src/server/db.ts` and has its own extension logic; do **not** automatically apply PostgreSQL DDL to Cloudflare or assume all functions/columns have identical support. Consult `src/server/database/contracts.ts`, `sqlDialect.ts`, `postgres.ts`.

**Source:** `src/server/database/postgresSchema.ts:1-288`, `src/server/db.ts:304-658`, `src/server/deviceBinding.ts`, `compose.yaml`.