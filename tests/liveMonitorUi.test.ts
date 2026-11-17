import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fetchAppConnectionPage, getAppMonitorMetrics, getLiveMonitorMetrics, isMonitorAuthFailure, LiveMonitorTab } from '../src/components/LiveMonitorTab.js';
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

test('LM-P02: 25 apps use exactly three scoped server pages with at most two simultaneous requests', async () => {
  const apps = Array.from({ length: 25 }, (_, i) => ({
    id: 'app_' + i, display_name: 'Application ' + i, status: 'active',
  }));
  const observedPages: { limit: number; offset: number; status?: string; force: boolean }[] = [];
  const requestedIds: string[] = [];
  let activeRequests = 0;
  let maxActive = 0;
  const source = {
    getApps: async (params: { limit: number; offset: number; status?: string }, force: boolean) => {
      observedPages.push({ ...params, force });
      return { apps: apps.slice(params.offset, params.offset + params.limit), total: apps.length };
    },
    getRealtimePresence: async ({ appId }: { appId: string }) => {
      requestedIds.push(appId);
      activeRequests++;
      maxActive = Math.max(activeRequests, maxActive);
      await new Promise<void>(resolve => setImmediate(resolve));
      activeRequests--;
      return { ...fixture, scope: appId, connectedNow: 1 };
    },
  };
  const first = await fetchAppConnectionPage(1, 'active', source, () => false, now);
  const second = await fetchAppConnectionPage(2, 'all', source, () => false, now);
  const third = await fetchAppConnectionPage(3, 'all', source, () => false, now);
  assert.deepEqual([first?.rows.length, second?.rows.length, third?.rows.length], [10, 10, 5]);
  assert.deepEqual(observedPages.map(p => [p.limit, p.offset]), [[10, 0], [10, 10], [10, 20]]);
  assert.equal(observedPages[0].status, 'active');
  assert.ok(observedPages.every(p => p.force));
  assert.equal(maxActive, 2);
  assert.deepEqual(requestedIds, apps.map(app => app.id));
  assert.equal(first?.rows[0].metrics.connected, '1');
  assert.equal(first?.rows[0].metrics.bound, '8');
  assert.equal(first?.total, 25, 'server total is authoritative, not visible-page sum');
});

test('LM-P02: scoped App A never inherits App B, stale, or disabled WS values', () => {
  const correct = getAppMonitorMetrics('app_a', { ...fixture, scope: 'app_a' }, now);
  const mismatched = getAppMonitorMetrics('app_a', { ...fixture, scope: 'app_b' }, now);
  const stale = getAppMonitorMetrics('app_a',
    { ...fixture, scope: 'app_a', observedAt: now - 60_000 }, now);
  const disabled = getAppMonitorMetrics('app_a',
    { ...fixture, scope: 'app_a', transportEnabled: false }, now);
  assert.equal(correct.connected, '2');
  assert.equal(mismatched.health, 'unavailable');
  assert.equal(mismatched.connected, 'Unknown');
  assert.equal(stale.health, 'stale');
  assert.equal(stale.bound, 'Unknown');
  assert.equal(disabled.connected, 'Unknown');
  assert.equal(disabled.bound, '8');
});

test('LM-P02: per-row 429/503 errors are isolated; wrong scope stays Unknown', async () => {
  const source = {
    getApps: async () => ({ total: 4, apps: [
      { id: 'app_a', display_name: 'Alpha', status: 'active' },
      { id: 'app_b', display_name: 'Beta', status: 'active' },
      { id: 'app_c', display_name: 'Gamma', status: 'active' },
      { id: 'app_d', display_name: 'Delta', status: 'inactive' },
    ] }),
    getRealtimePresence: async ({ appId }: { appId: string }): Promise<RealtimePresenceReport> => {
      if (appId === 'app_b') throw { status: 503 };
      if (appId === 'app_c') throw { status: 429 };
      return { ...fixture, scope: appId === 'app_d' ? 'app_a' : appId };
    },
  };
  const page = await fetchAppConnectionPage(1, 'all', source, () => false, now);
  assert.equal(page?.rows[0].metrics.connected, '2');
  for (const row of page?.rows.slice(1) || []) {
    assert.equal(row.metrics.connected, 'Unknown');
    assert.equal(row.unavailable, true);
  }
});

test('LM-P02: cancellation stops later batches and authentication denial fails closed', async () => {
  const apps = Array.from({ length: 10 }, (_, i) => ({
    id: 'id_' + i, display_name: 'App ' + i, status: 'active',
  }));
  let cancelled = false;
  let requests = 0;
  const source = {
    getApps: async () => ({ apps, total: 10 }),
    getRealtimePresence: async ({ appId }: { appId: string }) => {
      requests++;
      cancelled = true;
      return { ...fixture, scope: appId };
    },
  };
  const aborted = await fetchAppConnectionPage(1, 'all', source, () => cancelled, now);
  assert.equal(aborted, null);
  assert.equal(requests, 2, 'only first already in-flight pair may finish');
  await assert.rejects(
    fetchAppConnectionPage(1, 'all', {
      getApps: async () => ({ apps: apps.slice(0, 1), total: 1 }),
      getRealtimePresence: async () => { throw { status: 403 }; },
    }, () => false, now),
    (error: unknown) => isMonitorAuthFailure(error),
  );
  await assert.rejects(
    fetchAppConnectionPage(1, 'all', {
      getApps: async () => { throw { status: 401 }; },
      getRealtimePresence: async () => fixture,
    }, () => false, now),
    (error: unknown) => isMonitorAuthFailure(error),
  );
});

test('LM-P02: app UI is isolated, visible-only, serial-guarded and cleans subscriptions', () => {
  const rendered = renderToStaticMarkup(React.createElement(LiveMonitorTab));
  assert.match(rendered, /Application Connections/);
  assert.match(rendered, /App status/);
  assert.match(rendered, /Page 1 \/ 1/);
  assert.match(rendered, /WS Connected/);
  assert.match(rendered, /Bound Active/);
  const component = source('src/components/LiveMonitorTab.tsx');
  assert.match(component, /limit: APP_PAGE_SIZE, offset/);
  assert.match(component, /APP_REQUEST_CONCURRENCY = 2/);
  assert.match(component, /source\.getRealtimePresence\(\{ appId: app\.id \}\)/);
  assert.match(component, /currentJob\.current = job/);
  assert.match(component, /serial !== generation\.current/);
  assert.match(component, /visibleAppIds\.current\.has\(notice\.change\.app_id\)/);
  assert.match(component, /document\.visibilityState === 'hidden'/);
  assert.match(component, /clearTimeout\(timer\)/);
  assert.match(component, /clearInterval\(interval\)/);
  assert.match(component, /removeEventListener\('visibilitychange', onVisible\)/);
  assert.doesNotMatch(component, /new WebSocket|api\.getDevices\(|unbindDevice|revokeLicense/);
});
