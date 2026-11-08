import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createEngine } from '../engine/socketcore/index.js';
import { DEFAULT_LIMITS } from '../engine/socketcore/config.js';

function handshakeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 1500 });
    socket.once('open', () => {
      socket.close();
      resolve(101);
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', reject);
  });
}

test('WS-01 transport is gated OFF by default and ships no license grant', () => {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.LICENX_REALTIME_TRANSPORT_ENABLED === 'true'/);
  assert.match(source, /path: '\/api\/realtime'/);
  assert.match(source, /authenticate: async \(\) => null/);
  assert.match(source, /authorizeSubscription: async \(\) => false/);

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.dependencies.ws, /^8\.\d+\.\d+$/);
  assert.equal(DEFAULT_LIMITS.maxGlobalMessagesPerSecond, 500);
  assert.equal(DEFAULT_LIMITS.maxTotalBufferedBytes, 64 * 1024 * 1024);
});

test('WS-01 ESM transport refuses upgrades, preserves other paths, and drains', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('existing-http-unchanged');
  });
  const engine = createEngine({
    path: '/api/realtime',
    authenticate: async () => null,
    authorizeSubscription: async () => false,
    limits: { maxPendingUpgrades: 128 },
    timeouts: { shutdownDrainMs: 3000 },
  });
  const unsubscribe = engine.attach(server);
  engine.start();

  server.on('upgrade', (req, socket) => {
    if (req.url === '/different-service') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing test server port');
    const base = '127.0.0.1:' + addr.port;

    assert.equal(await handshakeStatus('ws://' + base + '/api/realtime'), 401);
    assert.equal(await handshakeStatus('ws://' + base + '/different-service'), 404);
    assert.equal(engine.connectionManager.size(), 0);

    const res = await fetch('http://' + base + '/api/health');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'existing-http-unchanged');
    await engine.stop();
    assert.equal(engine.connectionManager.size(), 0);
  } finally {
    unsubscribe();
    await engine.stop();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
  }
});
