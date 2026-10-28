/**
 * Isolated disposable PostgreSQL + storage full-backup integration regression.
 * Only run in CI Docker Compose; NEVER against live databases.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
const exec = promisify(execFile);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const root = process.env.LOCAL_STORAGE_PATH;
assert.ok(root && path.isAbsolute(root), 'isolated storage root required');
assert.match(process.env.DATABASE_URL || '', /licenx_ci/, 'disposable CI database required');
const source = path.join(root, '.backup-manager', 'archives', 'ci-original.lxbackup');
const marker = path.join(root, 'public', 'ci-backup-marker.txt');
await db.connect();
try {
  await db.query(`INSERT INTO apps
    (id, app_slug, display_name, app_secret, created_at, updated_at)
    VALUES ('ci_backup_app', 'ci_backup_slug', 'CI Backup Fixture', 'test-only-nonsecret', 1, 1)`);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'before-backup\n', { mode: 0o600 });

  await exec(process.execPath, ['build/fullBackupWorker.js', 'backup', 'ci-original', 'local'], { timeout: 90_000 });
  assert.ok((await fs.stat(source)).size > 100, 'encrypted backup was created');

  const tampered = path.join(root, '.backup-manager', 'incoming', 'tampered.lxbackup');
  await fs.copyFile(source, tampered);
  const fd = await fs.open(tampered, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await fd.read(byte, 0, 1, 27);
    byte[0] ^= 0x1;
    await fd.write(byte, 0, 1, 27);
  } finally { await fd.close(); }
  try {
    await exec(process.execPath, ['build/fullBackupWorker.js', 'restore', 'ci-tampered', tampered], { timeout: 90_000 });
    assert.fail('tampered encrypted archive must be rejected');
  } catch (error) {
    assert.notEqual(error.code, 'ERR_ASSERTION', 'tampering must fail');
  }

  await db.query("DELETE FROM apps WHERE id = 'ci_backup_app'");
  await fs.writeFile(marker, 'after-backup\n');

  await exec(process.execPath, ['build/fullBackupWorker.js', 'restore', 'ci-restore', source], { timeout: 90_000 });
  const restored = await db.query("SELECT display_name FROM apps WHERE id = 'ci_backup_app'");
  assert.equal(restored.rows[0]?.display_name, 'CI Backup Fixture', 'PostgreSQL fixture restored');
  assert.equal(await fs.readFile(marker, 'utf8'), 'before-backup\n', 'application assets restored');
  const checkpoint = path.join(root, '.backup-manager', 'archives', 'pre-restore-ci-restore.lxbackup');
  assert.ok((await fs.stat(checkpoint)).size > 100, 'encrypted pre-restore checkpoint exists');
  console.log('BACKUP_RESTORE_INTEGRATION_PASS');
} finally { await db.end(); }
