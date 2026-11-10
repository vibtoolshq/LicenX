import React, { useEffect, useState, useRef } from 'react';
import { Terminal, Trash2, RefreshCw } from 'lucide-react';
import { adminRealtime, api, type SafeDiagnostic } from '../services/apiClient';
import { ValidationLog } from '../types';
import { TablePagination } from './TablePagination';
import { useConfirm } from '../context/ConfirmContext';

export const LogsTab: React.FC = () => {
  const confirm = useConfirm();
  const [logs, setLogs] = useState<ValidationLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [diagnostics, setDiagnostics] = useState<SafeDiagnostic[]>([]);
  const [diagError, setDiagError] = useState('');
  const [diagSearch, setDiagSearch] = useState('');
  const [connectionState, setConnectionState] = useState(adminRealtime.getStatus().state);
  const loadSerial = useRef(0);
  const [actionFilter, setActionFilter] = useState(() => {
    try {
      return sessionStorage.getItem('vcon_logs_action_filter') || 'all';
    } catch {
      return 'all';
    }
  });

  // Pagination state
  const [currentPage, setCurrentPage] = useState(() => {
    try {
      const p = sessionStorage.getItem('vcon_logs_page');
      return p ? parseInt(p, 10) || 1 : 1;
    } catch {
      return 1;
    }
  });
  const [pageSize, setPageSize] = useState(20);

  // Persist filter and pagination to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem('vcon_logs_action_filter', actionFilter);
      sessionStorage.setItem('vcon_logs_page', String(currentPage));
    } catch {}
  }, [actionFilter, currentPage]);

  const loadLogs = async (force = false) => {
    const serial = ++loadSerial.current;
    try {
      if (logs.length === 0) setLoading(true);
      const res = await api.getLogs({
        action: actionFilter !== 'all' ? actionFilter : undefined,
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      }, force);
      if (serial !== loadSerial.current) return;
      const logList = res?.logs || (Array.isArray(res) ? (res as ValidationLog[]) : []);
      const count = typeof res?.total === 'number' ? res.total : (Array.isArray(logList) ? logList.length : 0);
      setLogs(Array.isArray(logList) ? logList : []);
      setTotal(count);
      const lastPage = Math.max(1, Math.ceil(count / pageSize));
      if (currentPage > lastPage) setCurrentPage(lastPage);
      setLastUpdated(Date.now());
      setError('');
    } catch {
      if (serial === loadSerial.current) setError('Log data stale — refresh unavailable');
    } finally {
      if (serial === loadSerial.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs(true);
    return () => { loadSerial.current++; };
  }, [actionFilter, currentPage, pageSize]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = adminRealtime.subscribe(notice => {
      if (notice.type === 'state') setConnectionState(notice.state);
      if (notice.type === 'resync' || notice.type === 'change' &&
        notice.change.type === 'resource.changed' && notice.change.resource === 'logs') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { void loadLogs(true); }, 200);
      }
    });
    const fallback = setInterval(() => {
      if (!['CONNECTED', 'AUTH_EXPIRED'].includes(adminRealtime.getStatus().state) &&
          (typeof document === 'undefined' || document.visibilityState !== 'hidden')) void loadLogs(true);
    }, 30_000);
    return () => { unsubscribe(); if (timer) clearTimeout(timer); clearInterval(fallback); };
  }, [actionFilter, currentPage, pageSize]);

  // Recent volatile diagnostics are NOT validation/audit history.
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const result = await api.getDiagnostics();
        if (mounted) {
          setDiagnostics(Array.isArray(result.entries) ? result.entries : []);
          setDiagError('');
        }
      } catch {
        if (mounted) setDiagError('Recent diagnostic report unavailable');
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  const filteredDiagnostics = diagnostics.filter(entry =>
    [entry.code, entry.stage, entry.component, entry.incident_id]
      .some(value => value.toLowerCase().includes(diagSearch.trim().toLowerCase()))
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);
  const paginatedLogs = logs; // Server returns the requested bounded history page.

  const handleClearLogs = async () => {
    const ok = await confirm('Clear all audit logs permanently?');
    if (!ok) return;
    try {
      await api.clearLogs();
      await loadLogs();
    } catch (err: any) {
      alert(err.message || 'Failed to clear logs');
    }
  };

  const formatTime = (ms: number) => {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="space-y-3 font-mono text-xs">
      <section className="rounded border border-slate-800 bg-slate-950/50 p-2 space-y-2" aria-label="Recent SDK and server diagnostics">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-medium text-slate-300">Recent SDK / Server Diagnostics (volatile)</span>
          <input
            aria-label="Filter recent diagnostics by code, stage, source, or incident ID"
            value={diagSearch}
            onChange={event => setDiagSearch(event.target.value)}
            placeholder="Filter code / stage / incident"
            className="px-2 py-1 text-xs rounded bg-slate-900 border border-slate-800 text-slate-300"
          />
        </div>
        {diagError && <p role="status" className="text-amber-400">{diagError}</p>}
        {filteredDiagnostics.length === 0 ? (
          <p className="text-slate-500">No recent in-process diagnostic event matching this filter (not proof of no errors).</p>
        ) : (
          <div className="max-h-44 overflow-auto space-y-1">
            {filteredDiagnostics.slice(0, 12).map(entry => (
              <div key={entry.id} className="flex flex-wrap gap-x-3 text-[10px] text-slate-400 border-b border-slate-800/50 pb-1">
                <span>{new Date(entry.observed_at).toLocaleTimeString()}</span>
                <span>{entry.component} / {entry.stage}</span>
                <span className="text-amber-300">{entry.code}</span>
                {entry.tls_verify_code !== undefined && <span>TLS verify #{entry.tls_verify_code}</span>}
                <span title="Opaque incident ID" className="select-all">{entry.incident_id}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-300 uppercase tracking-wider">
            Audit Log Trail ({total})
          </span>
          <span className="text-[10px] text-slate-500" role="status" title={lastUpdated ? 'Last HTTP refresh: ' + new Date(lastUpdated).toLocaleString() : 'Awaiting first successful HTTP refresh'}>
            {error || (connectionState === 'CONNECTED' ? 'Live updates' : connectionState === 'AUTH_EXPIRED' ? 'Session expired' : 'HTTP fallback')}{lastUpdated ? ' · ' + new Date(lastUpdated).toLocaleTimeString() : ''}
          </span>
          <select
            value={actionFilter}
            onChange={(e) => { setActionFilter(e.target.value); setCurrentPage(1); }}
            className="px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded text-slate-300 focus:outline-none"
          >
            <option value="all">Action: All</option>
            <option value="validate">Validated (200)</option>
            <option value="reject">Rejected (403)</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => loadLogs(true)}
            className="p-1 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleClearLogs}
            className="flex items-center gap-1 px-2 py-1 rounded bg-slate-900 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 border border-slate-800 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
        </div>
      </div>

      <div className="border border-slate-800/80 rounded bg-slate-950/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead className="bg-slate-900/60 border-b border-slate-800/80 text-slate-400 text-[10px] uppercase">
              <tr>
                <th className="py-2 px-2.5">Code</th>
                <th className="py-2 px-2.5">Action</th>
                <th className="py-2 px-2.5">License Key</th>
                <th className="py-2 px-2.5">HWID</th>
                <th className="py-2 px-2.5">Message / Outcome</th>
                <th className="py-2 px-2.5">IP</th>
                <th className="py-2 px-2.5 text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40 text-slate-300 text-[11px]">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    {loading ? 'Loading logs...' : 'No audit logs recorded.'}
                  </td>
                </tr>
              ) : (
                paginatedLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-900/30 transition-colors">
                    <td className="py-2 px-2.5">
                      <span
                        className={`px-1.5 py-0.2 rounded text-[10px] font-medium ${
                          log.status_code === 200
                            ? 'bg-emerald-950/30 text-emerald-400 border border-emerald-900/40'
                            : log.status_code === 404
                            ? 'bg-slate-900 text-slate-400 border border-slate-800'
                            : 'bg-rose-950/30 text-rose-400 border border-rose-900/40'
                        }`}
                      >
                        {log.status_code}
                      </span>
                    </td>
                    <td className="py-2 px-2.5 uppercase text-[10px] text-slate-400 font-medium">
                      {log.action}
                    </td>
                    <td className="py-2 px-2.5 font-medium text-slate-300 select-all">
                      {log.license_key || 'UNKNOWN'}
                    </td>
                    <td className="py-2 px-2.5 text-slate-400 select-all">
                      {log.hwid ? log.hwid.slice(0, 16) + '...' : '—'}
                    </td>
                    <td className="py-2 px-2.5 text-slate-300">{log.message}</td>
                    <td className="py-2 px-2.5 text-slate-500">{log.ip_address}</td>
                    <td className="py-2 px-2.5 text-slate-500 text-right">{formatTime(log.created_at)}</td>
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
          itemLabel="logs"
        />
      </div>
    </div>
  );
};
