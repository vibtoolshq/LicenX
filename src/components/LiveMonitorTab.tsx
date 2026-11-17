import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AppWindow, Clock3, Key, Laptop, RefreshCw, Wifi } from 'lucide-react';
import { adminRealtime, api } from '../services/apiClient';
import type { AdminRealtimeState, RealtimePresenceReport, SystemStats } from '../types';

const SNAPSHOT_FRESH_MS = 60_000;
const REFRESH_MS = 30_000;

type MonitorHealth = 'live' | 'disabled' | 'stale' | 'unavailable';
type MonitorMetrics = {
  health: MonitorHealth;
  connected: string;
  sockets: string;
  bound: string;
  stale: string;
  observedAt: number | null;
};

function count(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString('en-US') : 'Unknown';
}

/** Only authenticated, fresh global Node snapshots can be shown as live. */
export function getLiveMonitorMetrics(
  report: RealtimePresenceReport | null,
  now = Date.now(),
): MonitorMetrics {
  const unknown: MonitorMetrics = {
    health: 'unavailable', connected: 'Unknown', sockets: 'Unknown',
    bound: 'Unknown', stale: 'Unknown', observedAt: null,
  };
  if (!report || typeof report !== 'object' || report.scope !== null ||
      (report.transportEnabled !== true && report.transportEnabled !== false)) return unknown;
  const observedAt = report.observedAt;
  if (typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt <= 0 ||
      observedAt > now + 5_000) return unknown;
  if (now - observedAt >= SNAPSHOT_FRESH_MS) {
    return { ...unknown, health: 'stale', observedAt };
  }
  return {
    health: report.transportEnabled ? 'live' : 'disabled',
    connected: report.transportEnabled ? count(report.connectedNow) : 'Unknown',
    sockets: report.transportEnabled ? count(report.activeSockets) : 'Unknown',
    bound: count(report.boundActive),
    stale: count(report.staleBound),
    observedAt,
  };
}

export function isMonitorAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  return error.status === 401 || error.status === 403;
}

interface MetricCardProps {
  title: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}

const MetricCard: React.FC<MetricCardProps> = ({ title, value, hint, icon }) => (
  <div className="rounded border border-slate-800/80 bg-slate-900/40 p-3 min-w-0">
    <div className="flex items-center justify-between gap-2 text-slate-400">
      <span className="text-[10px] font-medium uppercase tracking-wider">{title}</span>
      <span className="text-indigo-400/80">{icon}</span>
    </div>
    <div className="mt-1 font-mono text-lg font-semibold text-slate-200" aria-label={title}>
      {value}
    </div>
    <div className="mt-1 text-[10px] leading-4 text-slate-500">{hint}</div>
  </div>
);


type AppFilter = 'all' | 'active' | 'inactive';
type AppConnectionRow = {
  id: string;
  name: string;
  status: string;
  metrics: MonitorMetrics;
  unavailable: boolean;
};
type AppConnectionPage = { rows: AppConnectionRow[]; total: number };
type AppConnectionSource = {
  getApps: (params: { limit: number; offset: number; status?: string }, force: boolean) =>
    Promise<{ apps: { id: string; display_name: string; status: string }[]; total: number }>;
  getRealtimePresence: (params: { appId: string }) => Promise<RealtimePresenceReport>;
};
const APP_PAGE_SIZE = 10;
const APP_REQUEST_CONCURRENCY = 2;

export function getAppMonitorMetrics(
  appId: string,
  report: RealtimePresenceReport | null,
  now = Date.now(),
): MonitorMetrics {
  if (!appId || !report || report.scope !== appId) return getLiveMonitorMetrics(null, now);
  return getLiveMonitorMetrics({ ...report, scope: null }, now);
}

/** Bounded page of independently scoped snapshots; never inferred as global totals. */
export async function fetchAppConnectionPage(
  page: number,
  filter: AppFilter,
  source: AppConnectionSource = api,
  cancelled: () => boolean = () => false,
  now = Date.now(),
): Promise<AppConnectionPage | null> {
  const offset = (page - 1) * APP_PAGE_SIZE;
  const result = await source.getApps({
    limit: APP_PAGE_SIZE, offset,
    status: filter === 'all' ? undefined : filter,
  }, true);
  if (cancelled()) return null;
  if (!Number.isSafeInteger(result.total) || result.total < 0 ||
      !Array.isArray(result.apps) || result.apps.length > APP_PAGE_SIZE) {
    throw new Error('Invalid app page response');
  }
  const rows: AppConnectionRow[] = [];
  for (let i = 0; i < result.apps.length; i += APP_REQUEST_CONCURRENCY) {
    if (cancelled()) return null;
    const pair = result.apps.slice(i, i + APP_REQUEST_CONCURRENCY);
    const answers = await Promise.allSettled(pair.map(app =>
      /^[A-Za-z0-9_-]{1,128}$/.test(app.id)
        ? source.getRealtimePresence({ appId: app.id })
        : Promise.reject(new Error('Invalid app scope')),
    ));
    if (cancelled()) return null;
    for (let j = 0; j < pair.length; j++) {
      const app = pair[j];
      const answer = answers[j];
      if (answer.status === 'rejected' && isMonitorAuthFailure(answer.reason)) {
        throw answer.reason;
      }
      const report = answer.status === 'fulfilled' ? answer.value : null;
      const metrics = getAppMonitorMetrics(app.id, report, now);
      rows.push({
        id: app.id,
        name: app.display_name || app.id,
        status: app.status,
        metrics,
        unavailable: answer.status === 'rejected' || metrics.health === 'unavailable',
      });
    }
  }
  return { rows, total: result.total };
}

/** Isolated app-table lifecycle: the LM-P01 global snapshot remains untouched. */
const ApplicationConnections: React.FC = () => {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<AppFilter>('all');
  const [rows, setRows] = useState<AppConnectionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const authBlocked = useRef(false);
  const visibleAppIds = useRef(new Set<string>());
  const currentJob = useRef<Promise<void> | null>(null);

  const refreshApps = useCallback(() => {
    if (!mounted.current || authBlocked.current ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    const serial = ++generation.current;
    setLoading(true);
    setRows([]);
    setUnavailable(false);
    visibleAppIds.current.clear();
    // Serialize generations: even rapid filter/page changes cannot exceed two in-flight app requests.
    const previous = currentJob.current;
    const job = (async () => {
      if (previous) await previous;
      if (!mounted.current || serial !== generation.current || authBlocked.current ||
          (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      try {
        const data = await fetchAppConnectionPage(page, filter, api,
          () => !mounted.current || serial !== generation.current || authBlocked.current);
        if (!data || !mounted.current || serial !== generation.current || authBlocked.current) return;
        setRows(data.rows);
        visibleAppIds.current = new Set(data.rows.map(row => row.id));
        setTotal(data.total);
        setLastSuccessAt(Date.now());
      } catch (error) {
        if (!mounted.current || serial !== generation.current || authBlocked.current) return;
        if (isMonitorAuthFailure(error)) {
          authBlocked.current = true;
          setAuthExpired(true);
        }
        setUnavailable(true);
        setRows([]);
        setTotal(0);
        visibleAppIds.current.clear();
      } finally {
        if (mounted.current && serial === generation.current) setLoading(false);
      }
    })();
    currentJob.current = job;
  }, [page, filter]);

  useEffect(() => {
    mounted.current = true;
    if (adminRealtime.getStatus().state === 'AUTH_EXPIRED') {
      authBlocked.current = true;
      setAuthExpired(true);
      setLoading(false);
    } else {
      void refreshApps();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = adminRealtime.subscribe(notice => {
      if (notice.type === 'state') {
        if (notice.state === 'AUTH_EXPIRED') {
          authBlocked.current = true;
          generation.current++;
          setAuthExpired(true);
          setRows([]);
          setTotal(0);
          visibleAppIds.current.clear();
          setLoading(false);
        }
        return;
      }
      const relevant = notice.type === 'resync' || (notice.type === 'change' && (
        notice.change.type === 'presence.changed'
          ? (notice.change.app_id === null || visibleAppIds.current.has(notice.change.app_id))
          : notice.change.type === 'resource.changed' &&
            ['apps', 'devices', 'licenses', 'stats'].includes(notice.change.resource) &&
            (notice.change.app_id === null || visibleAppIds.current.has(notice.change.app_id))
      ));
      if (relevant && !authBlocked.current) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { void refreshApps(); }, 250);
      }
    });
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refreshApps();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void refreshApps();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      generation.current++;
      unsubscribe();
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshApps]);

  const totalPages = Math.max(1, Math.ceil(total / APP_PAGE_SIZE));
  const observed = lastSuccessAt ? new Date(lastSuccessAt).toLocaleTimeString() : 'Not yet verified';

  return (
    <section className="rounded border border-slate-800/80 bg-slate-900/30 p-3 space-y-3" aria-label="Application connections">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-slate-200">Application Connections</h3>
          <p className="text-[10px] text-slate-500">
            Each row is a separate app-scoped snapshot · not a global total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="live-monitor-filter" className="text-[10px] text-slate-500">App status</label>
          <select id="live-monitor-filter" value={filter}
            onChange={event => {
              setFilter(event.target.value as AppFilter);
              setPage(1);
            }}
            className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-200">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>
      {authExpired ? <p role="status" className="text-amber-400">Admin session expired · app connection data unavailable</p> :
        unavailable ? <p role="status" className="text-amber-400">App connection data unavailable · last verified: {observed}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-left text-[11px]">
          <thead className="border-b border-slate-800 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-3">Application</th>
              <th scope="col" className="py-2 px-2">WS devices</th>
              <th scope="col" className="py-2 px-2">Sockets</th>
              <th scope="col" className="py-2 px-2">Bound</th>
              <th scope="col" className="py-2 px-2">Stale lease</th>
              <th scope="col" className="py-2 pl-2">Snapshot</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {rows.map(row => (
              <tr key={row.id} className="text-slate-300">
                <td className="py-2 pr-3">
                  <div className="font-medium">{row.name}</div>
                  <div className="text-[10px] text-slate-500">{row.status}</div>
                </td>
                <td className="py-2 px-2 font-mono">{row.metrics.connected}</td>
                <td className="py-2 px-2 font-mono">{row.metrics.sockets}</td>
                <td className="py-2 px-2 font-mono">{row.metrics.bound}</td>
                <td className="py-2 px-2 font-mono">{row.metrics.stale}</td>
                <td className="py-2 pl-2 text-[10px] text-slate-500">
                  {row.unavailable ? 'Unavailable' :
                    row.metrics.health === 'disabled' ? 'WS disabled' :
                    row.metrics.health === 'stale' ? 'Stale' :
                    row.metrics.health === 'live' ? 'Verified' : 'Unknown'}
                  <div>{row.metrics.observedAt
                    ? new Date(row.metrics.observedAt).toLocaleTimeString() : 'No verified time'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p role="status" className="py-3 text-center text-slate-500">Loading app snapshots…</p>}
        {!loading && !unavailable && !authExpired && rows.length === 0 &&
          <p className="py-3 text-center text-slate-500">No applications in this filter</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>{unavailable || authExpired ? 'App totals unavailable' :
          'Applications: ' + total.toLocaleString('en-US')} · Last verified: {observed}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1 || loading || authExpired || unavailable}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            className="rounded border border-slate-800 px-2 py-1 disabled:opacity-40">Previous</button>
          <span>Page {page} / {unavailable ? 'Unknown' : totalPages}</span>
          <button type="button" disabled={page >= totalPages || loading || authExpired || unavailable}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            className="rounded border border-slate-800 px-2 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>
    </section>
  );
};

export const LiveMonitorTab: React.FC = () => {
  const [presence, setPresence] = useState<RealtimePresenceReport | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [presenceError, setPresenceError] = useState(false);
  const [statsError, setStatsError] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [browserState, setBrowserState] = useState<AdminRealtimeState>(adminRealtime.getStatus().state);
  const mounted = useRef(false);
  const requestSerial = useRef(0);
  const authBlocked = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current || authBlocked.current ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    const serial = ++requestSerial.current;
    setLoading(true);
    const [presenceResult, statsResult] = await Promise.allSettled([
      api.getRealtimePresence(),
      api.getStats(true),
    ]);
    if (!mounted.current || serial !== requestSerial.current || authBlocked.current) return;
    const denied = (presenceResult.status === 'rejected' && isMonitorAuthFailure(presenceResult.reason)) ||
      (statsResult.status === 'rejected' && isMonitorAuthFailure(statsResult.reason));
    if (denied) {
      authBlocked.current = true;
      setAuthExpired(true);
      setPresence(null);
      setStats(null);
      setPresenceError(true);
      setStatsError(true);
    } else {
      const freshPresence = presenceResult.status === 'fulfilled' ? presenceResult.value : null;
      const freshStats = statsResult.status === 'fulfilled' ? statsResult.value : null;
      setPresence(freshPresence);
      setStats(freshStats);
      setPresenceError(!freshPresence);
      setStatsError(!freshStats);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initialState = adminRealtime.getStatus().state;
    if (initialState === 'AUTH_EXPIRED') {
      authBlocked.current = true;
      setAuthExpired(true);
      setLoading(false);
    } else {
      void refresh();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = adminRealtime.subscribe(notice => {
      if (notice.type === 'state') {
        setBrowserState(notice.state);
        if (notice.state === 'AUTH_EXPIRED') {
          authBlocked.current = true;
          requestSerial.current++;
          setAuthExpired(true);
          setPresence(null);
          setStats(null);
          setLoading(false);
        }
        return;
      }
      const relevant = notice.type === 'resync' || (
        notice.type === 'change' && (
          notice.change.type === 'presence.changed' ||
          (notice.change.type === 'resource.changed' &&
            ['stats', 'devices', 'licenses', 'apps'].includes(notice.change.resource))
        )
      );
      if (relevant && !authBlocked.current) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { void refresh(); }, 250);
      }
    });
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh();
    }, REFRESH_MS);
    return () => {
      mounted.current = false;
      requestSerial.current++;
      unsubscribe();
      if (timer) clearTimeout(timer);
      clearInterval(interval);
    };
  }, [refresh]);

  const metrics = getLiveMonitorMetrics(authExpired ? null : presence);
  const healthText = authExpired ? 'Admin session expired' :
    presenceError ? 'Presence snapshot unavailable' :
    metrics.health === 'live' ? 'Verified Node WebSocket snapshot' :
    metrics.health === 'disabled' ? 'SDK WebSocket transport disabled / WS metrics unavailable' :
    metrics.health === 'stale' ? 'Presence snapshot stale' : 'Presence snapshot unavailable';
  const observed = metrics.observedAt
    ? new Date(metrics.observedAt).toLocaleTimeString() : 'No verified snapshot';
  const statCount = (value: number | undefined) => authExpired || statsError ? 'Unknown' : count(value);

  return (
    <div className="space-y-3 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Live Client Monitor</h2>
          <p className="text-[11px] text-slate-500">Read-only connection and lease snapshot · all applications</p>
        </div>
        <button type="button" onClick={() => { void refresh(); }}
          disabled={loading || authExpired}
          className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          aria-label="Refresh Live Monitor">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="rounded border border-slate-800/80 bg-slate-900/30 px-3 py-2 text-[11px]"
        role="status" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className={authExpired || presenceError || metrics.health !== 'live'
            ? 'text-amber-400' : 'text-emerald-400'}>{healthText}</span>
          <span className="text-slate-500">Observed: {observed} · Admin updates: {browserState}</span>
        </div>
        {statsError && <div className="mt-1 text-amber-400">System statistics unavailable</div>}
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <MetricCard title="WS Connected" value={metrics.connected}
          hint="Distinct devices with an open verified Node WebSocket"
          icon={<Wifi className="h-3.5 w-3.5" />} />
        <MetricCard title="WS Sockets" value={metrics.sockets}
          hint="Verified open sockets; may exceed device count"
          icon={<Activity className="h-3.5 w-3.5" />} />
        <MetricCard title="Bound Active" value={metrics.bound}
          hint="Valid active bindings; not a count of running apps"
          icon={<Laptop className="h-3.5 w-3.5" />} />
        <MetricCard title="Stale Leases" value={metrics.stale}
          hint="Expired lease timestamp; not confirmed offline"
          icon={<Clock3 className="h-3.5 w-3.5" />} />
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <MetricCard title="Applications" value={statCount(stats?.totalApps)}
          hint="Registered application records"
          icon={<AppWindow className="h-3.5 w-3.5" />} />
        <MetricCard title="Active Keys" value={statCount(stats?.activeLicenses)}
          hint="Licenses marked active; not online clients"
          icon={<Key className="h-3.5 w-3.5" />} />
        <MetricCard title="24h Requests" value={statCount(stats?.validations24h)}
          hint="Validation log requests in the previous 24 hours"
          icon={<Activity className="h-3.5 w-3.5" />} />
      </div>

      <ApplicationConnections />

      <p className="text-[11px] leading-5 text-slate-500">
        Connection presence is a point-in-time Node gateway observation, not proof that
        a client application is running. HTTP fallback, reconnecting and offline-grace
        totals are not reported by this snapshot. Bound and stale counts must not be
        added to WebSocket counts as mutually exclusive groups.
      </p>
    </div>
  );
};
