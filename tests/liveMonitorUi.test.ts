import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getLiveMonitorMetrics, isMonitorAuthFailure, LiveMonitorTab } from '../src/components/LiveMonitorTab.js';
import type { RealtimePresenceReport } from '../src/types.js';

const now = 1_800_000_000_000;
const fixture: RealtimePresenceReport = {
  transportEnabled: true,
  connectedNow: 2,
  activeSockets: 3,
  boundActive: 8,
  staleBound: 1,
  connectedDeviceIds: [],
  observedAt: now - 1_000,
  scope: null,
};

const source = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('LM-P01: live Node presence counts remain distinct from bound and stale records', () => {
  assert.deepEqual(getLiveMonitorMetrics(fixture, now), {
    health: 'live',
    connected: '2',
    sockets: '3',
    bound: '8',
    stale: '1',
    observedAt: fixture.observedAt,
  });
  assert.equal(getLiveMonitorMetrics({ ...fixture, connectedNow: 0 }, now).connected, '0');
  assert.equal(getLiveMonitorMetrics({ ...fixture, activeSockets: -1 }, now).sockets, 'Unknown');
});

test('LM-P01: disabled SDK transport never labels absent sockets as offline clients', () => {
  const result = getLiveMonitorMetrics({ ...fixture, transportEnabled: false }, now);
  assert.equal(result.health, 'disabled');
  assert.equal(result.connected, 'Unknown');
  assert.equal(result.sockets, 'Unknown');
  assert.equal(result.bound, '8');
  assert.equal(result.stale, '1');
});

test('LM-P01: expired, missing, malformed and foreign-scope snapshots fail safe', () => {
  assert.equal(getLiveMonitorMetrics(null, now).connected, 'Unknown');
  const stale = getLiveMonitorMetrics({ ...fixture, observedAt: now - 60_000 }, now);
  assert.equal(stale.health, 'stale');
  assert.equal(stale.connected, 'Unknown');
  assert.equal(stale.bound, 'Unknown');
  assert.equal(getLiveMonitorMetrics({ ...fixture, observedAt: now + 7_000 }, now).health, 'unavailable');
  assert.equal(getLiveMonitorMetrics({ ...fixture, scope: 'another-app' }, now).health, 'unavailable');
  assert.equal(getLiveMonitorMetrics({ ...fixture, transportEnabled: undefined } as unknown as RealtimePresenceReport, now).health, 'unavailable');
  assert.equal(getLiveMonitorMetrics({ ...fixture, staleBound: Number.NaN }, now).stale, 'Unknown');
});

test('LM-P01: invalid Admin authorization never triggers open-ended refresh', () => {
  assert.equal(isMonitorAuthFailure({ status: 401 }), true);
  assert.equal(isMonitorAuthFailure({ status: 403 }), true);
  assert.equal(isMonitorAuthFailure({ status: 503 }), false);
  assert.equal(isMonitorAuthFailure(new Error('network')), false);
  assert.equal(isMonitorAuthFailure(null), false);
});

test('LM-P01: route, title and sidebar are registered additively', () => {
  const app = source('src/App.tsx');
  const sidebar = source('src/components/Sidebar.tsx');
  const header = source('src/components/HeaderBar.tsx');
  const types = source('src/types.ts');
  assert.match(app, /import \{ LiveMonitorTab \} from '\.\/components\/LiveMonitorTab'/);
  assert.match(app, /'live-monitor',/);
  assert.match(app, /path === '\/vcon\/live-monitor'/);
  assert.match(app, /activeTab === 'live-monitor' && <LiveMonitorTab \/>/);
  assert.match(sidebar, /id: 'live-monitor',\s*label: 'Live Monitor'/);
  assert.match(header, /'live-monitor': 'Live Monitor'/);
  assert.match(types, /\| "live-monitor"/);
  assert.match(app, /activeTab === 'overview'/);
  assert.match(app, /activeTab === 'devices'/);
});

test('LM-P01: initial UI and refresh lifecycle are read-only and bounded', () => {
  const html = renderToStaticMarkup(React.createElement(LiveMonitorTab));
  assert.match(html, /Live Client Monitor/);
  assert.match(html, /WS Connected/);
  assert.match(html, /WS Sockets/);
  assert.match(html, /Bound Active/);
  assert.match(html, /Stale Leases/);
  assert.match(html, /Unknown/);
  const component = source('src/components/LiveMonitorTab.tsx');
  assert.match(component, /api\.getRealtimePresence\(\)/);
  assert.match(component, /api\.getStats\(true\)/);
  assert.match(component, /adminRealtime\.subscribe\(/);
  assert.match(component, /document\.visibilityState === 'hidden'/);
  assert.match(component, /requestSerial\.current\+\+/);
  assert.match(component, /unsubscribe\(\)/);
  assert.match(component, /clearInterval\(interval\)/);
  assert.match(component, /clearTimeout\(timer\)/);
  assert.match(component, /authBlocked\.current = true/);
  assert.doesNotMatch(component, /new WebSocket|unbindDevice|logout\(|revokeLicense|api\.getDevices\(/);
});
