/**
 * Isolated disposable PostgreSQL + storage full-backup integration regression.
 * Only run in CI Docker Compose; NEVER against live databases.
 * LG-01A-BR01: v2 Group backup, exact legacy v1/v5 binary COPY compatibility.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomBytes, createCipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { to as copyTo } from 'pg-copy-streams';

const exec = promisify(execFile);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const root = process.env.LOCAL_STORAGE_PATH;
assert.ok(root && path.isAbsolute(root), 'isolated storage root required');
assert.match(process.env.DATABASE_URL || '', /licenx_ci/, 'disposable CI database required');

const folder = path.join(root, '.backup-manager');
const archiveDir = path.join(folder, 'archives');
const source = path.join(archiveDir, 'ci-original.lxbackup');
const legacyArchive = path.join(archiveDir, 'ci-legacy-v5.lxbackup');
const v2Archive = path.join(archiveDir, 'ci-v2-groups.lxbackup');
const statsDeviceId = 'ci_stats_device';
const marker = path.join(root, 'public', 'ci-backup-marker.txt');
const groupId = 'grp_' + 'a'.repeat(24);
const licenseId = 'ci_group_license';
const oldTables = [
  'admin_config', 'apps', 'licenses', 'devices', 'validation_logs',
  'r2_backups', 'admin_api_keys', 'admin_login_attempts',
  'user_control_pin_attempts', 'licenx_schema_migrations',
];
const v2Tables = [
  'admin_config', 'apps', 'license_groups', 'licenses', 'devices', 'validation_logs',
  'r2_backups', 'admin_api_keys', 'admin_login_attempts',
  'user_control_pin_attempts', 'licenx_schema_migrations',
];
const legacyLicenseColumns = [
  'id', 'key', 'status', 'tier', 'app_id', 'device_limit',
  'validity_type', 'validity_value', 'activated_at', 'expires_at',
  'created_at', 'customer_name', 'customer_email', 'notes',
  'metadata_json', 'r2_backup_id', 'pin',
];

/** Construct an encrypted v1-format binary COPY archive on disposable PG.
 * Explicit pre-v6 license columns reproduce the previous production layout,
 * without reading or writing any existing production backup material.
 */
async function makeLegacyFixture(target, manifestTables = oldTables, version = 1) {
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'licenx-v5-fixture-'));
  try {
    const dir = path.join(temp, 'db');
    await fs.mkdir(dir, { recursive: true });
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      for (const table of (version === 2 ? v2Tables : oldTables)) {
        const select = table === 'licenses' && version === 1
          ? 'COPY "licenses" (' + legacyLicenseColumns.map(name => '"' + name + '"').join(', ') + ') TO STDOUT WITH (FORMAT binary)'
          : table === 'licenx_schema_migrations'
            ? 'COPY (SELECT version, applied_at FROM licenx_schema_migrations WHERE version < ' + (version === 2 ? '7' : '6') + ') TO STDOUT WITH (FORMAT binary)'
            : 'COPY "' + table + '" TO STDOUT WITH (FORMAT binary)';
        await pipeline(db.query(copyTo(select)), createWriteStream(path.join(dir, table + '.copy')));
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    }
    await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify({
      kind: 'licenx-full-v' + version, tables: manifestTables, createdAt: Date.now(),
    }));
    const tarball = path.join(temp, 'archive.tar.gz');
    await exec('tar', ['-czf', tarball, '-C', temp, 'db', 'manifest.json'], { timeout: 15_000 });
    const key = await fs.readFile(path.join(folder, 'recovery.key'));
    assert.equal(key.length, 32, 'disposable CI recovery key');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const input = await fs.readFile(tarball); // Tiny disposable fixture only.
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    await fs.writeFile(target, Buffer.concat([
      Buffer.from('LXBACK01'), nonce, ciphertext, cipher.getAuthTag(),
    ]), { flag: 'wx', mode: 0o600 });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function runWorker(action, id, sourcePath) {
  return exec(process.execPath, ['build/fullBackupWorker.js', action, id, sourcePath], { timeout: 90_000 });
}

await db.connect();
try {
  await db.query('INSERT INTO apps (id, app_slug, display_name, app_secret, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, 1)',
    ['ci_backup_app', 'ci_backup_slug', 'CI Backup Fixture', 'test-only-nonsecret']);
  await db.query("INSERT INTO license_groups (id, name, name_key, created_at, updated_at, archived_at) VALUES ($1, 'CI Team Alpha', 'ci team alpha', 1, 1, NULL)", [groupId]);
  await db.query("INSERT INTO licenses (id, key, status, tier, app_id, device_limit, validity_type, validity_value, created_at, pin, group_id) VALUES ($1, 'CI-GROUP-LICENSE-0001', 'active', 'Pro', 'ci_backup_app', 1, 'lifetime', 0, 1, '1234', $2)", [licenseId, groupId]);
  await db.query("INSERT INTO devices (id, license_id, hwid, device_name, first_bound_at, last_ping_at, status) VALUES ($1, $2, 'CI-DISPOSABLE-HWID', 'CI-Device', 1, 1, 'active')", [statsDeviceId, licenseId]);
  await db.query("INSERT INTO device_stat_snapshots (device_id, stats_json, reported_at, report_token_hash, report_token_expires) VALUES ($1, $2, 1234, $3, 999999)", [statsDeviceId, JSON.stringify({ Total: 5000, Sent: 200, Failed: 4800 }), 'a'.repeat(64)]);

  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'before-backup\n', { mode: 0o600 });

  // v3 encrypted snapshot must carry Group names and device statistics.
  await runWorker('backup', 'ci-original', 'local');
  assert.ok((await fs.stat(source)).size > 100, 'encrypted v3 backup was created');

  // Preserve existing fail-closed AES-GCM tamper rejection contract.
  const tampered = path.join(folder, 'incoming', 'tampered.lxbackup');
  await fs.copyFile(source, tampered);
  const fd = await fs.open(tampered, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await fd.read(byte, 0, 1, 27);
    byte[0] ^= 0x1;
    await fd.write(byte, 0, 1, 27);
  } finally { await fd.close(); }
  try {
    await runWorker('restore', 'ci-tampered', tampered);
    assert.fail('tampered encrypted archive must be rejected');
  } catch (error) {
    assert.notEqual(error.code, 'ERR_ASSERTION', 'tampering must fail');
  }

  await db.query('DELETE FROM licenses WHERE id = $1', [licenseId]);
  await db.query('DELETE FROM license_groups WHERE id = $1', [groupId]);
  await db.query("DELETE FROM apps WHERE id = 'ci_backup_app'");
  await fs.writeFile(marker, 'after-backup\n');

  await runWorker('restore', 'ci-restore', source);
  const restored = await db.query("SELECT display_name FROM apps WHERE id = 'ci_backup_app'");
  assert.equal(restored.rows[0]?.display_name, 'CI Backup Fixture', 'PostgreSQL fixture restored');
  const restoredGroup = await db.query('SELECT name, archived_at FROM license_groups WHERE id = $1', [groupId]);
  assert.equal(restoredGroup.rows[0]?.name, 'CI Team Alpha', 'v2 Group name restored');
  assert.equal(restoredGroup.rows[0]?.archived_at, null, 'v2 Group status restored');
  const restoredLicense = await db.query('SELECT group_id, pin FROM licenses WHERE id = $1', [licenseId]);
  assert.equal(restoredLicense.rows[0]?.group_id, groupId, 'v2 license Group association restored');
  assert.equal(restoredLicense.rows[0]?.pin, '1234', 'existing license PIN preserved');
  const statsRestored = await db.query('SELECT stats_json FROM device_stat_snapshots WHERE device_id = $1', [statsDeviceId]);
  assert.deepEqual(JSON.parse(statsRestored.rows[0]?.stats_json), { Total: 5000, Sent: 200, Failed: 4800 }, 'v3 statistics roundtrip');
  assert.equal(await fs.readFile(marker, 'utf8'), 'before-backup\n', 'application assets restored');
  assert.ok((await fs.stat(path.join(archiveDir, 'pre-restore-ci-restore.lxbackup'))).size > 100,
    'encrypted pre-restore checkpoint exists');

  // Genuine v2 Group archive (no stats table) must restore into v7 without loss.
  await makeLegacyFixture(v2Archive, v2Tables, 2);
  await db.query("UPDATE license_groups SET name = 'Changed Before V2 Restore' WHERE id = $1", [groupId]);
  await runWorker('restore', 'ci-v2-restore', v2Archive);
  assert.equal((await db.query('SELECT name FROM license_groups WHERE id = $1', [groupId])).rows[0]?.name,
    'CI Team Alpha', 'v2 Group archive restored');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM device_stat_snapshots')).rows[0].n,
    0, 'v2 archive leaves v7 statistics empty');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM licenx_schema_migrations WHERE version = 7')).rows[0].n,
    1, 'v2 restore retains physical v7 migration ledger');

  // Real 17-column v5 binary COPY fixture, without any Group metadata.
  await makeLegacyFixture(legacyArchive);
  await db.query("UPDATE license_groups SET name = 'Modified Group' WHERE id = $1", [groupId]);

  // A correctly encrypted but malformed table manifest must fail closed.
  const wrongManifest = path.join(folder, 'incoming', 'wrong-manifest.lxbackup');
  await makeLegacyFixture(wrongManifest, [...oldTables, 'license_groups']);
  try {
    await runWorker('restore', 'ci-invalid-manifest', wrongManifest);
    assert.fail('unrecognized v1 manifest must be rejected');
  } catch (error) {
    assert.notEqual(error.code, 'ERR_ASSERTION', 'manifest must fail closed');
  }
  assert.equal((await db.query('SELECT name FROM license_groups WHERE id = $1', [groupId])).rows[0]?.name,
    'Modified Group', 'invalid legacy manifest cannot mutate PostgreSQL data');

  // Restore historical v1 data into the existing v6 schema atomically.
  await runWorker('restore', 'ci-legacy-restore', legacyArchive);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM license_groups')).rows[0].n,
    0, 'legacy backup has no Groups; stale v6 Group rows cannot survive');
  const unassigned = await db.query('SELECT group_id, pin FROM licenses WHERE id = $1', [licenseId]);
  assert.equal(unassigned.rows[0]?.group_id, null, 'old binary license becomes Unassigned');
  assert.equal(unassigned.rows[0]?.pin, '1234', 'legacy license fields preserved');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM licenx_schema_migrations WHERE version = 6')).rows[0].n,
    1, 'physical v6 schema must retain migration version 6');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM licenx_schema_migrations WHERE version = 7')).rows[0].n,
    1, 'physical v7 schema must retain migration version 7');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM device_stat_snapshots')).rows[0].n, 0,
    'v1 archive cannot preserve later client statistics');
  assert.ok((await fs.stat(path.join(archiveDir, 'pre-restore-ci-legacy-restore.lxbackup'))).size > 100,
    'legacy restore still writes encrypted rollback checkpoint');
  console.log('BACKUP_RESTORE_INTEGRATION_PASS');
  console.log('LG01A_BR01_V2_GROUP_AND_LEGACY_V1_RESTORE_PASS');
  console.log('SDK_STAT01_V3_STATS_AND_V2_V1_LEGACY_RESTORE_PASS');
} finally {
  await db.end();
}
