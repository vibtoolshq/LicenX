import React, { useState } from 'react';
import { Activity, CheckCircle2, Copy, Play, ShieldCheck, XCircle } from 'lucide-react';
import { adminRealtime, api } from '../services/apiClient';
import type { ServerDiagnosticsCheck, ServerDiagnosticsReport } from '../types';

function browserCheck(id: string, label: string, state: ServerDiagnosticsCheck['state'], detail: string, durationMs = 0): ServerDiagnosticsCheck {
  return { id, label, state, detail, durationMs };
}

async function browserHttp(path: '/api/health' | '/api/ready', label: string): Promise<ServerDiagnosticsCheck> {
  const start = Date.now();
  try {
    const result = await fetch(path, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    });
    return browserCheck(path.slice(5), label, result.status === 200 ? 'PASS' : 'FAIL',
      result.status === 200 ? 'HTTP 200 (same-origin browser request)' : 'Unexpected HTTP status ' + result.status,
      Date.now() - start);
  } catch {
    return browserCheck(path.slice(5), label, 'FAIL', 'Browser request unavailable or timed out', Date.now() - start);
  }
}

export function formatServerDiagnosticsReport(report: ServerDiagnosticsReport): string {
  const lines = [
    'LicenX Server Diagnostics',
    'Observed: ' + new Date(report.finishedAt).toISOString(),
    'Summary: ' + report.summary.pass + ' PASS, ' + report.summary.fail + ' FAIL, ' +
      report.summary.warn + ' WARN, ' + report.summary.skipped + ' SKIPPED',
    '',
  ];
  for (const c of report.checks) {
    lines.push('[' + c.state + '] ' + c.label + ' (' + c.durationMs + 'ms) — ' + c.detail);
  }
  lines.push('', 'Scope: read-only app/API/browser checks. No Docker host or disaster-recovery certification.');
  return lines.join('\n');
}

export function ServerDiagnosticsTab() {
  const [report, setReport] = useState<ServerDiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');

  const runTests = async () => {
    if (running) return;
    setRunning(true);
    setMessage('');
    setReport(null);
    try {
      const server = await api.runServerDiagnostics();
      const [browserHealth, browserReady, backup] = await Promise.allSettled([
        browserHttp('/api/health', 'Public browser HTTP liveness'),
        browserHttp('/api/ready', 'Public browser API readiness'),
        api.getFullBackupStatus(),
      ]);
      const checks: ServerDiagnosticsCheck[] = [...server.checks];
      checks.push(browserHealth.status === 'fulfilled' ? browserHealth.value :
        browserCheck('browser_health', 'Public browser HTTP liveness', 'FAIL', 'Browser check unavailable'));
      checks.push(browserReady.status === 'fulfilled' ? browserReady.value :
        browserCheck('browser_ready', 'Public browser API readiness', 'FAIL', 'Browser check unavailable'));
      const https = window.location.protocol === 'https:';
      checks.push(browserCheck('browser_tls', 'Browser HTTPS origin', https ? 'PASS' : 'WARN',
        https ? 'Browser is on HTTPS; independent TLS-chain verification not performed' :
          'Current browser origin is not HTTPS'));
      const ws = adminRealtime.getStatus().state;
      checks.push(browserCheck('browser_ws', 'Existing Admin WebSocket client',
        ws === 'CONNECTED' ? 'PASS' : 'WARN',
        'Browser state: ' + ws + ' (no new authenticated WebSocket created)'));
      if (backup.status === 'fulfilled') {
        const data = backup.value;
        const latestR2 = data.jobs.find(j => j.action === 'backup' && j.destination.startsWith('r2:'));
        checks.push(browserCheck('backup_summary', 'Backup manager status',
          data.busy || !data.accounts.length || latestR2?.status !== 'completed' || !latestR2.r2Key ? 'WARN' : 'PASS',
          'R2 accounts: ' + data.accounts.length + '; latest R2 backup: ' + (latestR2?.status ?? 'none') +
          '; recovery key download recorded: ' + (data.recoveryKeySaved ? 'yes' : 'no') +
          ' (not a remote restore or key-custody verification)'));
      } else {
        checks.push(browserCheck('backup_summary', 'Backup manager status', 'WARN',
          'Backup status unavailable; no backup created or modified'));
      }
      setReport({
        startedAt: server.startedAt, finishedAt: Date.now(), checks,
        summary: {
          pass: checks.filter(c => c.state === 'PASS').length,
          fail: checks.filter(c => c.state === 'FAIL').length,
          warn: checks.filter(c => c.state === 'WARN').length,
          skipped: checks.filter(c => c.state === 'SKIPPED').length,
        },
      });
    } catch (error: unknown) {
      const status = error && typeof error === 'object' && 'status' in error ?
        (error as { status?: unknown }).status : null;
      setMessage(status === 401 || status === 403 ? 'Admin session or CSRF authorization failed.' :
        status === 409 ? 'A diagnostics run is already in progress.' :
        status === 429 ? 'Please wait before running diagnostics again.' :
        'Diagnostics failed to start. Check the current Admin session and retry later.');
    } finally {
      setRunning(false);
    }
  };

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatServerDiagnosticsReport(report));
      setMessage('Sanitized report copied.');
    } catch {
      setMessage('Copy unavailable in this browser.');
    }
  };

  const dot = (state: ServerDiagnosticsCheck['state']) =>
    state === 'PASS' ? 'text-emerald-400' : state === 'FAIL' ? 'text-rose-400' :
    state === 'WARN' ? 'text-amber-400' : 'text-slate-400';

  return (
    <section className="space-y-4 text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2"><Activity size={18}/> Server Diagnostics</h2>
          <p className="text-xs text-slate-400">Administration / Server · Read-only, fixed health and security probes</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={running} onClick={() => void runTests()}
            className="flex items-center gap-2 px-3 py-2 rounded bg-indigo-600 text-white text-xs hover:bg-indigo-500 disabled:opacity-50">
            <Play size={13}/>{running ? 'Running checks…' : 'Run Tests'}
          </button>
          <button type="button" disabled={running || !report} onClick={() => void copyReport()}
            className="flex items-center gap-2 px-3 py-2 rounded bg-slate-800 text-xs hover:bg-slate-700 disabled:opacity-50">
            <Copy size={13}/> Copy Report
          </button>
        </div>
      </div>
      <p role="status" className="text-xs text-slate-400" aria-live="polite">
        {message || (running ? 'Running bounded read-only checks…' :
          report ? 'Last manual run: ' + new Date(report.finishedAt).toLocaleString() :
          'Press Run Tests to begin. No automatic background tests.')}
      </p>
      {report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            {(['pass', 'fail', 'warn', 'skipped'] as const).map(state => (
              <div key={state} className="rounded border border-slate-800 bg-slate-900/60 p-3">
                <div className="text-slate-400 uppercase">{state}</div>
                <div className="text-xl font-semibold">{report.summary[state]}</div>
              </div>
            ))}
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/40 divide-y divide-slate-800">
            {report.checks.map(check => (
              <div key={check.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {check.state === 'FAIL' ? <XCircle size={13} className={dot(check.state)}/> :
                      <CheckCircle2 size={13} className={dot(check.state)}/>}
                    <span className="font-medium">{check.label}</span>
                  </div>
                  <div className="text-slate-400 ml-5 mt-1 break-words">{check.detail}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={'font-semibold ' + dot(check.state)}>{check.state}</div>
                  <div className="text-slate-500 mt-1">{check.durationMs} ms</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="flex items-start gap-2 text-xs text-slate-500">
        <ShieldCheck size={14} className="shrink-0"/>
        These checks do not inspect Docker daemon, host OS, signing keys, actual restore capability or customer license behavior.
        SKIPPED and WARN are never treated as PASS.
      </p>
    </section>
  );
}
