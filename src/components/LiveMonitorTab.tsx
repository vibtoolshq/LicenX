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

      <p className="text-[11px] leading-5 text-slate-500">
        Connection presence is a point-in-time Node gateway observation, not proof that
        a client application is running. HTTP fallback, reconnecting and offline-grace
        totals are not reported by this snapshot. Bound and stale counts must not be
        added to WebSocket counts as mutually exclusive groups.
      </p>
    </div>
  );
};
