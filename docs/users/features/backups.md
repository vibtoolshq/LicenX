# Encrypted full-system backup and restore

**UI:** Administration → **Backup** (`/vcon/backup`). Available in the Node/PostgreSQL VPS deployment with configured local storage. It is separate from legacy R2 CSV/license backup functions.

## Recovery key and destinations

Download and securely store `licenx-recovery.key` **off the VPS**. The server records that the key has been downloaded; scheduled backups cannot be enabled until that flag is recorded. An existing recovery key may be imported only into an otherwise fresh/empty backup installation, not over completed jobs.

Add one or more Cloudflare R2 backup accounts with private bucket access, or choose local archive storage. R2 secrets are encrypted at rest in the backup manager's private state. Test an account before relying on remote retention.

## Create and schedule

Use **Run backup** for an immediate job. The UI reads job statuses; a separate Node worker creates an encrypted `.lxbackup` file and exits. The schedule accepts hourly intervals **1, 6, 12, 24 or 168** and a valid local/R2 destination; enabled schedules run through the server scheduler.

## Restore — destructive operation

Upload a previously encrypted archive (or import from configured R2) and use the explicit confirmation text `RESTORE LICENX` plus the current admin password. A restore may replace persisted database and storage state; take a known-good independent backup first and rehearse in a disposable environment. Restore temporarily makes `/api/ready` return HTTP 503 and blocks ordinary API calls while it runs.

The backup includes DB data and managed assets, **not** every host secret, `.env` file, TLS certificate or an arbitrary external volume. Backup metadata/header presence is *not* proof that decryption/restore succeeds. Always validate restore independently.

**Source:** `src/components/BackupTab.tsx`, `src/server/backupControl.ts:19-315`, `src/server/fullBackupWorker.ts:17-255`, `server.ts:37-94`.