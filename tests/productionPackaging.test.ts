import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

test('production build emits a Node entry without tsx runtime', () => {
  const scripts = JSON.parse(source('package.json')).scripts;
  assert.match(scripts.build, /build:server/);
  assert.equal(scripts.start, 'node build/server.js');
  assert.match(scripts['build:server'], /--platform=node/);
  assert.ok(!scripts.start.includes('tsx'));
});

test('container does not expose database, credentials or private data and runs nonroot', () => {
  const ignore = source('.dockerignore');
  const docker = source('Dockerfile');
  assert.match(ignore, /\*\*\/\*\.db/);
  assert.match(ignore, /\*\*\/notes\//);
  assert.match(ignore, /\*\*\/\.env\*/);
  assert.match(ignore, /\*\*\/\.git\//);
  assert.match(docker, /USER node/);
  assert.match(docker, /npm ci --omit=dev/);
  assert.match(docker, /build\/server\.js/);
  assert.doesNotMatch(docker, /COPY\s+vcon_data\.db/i);
});

test('compose isolates PostgreSQL and persists database/storage/TLS files', () => {
  const compose = source('compose.yaml');
  assert.match(compose, /internal:\s*true/);
  assert.match(compose, /postgres-data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /app-storage:\/var\/lib\/licenx\/storage/);
  assert.match(compose, /caddy-data:\/data/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /condition:\s*service_healthy/);
  assert.doesNotMatch(compose, /5432:5432/);
  assert.match(compose, /TRUSTED_PROXY_IP:/);
  assert.match(compose, /profiles: \[standalone-https\]/);
  assert.match(compose, /name: licenx_frontend/);
});

test('standalone HTTPS configuration keeps proxy and request-origin boundaries', () => {
  const caddy = source('deploy/Caddyfile');
  const server = source('server.ts');
  assert.match(caddy, /reverse_proxy app:3000/);
  assert.match(caddy, /X-Forwarded-Proto/);
  assert.match(server, /app\.set\('trust proxy', trustedProxy\)/);
  assert.match(server, /app\.get\('\/api\/ready', readiness\)/);
  assert.match(server, /shuttingDown/);
  assert.match(server, /PAYLOAD_TOO_LARGE/);
  assert.match(server, /INVALID_JSON/);
});
