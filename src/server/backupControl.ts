/**
 * Administration-only backup control plane.
 * The only idle work is one Node timer; backup/restore runs in one short-lived child.
 * All private state lives in the persistent LOCAL_STORAGE_PATH volume.
 */
import type { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { testR2Connection, getR2Client, type R2Config } from './r2.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getDbClient } from './db.js';
import { verifyPassword } from './crypto.js';

type Account = { id: string; name: string; accountId: string; accessKeyId: string; bucketName: string; secret: string };
type Job = { id: string; action: 'backup' | 'restore'; status: 'running' | 'completed' | 'failed'; destination: string; createdAt: number; finishedAt?: number; error?: string; file?: string; r2Key?: string; checkpoint?: string };
type Schedule = { enabled: boolean; intervalHours: number; destination: string; nextAt: number };
type State = { accounts: Account[]; jobs: Job[]; schedule: Schedule; recoveryDownloaded: boolean };
const root = process.env.LOCAL_STORAGE_PATH || '';
const folder = path.join(root, '.backup-manager');
const archiveFolder = path.join(folder, 'archives');
const incomingFolder = path.join(folder, 'incoming');
const stateFile = path.join(folder, 'state.json');
const keyFile = path.join(folder, 'recovery.key');
const MAX_UPLOAD = 4 * 1024 ** 3;
const validId = (s: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(s);
const defaultState = (): State => ({ accounts: [], jobs: [], schedule: { enabled: false, intervalHours: 24, destination: 'local', nextAt: 0 }, recoveryDownloaded: false });
let state: State = defaultState();
let active: string | null = null;
let restoreMode = false;
let timer: NodeJS.Timeout | undefined;
let writing: Promise<void> = Promise.resolve();

function safeWrite() {
  const copy = JSON.stringify(state);
  writing = writing.catch(() => {}).then(async () => {
    const tmp = path.join(folder, '.state-' + randomUUID());
    await fs.writeFile(tmp, copy, { mode: 0o600 });
    await fs.rename(tmp, stateFile);
  });
  return writing;
}
async function key(): Promise<Buffer> {
  const result = await fs.readFile(keyFile);
  if (result.length !== 32) throw new Error('Invalid backup encryption key');
  return result;
}
async function seal(secret: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await key(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
async function unseal(blob: string): Promise<string> {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < 29) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', await key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
async function accountConfig(account: Account): Promise<R2Config> {
  return { accountId: account.accountId, accessKeyId: account.accessKeyId, secretAccessKey: await unseal(account.secret), bucketName: account.bucketName };
}
const publicAccount = (a: Account) => ({
  id: a.id, name: a.name, accountId: a.accountId, accessKeyId: a.accessKeyId, bucketName: a.bucketName, hasSecret: Boolean(a.secret)
});
function cleanAccount(input: any): { name: string; accountId: string; accessKeyId: string; bucketName: string; secretAccessKey: string } {
  const read = (key: string) => typeof input?.[key] === 'string' ? input[key].trim() : '';
  const out = { name: read('name'), accountId: read('accountId'), accessKeyId: read('accessKeyId'), bucketName: read('bucketName'), secretAccessKey: read('secretAccessKey') };
  if (!out.name || out.name.length > 60 || !/^[a-f0-9]{32}$/i.test(out.accountId) ||
      !/^[a-zA-Z0-9_-]{3,200}$/.test(out.accessKeyId) || !/^[a-zA-Z0-9_-]{3,64}$/.test(out.bucketName) ||
      out.secretAccessKey.length > 256) throw new Error('Invalid account configuration');
  return out;
}
function serialJob(id: string, action: Job['action'], destination: string): Job {
  return { id, action, status: 'running', destination, createdAt: Date.now() };
}
// Long weekly intervals are checked in <=24-hour chunks; a chunk expiry is not
// itself permission to execute a backup before the actual nextAt timestamp.
export function backupScheduleTiming(nextAt: number, now: number): { delayMs: number; isDue: boolean } {
  const remaining = nextAt - now;
  return {
    delayMs: Math.min(Math.max(1000, remaining), 24 * 3600_000),
    isDue: remaining <= 0,
  };
}
function scheduleNext() {
  if (timer) clearTimeout(timer);
  if (!state.schedule.enabled) return;
  const { delayMs } = backupScheduleTiming(state.schedule.nextAt, Date.now());
  timer = setTimeout(() => {
    timer = undefined;
    if (!state.schedule.enabled) return;
    if (!backupScheduleTiming(state.schedule.nextAt, Date.now()).isDue) {
      scheduleNext();
      return;
    }
    const destination = state.schedule.destination;
    state.schedule.nextAt = Date.now() + state.schedule.intervalHours * 3600_000;
    void safeWrite()
      .then(() => startJob('backup', destination))
      .catch(() => { console.warn('[LicenX] Scheduled backup dispatch did not start'); })
      .finally(scheduleNext);
  }, delayMs);
  timer.unref();
}
async function startJob(action: Job['action'], destination: string): Promise<Job> {
  if (active) throw new Error('Another backup or restore is running');
  if (action === 'backup' && destination !== 'local' && !/^r2:[a-zA-Z0-9_-]{1,100}$/.test(destination)) throw new Error('Invalid destination');
  if (action === 'backup' && destination !== 'local' && !state.accounts.some(a => 'r2:' + a.id === destination)) throw new Error('R2 account not found');
  if (action === 'backup' && !state.recoveryDownloaded) throw new Error('Download your recovery key before creating backups');
  const id = 'lx_' + Date.now() + '_' + randomBytes(4).toString('hex');
  const job = serialJob(id, action, destination);
  active = id;
  restoreMode = action === 'restore';
  state.jobs.unshift(job);
  state.jobs = state.jobs.slice(0, 60);
  try { await safeWrite(); }
  catch (err) { active = null; restoreMode = false; throw err; }
  const workerFile = path.join(process.cwd(), 'build', 'fullBackupWorker.js');
  const child = spawn(process.execPath, ['--max-old-space-size=160', workerFile, action, id, destination], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  try { (await import('node:os')).setPriority(child.pid!, 10); } catch { /* normal on unsupported OS */ }
  child.stdout.on('data', c => { if (output.length < 8_000) output += c.toString(); });
  child.stderr.on('data', () => { /* Worker errors intentionally never leak secrets */ });
  const finish = async (ok: boolean) => {
    job.status = ok ? 'completed' : 'failed';
    job.finishedAt = Date.now();
    if (!ok) job.error = 'Backup or restore worker failed. See server diagnostics.';
    if (ok) {
      try {
        const parsed = JSON.parse(output.trim().split('\n').at(-1) || '{}');
        job.file = parsed.path;
        job.r2Key = parsed.r2Key;
        job.checkpoint = parsed.checkpoint;
      } catch { job.status = 'failed'; job.error = 'Invalid worker response'; }
    }
    active = null; restoreMode = false;
    await safeWrite().catch(() => {});
  };
  child.on('error', () => { void finish(false); });
  child.on('close', code => { if (active === id) void finish(code === 0); });
  return job;
}
export const isBackupRestoreRunning = () => restoreMode;

export async function initializeBackupScheduler() {
  if (!path.isAbsolute(root)) return;
  await fs.mkdir(archiveFolder, { recursive: true, mode: 0o700 });
  await fs.mkdir(incomingFolder, { recursive: true, mode: 0o700 });
  try { await fs.writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (err: any) { if (err.code !== 'EEXIST') throw err; }
  try {
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (!Array.isArray(saved.jobs) || !Array.isArray(saved.accounts)) throw new Error('Invalid state');
    state = saved;
    for (const j of state.jobs) if (j.status === 'running') { j.status = 'failed'; j.error = 'Interrupted by server restart'; }
  } catch (err: any) { if (err.code !== 'ENOENT') throw err; }
  await safeWrite();
  if (state.schedule.enabled) {
    if (state.schedule.nextAt < Date.now()) state.schedule.nextAt = Date.now() + 60_000;
    scheduleNext();
  }
}

type Auth = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
function error(res: Response, code: string, status = 400) { res.status(status).set('Cache-Control', 'no-store').json({ error: code }); }
export function registerBackupRoutes(router: Router, auth: Auth) {
  router.get('/backup/status', auth, (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      accounts: state.accounts.map(publicAccount),
      schedule: state.schedule,
      jobs: state.jobs.map(j => ({ ...j, file: j.file ? Boolean(j.file) : false })),
      recoveryKeySaved: state.recoveryDownloaded,
      busy: Boolean(active),
    });
  });
  router.get('/backup/recovery-key', auth, async (_req, res) => {
    try {
      const secret = await key();
      state.recoveryDownloaded = true;
      await safeWrite();
      res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="licenx-recovery.key"', 'Content-Type': 'application/octet-stream' }).send(secret);
    } catch { error(res, 'RECOVERY_KEY_UNAVAILABLE', 500); }
  });
  router.post('/backup/recovery-key/import', auth, async (req, res) => {
    if (active || state.accounts.length || state.jobs.some(j => j.status === 'completed') ||
        state.schedule.enabled || (await fs.readdir(archiveFolder)).length) return error(res, 'KEY_IMPORT_REQUIRES_FRESH_INSTALL', 409);
    if (req.headers['content-type'] !== 'application/octet-stream') return error(res, 'INVALID_KEY_CONTENT_TYPE');
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of req) {
        const chunk = Buffer.from(raw);
        size += chunk.length;
        if (size > 32) throw new Error('Invalid key');
        chunks.push(chunk);
      }
      if (size !== 32) throw new Error('Invalid key length');
      const tmp = keyFile + '-' + randomUUID();
      await fs.writeFile(tmp, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, keyFile);
      state.recoveryDownloaded = true;
      await safeWrite();
      res.json({ success: true });
    } catch { error(res, 'INVALID_RECOVERY_KEY'); }
  });
  router.post('/backup/accounts', auth, async (req, res) => {
    try {
      const input = cleanAccount(req.body);
      if (!input.secretAccessKey) return error(res, 'SECRET_REQUIRED');
      const acc: Account = { id: randomUUID().replaceAll('-', ''), name: input.name, accountId: input.accountId,
        accessKeyId: input.accessKeyId, bucketName: input.bucketName, secret: await seal(input.secretAccessKey) };
      state.accounts.push(acc); await safeWrite();
      res.json({ success: true, account: publicAccount(acc) });
    } catch { error(res, 'INVALID_ACCOUNT_CONFIG'); }
  });
  router.put('/backup/accounts/:id', auth, async (req, res) => {
    try {
      const acc = state.accounts.find(a => a.id === req.params.id);
      if (!acc) return error(res, 'ACCOUNT_NOT_FOUND', 404);
      const input = cleanAccount(req.body);
      const sealed = input.secretAccessKey ? await seal(input.secretAccessKey) : acc.secret;
      Object.assign(acc, { name: input.name, accountId: input.accountId, accessKeyId: input.accessKeyId, bucketName: input.bucketName, secret: sealed });
      await safeWrite(); res.json({ success: true, account: publicAccount(acc) });
    } catch { error(res, 'INVALID_ACCOUNT_CONFIG'); }
  });
  router.post('/backup/accounts/:id/test', auth, async (req, res) => {
    const acc = state.accounts.find(a => a.id === req.params.id);
    if (!acc) return error(res, 'ACCOUNT_NOT_FOUND', 404);
    try { res.json(await testR2Connection(await accountConfig(acc))); }
    catch { error(res, 'R2_TEST_FAILED', 502); }
  });
  router.post('/backup/schedule', auth, async (req, res) => {
    try {
      const enabled = req.body?.enabled === true;
      const intervalHours = Number(req.body?.intervalHours);
      const destination = String(req.body?.destination || 'local');
      if (![1, 6, 12, 24, 168].includes(intervalHours) || (destination !== 'local' && !state.accounts.some(a => 'r2:' + a.id === destination))) return error(res, 'INVALID_SCHEDULE');
      if (enabled && !state.recoveryDownloaded) return error(res, 'RECOVERY_KEY_DOWNLOAD_REQUIRED', 409);
      state.schedule = { enabled, intervalHours, destination, nextAt: enabled ? Date.now() + intervalHours * 3600_000 : 0 };
      await safeWrite(); scheduleNext(); res.json({ success: true, schedule: state.schedule });
    } catch { error(res, 'SCHEDULE_SAVE_FAILED', 500); }
  });
  router.post('/backup/run', auth, async (req, res) => {
    try { const job = await startJob('backup', String(req.body?.destination || 'local')); res.status(202).json({ job }); }
    catch { error(res, 'BACKUP_UNAVAILABLE', 409); }
  });
  router.get('/backup/download/:id', auth, (req, res) => {
    const job = state.jobs.find(j => j.id === req.params.id && j.action === 'backup' && j.status === 'completed');
    if (!job?.file || !validId(job.id)) return error(res, 'BACKUP_NOT_FOUND', 404);
    const filename = path.join(archiveFolder, job.id + '.lxbackup');
    res.set('Cache-Control', 'private, no-store');
    res.download(filename, 'licenx-' + job.id + '.lxbackup', err => { if (err && !res.headersSent) error(res, 'BACKUP_FILE_UNAVAILABLE', 404); });
  });
  router.post('/backup/restore/upload', auth, async (req, res) => {
    if (active) return error(res, 'JOB_RUNNING', 409);
    if (req.headers['content-type'] !== 'application/octet-stream') return error(res, 'CONTENT_TYPE_REQUIRED');
    const id = 'input_' + randomUUID().replaceAll('-', '');
    const file = path.join(incomingFolder, id + '.lxbackup');
    let count = 0;
    try {
      await pipeline(req, new Transform({ transform(chunk, _enc, cb) {
        count += chunk.length;
        cb(count > MAX_UPLOAD ? new Error('File too large') : null, chunk);
      }}), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      if (count < 36) throw new Error('Invalid backup');
      res.status(201).json({ fileId: id, size: count });
    } catch { await fs.rm(file, { force: true }).catch(() => {}); error(res, 'INVALID_BACKUP_UPLOAD'); }
  });
  router.post('/backup/restore/start', auth, async (req, res) => {
    const fileId = String(req.body?.fileId || '');
    if (!validId(fileId) || !fileId.startsWith('input_') || req.body?.confirmation !== 'RESTORE LICENX') return error(res, 'RESTORE_CONFIRMATION_REQUIRED');
    if (typeof req.body?.currentPassword !== 'string' || req.body.currentPassword.length > 512) return error(res, 'PASSWORD_VERIFICATION_REQUIRED', 403);
    try {
      const db = getDbClient();
      const row = (await db.execute('SELECT password_hash FROM admin_config LIMIT 1')).rows[0];
      if (!row || !verifyPassword(req.body.currentPassword, String(row.password_hash || ''))) {
        return error(res, 'PASSWORD_VERIFICATION_FAILED', 403);
      }
    } catch { return error(res, 'PASSWORD_VERIFICATION_FAILED', 403); }
    const file = path.join(incomingFolder, fileId + '.lxbackup');
    try { if (!(await fs.stat(file)).isFile()) return error(res, 'RESTORE_INPUT_NOT_FOUND', 404); }
    catch { return error(res, 'RESTORE_INPUT_NOT_FOUND', 404); }
    try {
      const job = await startJob('restore', file);
      res.status(202).json({ job });
    } catch { error(res, 'RESTORE_UNAVAILABLE', 409); }
  });
  router.post('/backup/restore/r2', auth, async (req, res) => {
    const acc = state.accounts.find(a => a.id === req.body?.accountId);
    const objectKey = String(req.body?.key || '');
    if (!acc || !/^licenx-full-backups\/[a-zA-Z0-9_.-]+\.lxbackup$/.test(objectKey) || active) return error(res, 'INVALID_R2_RESTORE');
    const id = 'input_' + randomUUID().replaceAll('-', '');
    const file = path.join(incomingFolder, id + '.lxbackup');
    try {
      const client = getR2Client(await accountConfig(acc));
      const object = await client.send(new GetObjectCommand({ Bucket: acc.bucketName, Key: objectKey }));
      if (!object.Body || Number(object.ContentLength || 0) > MAX_UPLOAD) throw new Error('Invalid remote object');
      let count = 0;
      await pipeline(object.Body as any, new Transform({ transform(chunk, _enc, cb) {
        count += chunk.length; cb(count > MAX_UPLOAD ? new Error('Object too large') : null, chunk);
      }}), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      if (count < 36) throw new Error('Invalid remote backup');
      res.status(201).json({ fileId: id, size: count });
    } catch { await fs.rm(file, { force: true }).catch(() => {}); error(res, 'R2_RESTORE_DOWNLOAD_FAILED', 502); }
  });
}
