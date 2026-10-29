import React, { useEffect, useState } from 'react';
import { Check, Copy, Globe2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useConfirm } from '../context/ConfirmContext';
import { api } from '../services/apiClient';
import type { PublicLicenseApiDomain } from '../types';

export const PublicLicenseApiTab: React.FC = () => {
  const confirm = useConfirm();
  const [domains, setDomains] = useState<PublicLicenseApiDomain[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [environmentEnabled, setEnvironmentEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [domain, setDomain] = useState('');
  const [label, setLabel] = useState('');
  const [oneTimeSecret, setOneTimeSecret] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const value = await api.getPublicLicenseApiControl();
      setEnabled(value.enabled);
      setDomains(value.domains);
      setEnvironmentEnabled(value.environment_enabled !== false);
      setError('');
    } catch {
      setError('Could not load public API settings. Your existing data is unchanged.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const changeGlobal = async () => {
    const target = !enabled;
    if (target) {
      const ok = await confirm({
        title: 'Enable restricted Public API?',
        message: 'Only enabled, registered domains with their private app-scoped token may check licenses. Browser-only access is not secure.',
        confirmText: 'Enable API',
      });
      if (!ok) return;
    }
    setBusy(true); setError(''); setSuccess('');
    try {
      await api.setPublicLicenseApiEnabled(target);
      await refresh();
      setSuccess(target ? 'Public license check enabled for registered domains.' : 'Public license check disabled.');
    } catch { setError('Could not change Public API status. Check registered domains and try again.'); }
    finally { setBusy(false); }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!domain.trim()) return;
    setBusy(true); setError(''); setSuccess(''); setOneTimeSecret('');
    try {
      const value = await api.createPublicLicenseDomain({ domain_origin: domain.trim(), name: label.trim() || undefined });
      setOneTimeSecret(value.secret);
      setDomain(''); setLabel('');
      await refresh();
      setSuccess('Domain added. Save its private token now; it cannot be shown again.');
    } catch { setError('Could not add domain. Use a unique exact HTTPS origin and active application.'); }
    finally { setBusy(false); }
  };

  const toggleDomain = async (item: PublicLicenseApiDomain) => {
    setBusy(true); setError(''); setSuccess('');
    try {
      await api.setPublicLicenseDomainEnabled(item.id, !item.enabled);
      await refresh();
      setSuccess(item.enabled ? 'Domain disabled.' : 'Domain enabled.');
    } catch { setError('Could not change domain access.'); }
    finally { setBusy(false); }
  };

  const revoke = async (item: PublicLicenseApiDomain) => {
    const ok = await confirm({
      title: 'Revoke domain access',
      message: 'Revoke ' + item.domain_origin + '? Its dedicated API credential will stop working. This cannot be undone.',
      confirmText: 'Revoke Domain',
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api.revokePublicLicenseDomain(item.id);
      await refresh();
      setSuccess('Domain credential revoked. Re-register to issue a new token.');
    } catch { setError('Could not revoke the selected domain.'); }
    finally { setBusy(false); }
  };

  return <div className="space-y-3 text-[11px]">
    <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2 font-semibold text-white text-xs"><ShieldCheck className="w-4 h-4 text-indigo-400"/>Restricted Public License API</div>
        <div className="text-slate-400">Global read-only lookup across all LicenX applications • private per-domain token • rate limited</div>
        <div className="font-mono text-[10px] text-slate-500 break-all">POST /api/v1/public/license/check</div>
      </div>
      <button type="button" onClick={changeGlobal} disabled={loading || busy || !environmentEnabled}
        className={'rounded px-3 py-2 font-semibold border transition disabled:opacity-50 ' +
          (enabled ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-slate-800 text-slate-200 border-slate-700')}>
        {busy ? 'Saving…' : enabled ? 'Enabled · Click to disable' : 'Disabled · Click to enable'}
      </button>
    </div>
    {!environmentEnabled && <div className="p-2.5 border border-amber-500/30 bg-amber-500/10 rounded text-amber-300">
      Server emergency override is disabled. The deployment owner must explicitly allow Public API control before it can be enabled here.
    </div>}
    <div className="p-2.5 border border-amber-500/20 bg-amber-500/10 rounded text-amber-200">
      Each approved domain can check any LicenX license and receive its associated application, status and remaining duration. The private token belongs on the tool backend, never in public JavaScript. Domain names alone do not authenticate callers.
    </div>
    {error && <div role="alert" className="p-2.5 rounded bg-red-500/10 text-red-300 border border-red-500/20">{error}</div>}
    {success && <div role="status" className="p-2.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">{success}</div>}
    {oneTimeSecret && <div className="p-3 rounded-lg bg-slate-900 border border-amber-500/40 space-y-2">
      <div className="font-semibold text-amber-300">One-time consumer token — copy it now</div>
      <div className="flex gap-2 items-center">
        <code className="flex-1 px-2 py-2 bg-slate-950 text-slate-300 rounded text-[10px] break-all select-all">{oneTimeSecret}</code>
        <button className="shrink-0 p-2 text-white bg-indigo-600 rounded" title="Copy private token" onClick={() => navigator.clipboard.writeText(oneTimeSecret)}><Copy className="w-4 h-4"/></button>
      </div>
      <button className="text-slate-400 hover:text-white" onClick={() => setOneTimeSecret('')}>I saved it · Dismiss</button>
    </div>}
    <form onSubmit={create} className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-white"><Plus className="w-4 h-4 text-indigo-400"/>Allow a website / tool backend</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="space-y-1 text-slate-300">Exact HTTPS domain
          <input type="url" required maxLength={255} value={domain} onChange={e => setDomain(e.target.value)}
            placeholder="https://tools.example.com"
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-2 text-white focus:border-indigo-500 outline-none"/>
        </label>
        <label className="space-y-1 text-slate-300">Label (optional)
          <input maxLength={128} value={label} onChange={e => setLabel(e.target.value)} placeholder="My free tools"
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-2 text-white outline-none"/>
        </label>
      </div>
      <button type="submit" disabled={busy || loading || !domain.trim()} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-white font-semibold disabled:opacity-40">
        Add Domain & Generate Token
      </button>
    </form>
    <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center text-white text-xs font-semibold"><Globe2 className="w-4 h-4 text-indigo-400"/>Approved Domains ({domains.length})</div>
        <button onClick={refresh} disabled={busy || loading} title="Refresh domains" className="text-slate-400 hover:text-white disabled:opacity-50"><RefreshCw className={'w-4 h-4 ' + (loading ? 'animate-spin' : '')}/></button>
      </div>
      {domains.length === 0 && !loading && <div className="text-slate-500 py-3">No domains registered. Public API access is denied by default.</div>}
      {domains.map(item => <div key={item.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-2 py-2 border border-slate-800 rounded">
        <div className="min-w-0">
          <div className="font-mono text-slate-200 break-all">{item.domain_origin}</div>
          <div className="text-slate-500 text-[10px]">{item.legacy_scope ? 'Legacy app-scoped credential — revoke and re-register' : 'All LicenX applications'} · {item.enabled ? 'Active' : 'Disabled'} · Secret hidden</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => void toggleDomain(item)} disabled={busy || item.legacy_scope} className={'px-2 py-1.5 border rounded disabled:opacity-40 ' + (item.enabled ? 'border-emerald-500/30 text-emerald-300' : 'border-slate-600 text-slate-300')}>
            {item.enabled ? <><Check className="w-3 h-3 inline"/> Enabled</> : 'Disabled · Enable'}
          </button>
          <button onClick={() => void revoke(item)} disabled={busy} title="Revoke dedicated credential" className="px-2 py-1.5 text-red-400 border border-red-500/20 rounded disabled:opacity-40"><Trash2 className="w-3.5 h-3.5"/></button>
        </div>
      </div>)}
    </div>
  </div>;
};
