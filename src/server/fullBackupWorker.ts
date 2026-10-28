/**
 * One-shot LicenX full backup worker. Spawned only for a backup/restore job.
 * No resident backup process. PostgreSQL COPY streams keep heap usage bounded.
 */
import { Client } from 'pg';
import { to as copyTo, from as copyFrom } from 'pg-copy-streams';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Upload } from '@aws-sdk/lib-storage';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getR2Client, type R2Config } from './r2.js';

export const BACKUP_TABLES = [
  'admin_config', 'apps', 'licenses', 'devices', 'validation_logs',
  'r2_backups', 'admin_api_keys', 'admin_login_attempts',
  'user_control_pin_attempts', 'licenx_schema_migrations',
] as const;
const MAGIC = Buffer.from('LXBACK01');
const storageRoot = process.env.LOCAL_STORAGE_PATH ?? '';
const store = path.join(storageRoot, '.backup-manager');
const archives = path.join(store, 'archives');
const maxArchiveBytes = 4 * 1024 ** 3;

async function shell(cmd: string, args: string[]): Promise<string> {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', c => { if (out.length < 1024 * 1024) out += c.toString(); });
  child.stderr.on('data', c => { if (err.length < 1024) err += c.toString(); });
  const exit = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
  if (exit !== 0) throw new Error(cmd + ' failed: ' + err.slice(0, 150));
  return out;
}
async function readKey(): Promise<Buffer> {
  const key = await fs.readFile(path.join(store, 'recovery.key'));
  if (key.length !== 32) throw new Error('Missing or invalid offline recovery key');
  return key;
}
async function encrypt(source: string, target: string, key: Buffer) {
  const iv = randomBytes(12);
  await fs.writeFile(target, Buffer.concat([MAGIC, iv]), { mode: 0o600, flag: 'wx' });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await pipeline(createReadStream(source), cipher, createWriteStream(target, { flags: 'a', mode: 0o600 }));
  await fs.appendFile(target, cipher.getAuthTag());
}
async function decrypt(source: string, target: string, key: Buffer) {
  const stat = await fs.stat(source);
  if (stat.size < 36 || stat.size > maxArchiveBytes) throw new Error('Invalid backup size');
  const fd = await fs.open(source, 'r');
  const header = Buffer.alloc(20);
  const tag = Buffer.alloc(16);
  try {
    await fd.read(header, 0, 20, 0);
    await fd.read(tag, 0, 16, stat.size - 16);
  } finally { await fd.close(); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid backup format');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(source, { start: 20, end: stat.size - 17 }), decipher, createWriteStream(target, { mode: 0o600 }));
}
async function exportDatabase(folder: string) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const table of BACKUP_TABLES) {
      const output = path.join(folder, table + '.copy');
      const stream = db.query(copyTo('COPY "' + table + '" TO STDOUT WITH (FORMAT binary)'));
      await pipeline(stream, createWriteStream(output, { mode: 0o600 }));
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await db.end(); }
}
async function restoreDatabase(folder: string, onBeforeCommit: () => Promise<void>) {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL lock_timeout = \'20s\'');
    await db.query('LOCK TABLE ' + BACKUP_TABLES.map(t => '"' + t + '"').join(', ') + ' IN ACCESS EXCLUSIVE MODE');
    await db.query('TRUNCATE TABLE ' + BACKUP_TABLES.map(t => '"' + t + '"').join(', ') + ' CASCADE');
    for (const table of BACKUP_TABLES) {
      const input = path.join(folder, table + '.copy');
      await pipeline(createReadStream(input), db.query(copyFrom('COPY "' + table + '" FROM STDIN WITH (FORMAT binary)')));
    }
    await onBeforeCommit();
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await db.end(); }
}
async function makeBackup(destination: string, id: string): Promise<{ path?: string; r2Key?: string }> {
  if (!path.isAbsolute(storageRoot)) throw new Error('Local storage must be configured');
  const key = await readKey();
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'licenx-export-'));
  await fs.mkdir(archives, { recursive: true, mode: 0o700 });
  const target = path.join(archives, id + '.lxbackup');
  try {
    await exportDatabase(path.join(temp, 'db'));
    await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify({
      kind: 'licenx-full-v1', tables: BACKUP_TABLES, createdAt: Date.now()
    }), { mode: 0o600 });
    const zipped = path.join(temp, 'backup.tar.gz');
    const dirs = ['public', 'private'];
    const args = ['-czf', zipped, '-C', temp, 'db', 'manifest.json'];
    for (const d of dirs) {
      try { if ((await fs.stat(path.join(storageRoot, d))).isDirectory()) args.push('-C', storageRoot, d); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    await shell('tar', args);
    await encrypt(zipped, target, key);
    let r2Key: string | undefined;
    if (destination.startsWith('r2:')) {
      const saved = JSON.parse(await fs.readFile(path.join(store, 'state.json'), 'utf8'));
      const account = saved.accounts?.find((a: any) => a.id === destination.slice(3));
      if (!account || typeof account.secret !== 'string') throw new Error('R2 account not found');
      const raw = Buffer.from(account.secret, 'base64');
      if (raw.length < 29) throw new Error('Invalid R2 credential encryption');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const secretAccessKey = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      const config: R2Config = { accountId: account.accountId, accessKeyId: account.accessKeyId,
        secretAccessKey, bucketName: account.bucketName };
      const bucket = config.bucketName;
      const client = getR2Client(config);
      r2Key = 'licenx-full-backups/' + id + '.lxbackup';
      await new Upload({ client, params: {
        Bucket: bucket, Key: r2Key, Body: createReadStream(target),
        ContentType: 'application/octet-stream'
      }, queueSize: 1, partSize: 8 * 1024 * 1024 }).done();
      const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: r2Key }));
      if (Number(object.ContentLength) !== (await fs.stat(target)).size) throw new Error('R2 remote size mismatch');
      const remote = await client.send(new GetObjectCommand({ Bucket: bucket, Key: r2Key }));
      if (!remote.Body) throw new Error('R2 remote verification failed');
      const hash = createHash('sha256');
      for await (const chunk of remote.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
      const localHash = await hashFile(target);
      if (hash.digest('hex') !== localHash) throw new Error('R2 remote SHA256 mismatch');
    }
    if (r2Key) await fs.rm(target, { force: true });
    return { path: r2Key ? undefined : target, r2Key };
  } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const c of createReadStream(file)) hash.update(c);
  return hash.digest('hex');
}
async function assertNoSymlinks(folder: string) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const item = path.join(folder, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('Backup contains unsupported file type');
    if (entry.isDirectory()) await assertNoSymlinks(item);
  }
}
async function restoreBackup(source: string, id: string) {
  const key = await readKey();
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'licenx-restore-'));
  const restoreBase = path.join(store, 'pre-restore-' + id);
  let committed = false;
  const movedDirs: string[] = [];
  const installedDirs: string[] = [];
  try {
    const zipped = path.join(temp, 'backup.tar.gz');
    await decrypt(source, zipped, key);
    const entries = (await shell('tar', ['-tzf', zipped])).split('\n').filter(Boolean);
    if (entries.some(e => e.startsWith('/') || e.split('/').includes('..') || !/^(\.\/)?(db|manifest\.json|public|private)(\/|$)/.test(e))) {
      throw new Error('Unsafe backup paths');
    }
    const unpacked = path.join(temp, 'unpacked');
    await fs.mkdir(unpacked, { mode: 0o700 });
    await shell('tar', ['-xzf', zipped, '--no-same-owner', '--no-same-permissions', '-C', unpacked]);
    await assertNoSymlinks(unpacked);
    const manifest = JSON.parse(await fs.readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
    if (manifest.kind !== 'licenx-full-v1' || JSON.stringify(manifest.tables) !== JSON.stringify(BACKUP_TABLES)) {
      throw new Error('Backup format or schema mismatch');
    }
    for (const table of BACKUP_TABLES) {
      if (!(await fs.stat(path.join(unpacked, 'db', table + '.copy'))).isFile()) throw new Error('Missing database table file');
    }
    // Recovery checkpoint before any destructive operation.
    const checkpoint = await makeBackup('local', 'pre-restore-' + id);
    await fs.mkdir(restoreBase, { recursive: false, mode: 0o700 });
    await restoreDatabase(path.join(unpacked, 'db'), async () => {
      for (const name of ['public', 'private']) {
        const incoming = path.join(unpacked, name);
        const previous = path.join(storageRoot, name);
        try { if (!(await fs.stat(incoming)).isDirectory()) continue; }
        catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
        try { await fs.rename(previous, path.join(restoreBase, name)); movedDirs.push(name); }
        catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        await fs.rename(incoming, previous);
        installedDirs.push(name);
      }
    });
    committed = true;
    return { checkpoint: checkpoint.path };
  } catch (err) {
    if (!committed) {
      for (const name of [...installedDirs].reverse()) {
        await fs.rm(path.join(storageRoot, name), { recursive: true, force: true }).catch(() => {});
      }
      for (const name of [...movedDirs].reverse()) {
        await fs.rename(path.join(restoreBase, name), path.join(storageRoot, name)).catch(() => {});
      }
    }
    throw err;
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    // Keep prior storage until operator verifies restored state; do not delete checkpoint.
  }
}
export async function runBackupWorker(action: string, id: string, extra: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid job ID');
  if (action === 'backup') return makeBackup(extra, id);
  if (action === 'restore') return restoreBackup(extra, id);
  throw new Error('Invalid worker action');
}
if (process.argv[1] && /fullBackupWorker\.js$/.test(process.argv[1])) {
  runBackupWorker(process.argv[2] || '', process.argv[3] || '', process.argv[4] || '').then(
    result => { process.stdout.write(JSON.stringify(result) + '\n'); },
    () => { process.stderr.write('BACKUP_WORKER_FAILED\n'); process.exitCode = 1; }
  );
}
