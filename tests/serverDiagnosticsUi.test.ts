import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ServerDiagnosticsTab, formatServerDiagnosticsReport,
} from '../src/components/ServerDiagnosticsTab.js';
import type { ServerDiagnosticsReport } from '../src/types.js';

const source = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('SD-01: Administration Server navigation is strictly additive', () => {
  assert.match(source('src/App.tsx'), /'server',/);
  assert.match(source('src/App.tsx'), /path === '\/vcon\/server'/);
  assert.match(source('src/App.tsx'), /activeTab === 'server' && <ServerDiagnosticsTab \/>/);
  assert.match(source('src/components/Sidebar.tsx'), /id: 'server',\s*label: 'Server'/);
  assert.match(source('src/components/HeaderBar.tsx'), /server: 'Server Diagnostics'/);
  assert.match(source('src/types.ts'), /\| "server"/);
  assert.match(source('src/App.tsx'), /activeTab === 'backup' && <BackupTab \/>/);
  assert.match(source('src/App.tsx'), /activeTab === 'live-monitor' && <LiveMonitorTab \/>/);
});

test('SD-01: UI renders Run Tests and Copy Report but never auto-runs or starts a second socket', () => {
  const html = renderToStaticMarkup(React.createElement(ServerDiagnosticsTab));
  assert.match(html, /Server Diagnostics/);
  assert.match(html, /Run Tests/);
  assert.match(html, /Copy Report/);
  assert.match(html, /No automatic background tests/);
  const file = source('src/components/ServerDiagnosticsTab.tsx');
  assert.match(file, /api\.runServerDiagnostics\(\)/);
  assert.match(file, /api\.getFullBackupStatus\(\)/);
  assert.match(file, /j\.destination\.startsWith\('r2:'\)/);
  assert.match(file, /latestR2\.r2Key/);
  assert.match(file, /adminRealtime\.getStatus\(\)/);
  assert.match(file, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(file, /new WebSocket|setInterval|docker exec|spawn\(|child_process|runFullBackup|startFullRestore/);
});

test('SD-01: copied report preserves only sanitized test result statuses and the scope limitation', () => {
  const report: ServerDiagnosticsReport = {
    startedAt: 1800000000000, finishedAt: 1800000000200,
    checks: [
      { id: 'api_ready', label: 'API readiness', state: 'PASS', detail: 'HTTP 200', durationMs: 42 },
      { id: 'admin_ws_auth', label: 'Admin WSS protection', state: 'SKIPPED', detail: 'Admin WebSocket disabled by configuration', durationMs: 0 },
    ],
    summary: { pass: 1, fail: 0, warn: 0, skipped: 1 },
  };
  const text = formatServerDiagnosticsReport(report);
  assert.match(text, /1 PASS, 0 FAIL, 0 WARN, 1 SKIPPED/);
  assert.match(text, /\[SKIPPED\] Admin WSS protection/);
  assert.match(text, /No Docker host or disaster-recovery certification/);
  assert.doesNotMatch(text, /password|session cookie|bearer token/i);
});
