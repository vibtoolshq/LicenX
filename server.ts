import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { initDatabaseSchema, getDbClient } from './src/server/db.js';
import { apiRouter, requireAdminAuth } from './src/server/api.js';
import { registerBackupRoutes, initializeBackupScheduler, isBackupRestoreRunning } from './src/server/backupControl.js';

dotenv.config();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.LOCAL_STORAGE_PATH ?? '';
registerBackupRoutes(apiRouter, requireAdminAuth);
const isProduction = process.env.NODE_ENV === 'production';
const trustedProxy = process.env.TRUSTED_PROXY_IP;
if (trustedProxy) app.set('trust proxy', trustedProxy);

let ready = false;
let shuttingDown = false;
const requestId = () => crypto.randomUUID();
const fail = (res: express.Response, status: number, code: string, id: string) =>
  res.status(status).set('Cache-Control', 'no-store').json({ error: code, requestId: id });
const live = (_req: express.Request, res: express.Response) =>
  res.set('Cache-Control', 'no-store').json({ status: 'online', system: 'VCON License Engine', time: Date.now() });
const readiness = async (_req: express.Request, res: express.Response) => {
  if (!ready || shuttingDown || isBackupRestoreRunning()) return res.status(503).set('Cache-Control', 'no-store').json({ status: 'not_ready' });
  try {
    await getDbClient().execute('SELECT 1');
    if (process.env.STORAGE_PROVIDER === 'local') {
      if (!path.isAbsolute(storageRoot)) throw new Error('storage');
      const stat = await fs.stat(storageRoot);
      if (!stat.isDirectory()) throw new Error('storage');
      await fs.access(storageRoot, (await import('node:fs')).constants.R_OK | (await import('node:fs')).constants.W_OK);
    }
    return res.set('Cache-Control', 'no-store').json({ status: 'ready' });
  } catch {
    return res.status(503).set('Cache-Control', 'no-store').json({ status: 'not_ready' });
  }
};
app.get('/api/health', live);
app.get('/api/ready', readiness);
// Bound payloads before the general 20 MiB parser; never preflight-authorize browser callers.
app.use('/api/v1/public/license/check', express.json({ limit: '1kb' }));
app.options('/api/v1/public/license/check', (_req, res) => res.status(405).set('Allow', 'POST').set('Cache-Control', 'no-store').json({code: 'METHOD_NOT_ALLOWED'}));
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(['/api', '/v1'], (_req, res, next) => {
  if (isBackupRestoreRunning() && !_req.path.startsWith('/backup/')) {
    return res.status(503).set('Cache-Control', 'no-store').json({ error: 'RESTORE_IN_PROGRESS' });
  }
  next();
});
app.use('/api', apiRouter);
app.use('/v1', (req, res, next) => { req.url = '/v1' + req.url; apiRouter(req, res, next); });
app.use(['/api', '/v1'], (req, res) => fail(res, 404, 'NOT_FOUND', requestId()));
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const id = requestId();
  if (res.headersSent) return;
  const status = err?.type === 'entity.too.large' ? 413 :
    (err instanceof SyntaxError && 'body' in err) ? 400 : 500;
  if (status === 500) console.error('[LicenX] Unexpected API failure', id);
  fail(res, status, status === 400 ? 'INVALID_JSON' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR', id);
};

async function main() {
  await initDatabaseSchema();
  if (process.env.STORAGE_PROVIDER === 'local') {
    if (!path.isAbsolute(storageRoot)) throw new Error('LOCAL_STORAGE_PATH must be absolute');
    await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
    await fs.access(storageRoot, (await import('node:fs')).constants.R_OK | (await import('node:fs')).constants.W_OK);
    if (process.env.DATABASE_PROVIDER === 'postgres') await initializeBackupScheduler();
  }
  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(root, 'dist');
    await fs.access(path.join(dist, 'index.html'));
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  const server = app.listen(port, '0.0.0.0', () => {
    ready = true;
    console.log('[LicenX] Server listening on port', port);
  });
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    server.close(async () => {
      try { await getDbClient().close(); process.exit(0); }
      catch { process.exit(1); }
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch(() => {
  console.error('[LicenX] Production startup failed (check database, storage, and build configuration)');
  process.exit(1);
});
