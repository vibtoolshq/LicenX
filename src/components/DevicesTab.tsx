import React, { useEffect, useState, useRef } from 'react';
import { Laptop, Search, Trash2, RefreshCw, Key } from 'lucide-react';
import { adminRealtime, api } from '../services/apiClient';
import { Device, RealtimePresenceReport } from '../types';
import { TablePagination } from './TablePagination';
import { useConfirm } from '../context/ConfirmContext';

export const DevicesTab: React.FC = () => {
  const confirm = useConfirm();
  const [devices, setDevices] = useState<Device[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [presence, setPresence] = useState<RealtimePresenceReport | null>(null);
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loadError, setLoadError] = useState('');
  const [realtimeState, setRealtimeState] = useState(adminRealtime.getStatus().state);
  const loadSerial = useRef(0);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(() => {
    try {
      const p = sessionStorage.getItem('vcon_devices_page');
      return p ? parseInt(p, 10) || 1 : 1;
    } catch {
      return 1;
    }
  });
  const [pageSize, setPageSize] = useState(20);

  // Persist pagination to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem('vcon_devices_page', String(currentPage));
    } catch {}
  }, [currentPage]);

  const loadDevices = async (force = false) => {
    const serial = ++loadSerial.current;
    try {
      if (devices.length === 0) setLoading(true);
      const res = await api.getDevices({
        search: appliedSearch || undefined,
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      }, force);
      if (serial !== loadSerial.current) return;
      const devList = res?.devices || (Array.isArray(res) ? (res as Device[]) : []);
      const list: Device[] = Array.isArray(devList) ? devList : [];
      const count = typeof res?.total === 'number' ? res.total : list.length;
      setDevices(list);
      setTotal(count);
      setLoadError('');
      if (currentPage > Math.max(1, Math.ceil(count / pageSize))) {
        setCurrentPage(Math.max(1, Math.ceil(count / pageSize)));
      }
    } catch {
      if (serial === loadSerial.current) setLoadError('Device data unavailable — retry refresh');
    } finally {
      if (serial === loadSerial.current) setLoading(false);
    }
  };

  // Server-side pagination: never load only the first 100 and slice locally.
  useEffect(() => {
    void loadDevices(true);
    return () => { loadSerial.current++; };
  }, [appliedSearch, currentPage, pageSize]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = adminRealtime.subscribe(notice => {
      if (notice.type === 'state') {
        setRealtimeState(notice.state);
        return;
      }
      const relevant = notice.type === 'resync' || (
        notice.type === 'change' && (
          notice.change.type === 'presence.changed' ||
          notice.change.type === 'resource.changed' &&
          ['devices', 'licenses', 'apps'].includes(notice.change.resource)
        )
      );
      if (relevant) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { void loadDevices(true); }, 200);
      }
    });
    // Signed HTTP heartbeat writes do not always publish journal events.
    // Refresh just the mounted page, and only while visible, to keep last_ping_at fresh.
    const heartbeat = setInterval(() => {
      if ((typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
          adminRealtime.getStatus().state !== 'AUTH_EXPIRED') {
        void loadDevices(true);
      }
    }, 30_000);
    return () => { unsubscribe(); if (timer) clearTimeout(timer); clearInterval(heartbeat); };
  }, [appliedSearch, currentPage, pageSize]);

  const pageDeviceIds = devices.map(device => device.id).slice(0, 100).join(',');
  useEffect(() => {
    let active = true;
    let serial = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const request = ++serial;
      void api.getRealtimePresence({ deviceIds: pageDeviceIds ? pageDeviceIds.split(',') : [] })
        .then(result => { if (active && request === serial) setPresence(result); })
        .catch(() => { if (active && request === serial) setPresence(null); });
    };
    refresh();
    const unsubscribe = adminRealtime.subscribe(notice => {
      if (notice.type === 'state') setRealtimeState(notice.state);
      if (notice.type === 'resync' || notice.type === 'change' && (
          notice.change.type === 'presence.changed' ||
          notice.change.type === 'resource.changed' &&
          ['devices', 'licenses', 'apps'].includes(notice.change.resource)
        ) || notice.type === 'snapshot' && adminRealtime.getStatus().state !== 'CONNECTED') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 150);
      }
    });
    let ticks = 0;
    const interval = setInterval(() => {
      const state = adminRealtime.getStatus().state;
      if ((typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
          state !== 'AUTH_EXPIRED' && (state !== 'CONNECTED' || ++ticks % 4 === 0)) refresh();
    }, 15_000);
    return () => {
      active = false; serial++; unsubscribe();
      if (timer) clearTimeout(timer);
      clearInterval(interval);
    };
  }, [pageDeviceIds]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCurrentPage(1);
    const term = search.trim();
    if (term !== appliedSearch) setAppliedSearch(term);
    else void loadDevices(true);
  };

  const presenceFresh = presence && realtimeState !== 'AUTH_EXPIRED' &&
    Date.now() - presence.observedAt < 60_000;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);
  const paginatedDevices = devices;

  const handleUnbind = async (id: string) => {
    const connected = presence?.connectedDeviceIds.includes(id) ?? false;
    const ok = await confirm(connected
      ? 'Force logout this connected device? Its binding will be revoked, live WebSocket closed, and it must authenticate again.'
      : 'Unbind this hardware device? It will be denied at its next signed license check.');
    if (!ok) return;
    try {
      setActionLoading(true);
      await api.unbindDevice(id);
      await loadDevices(true);
    } catch (err: any) {
      alert(err.message || 'Unbind failed');
    } finally {
      setActionLoading(false);
    }
  };

  const formatTime = (ms: number) => {
    if (!ms) return 'Never';
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-1.5 flex-1 max-w-md">
          <div className="relative flex-1">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search HWID, machine name, IP, key..."
              className="w-full pl-7 pr-2.5 py-1 text-xs bg-slate-900 border border-slate-800 rounded text-slate-200 font-mono focus:border-indigo-500/80 focus:outline-none"
            />
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-1.5" />
          </div>
          <button
            type="submit"
            className="px-2 py-1 text-xs font-mono rounded bg-slate-900 hover:bg-slate-850 text-slate-300 border border-slate-800 transition-colors"
          >
            Filter
          </button>
        </form>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-slate-400">Total Bound: {total}</span>
          {loadError && <span role="status" className="text-[10px] text-amber-400">{loadError}</span>}
          {presenceFresh ? (
            <span className="text-[10px] font-mono text-slate-400" aria-live="polite"
              title="Connected means verified WebSocket session, not merely a bound device. Stale is derived from last lease update.">
              WS: <span className="text-emerald-400">{presence.connectedNow}</span>
              <span className="mx-1 text-slate-600">|</span>Bound active: {presence.boundActive}
              <span className="mx-1 text-slate-600">|</span>Stale: {presence.staleBound}
              <span className="mx-1 text-slate-600">|</span>{realtimeState} · {new Date(presence.observedAt).toLocaleTimeString()} · {presence.transportEnabled ? 'SDK WS ON' : 'SDK WS OFF'}
            </span>
          ) : <span className="text-[10px] text-slate-500">Live report unavailable · {realtimeState}</span>}
          <button
            onClick={() => loadDevices(true)}
            className="p-1 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="border border-slate-800/80 rounded bg-slate-950/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead className="bg-slate-900/60 border-b border-slate-800/80 text-slate-400 text-[10px] uppercase">
              <tr>
                <th className="py-2 px-2.5">Hardware ID (HWID)</th>
                <th className="py-2 px-2.5">Bound License</th>
                <th className="py-2 px-2.5">Client Device</th>
                <th className="py-2 px-2.5">IP Address</th>
                <th className="py-2 px-2.5">Status</th>
                <th className="py-2 px-2.5">WS Session</th>
                <th className="py-2 px-2.5">Last Heartbeat</th>
                <th className="py-2 px-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40 text-slate-300 text-[11px]">
              {paginatedDevices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    {loading ? 'Loading devices...' : 'No active hardware bindings found.'}
                  </td>
                </tr>
              ) : (
                paginatedDevices.map((dev) => (
                  <tr key={dev.id} className="hover:bg-slate-900/30 transition-colors">
                    <td className="py-2 px-2.5">
                      <span className="font-medium text-slate-300 select-all" title={dev.hwid}>
                        {dev.hwid}
                      </span>
                    </td>
                    <td className="py-2 px-2.5">
                      <div className="flex items-center gap-1 font-medium text-slate-300">
                        <Key className="w-3 h-3 text-slate-400" />
                        {dev.license_key || 'UNKNOWN'}
                      </div>
                    </td>
                    <td className="py-2 px-2.5">
                      <div className="text-slate-300">{dev.device_name || 'Generic PC'}</div>
                      <div className="text-[10px] text-slate-500">{dev.os_info || 'Unknown OS'}</div>
                    </td>
                    <td className="py-2 px-2.5 text-slate-400">{dev.ip_address}</td>
                    <td className="py-2 px-2.5">
                      {dev.status === 'active' ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-950/40 text-emerald-400 border border-emerald-900/50">
                          Active
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-900 text-slate-400 border border-slate-800">
                          Logged Out
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2.5">
                      {presenceFresh && presence.connectedDeviceIds.includes(dev.id) ? (
                        <span className="text-emerald-400 text-[10px]" title="Authenticated WebSocket connection">Connected</span>
                      ) : (
                        <span className="text-slate-500 text-[10px]"
                          title="Not connected to this Node WebSocket gateway; may be HTTP-only, reconnecting or offline">
                          {presenceFresh ? 'No WS' : 'Unknown'}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2.5 text-slate-400">{formatTime(dev.last_ping_at)}</td>
                    <td className="py-2 px-2.5 text-right">
                      <button
                        onClick={() => handleUnbind(dev.id)}
                        disabled={actionLoading}
                        className="px-2 py-0.5 text-[10px] rounded bg-slate-900 hover:bg-rose-950/40 text-rose-400 border border-slate-800 hover:border-rose-900/50 transition-colors"
                        title="Revoke device binding; close authenticated live WebSocket after DB commit"
                      >
                        {presence?.connectedDeviceIds.includes(dev.id)
                          ? 'Force logout'
                          : dev.status === 'active' ? 'Unbind HWID' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          currentPage={safeCurrentPage}
          totalItems={total}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(newSize) => {
            setPageSize(newSize);
            setCurrentPage(1);
          }}
          itemLabel="devices"
        />
      </div>
    </div>
  );
};
