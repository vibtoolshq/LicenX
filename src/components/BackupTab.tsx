import React, { useEffect, useState } from 'react';
import { Cloud, DatabaseBackup, ShieldAlert, RefreshCw, Download, CalendarClock, UploadCloud, RotateCcw, KeyRound } from 'lucide-react';
import { api } from '../services/apiClient';
import type { BackupAccount, FullBackupStatus } from '../types';

type AccountDraft = { name: string; accountId: string; accessKeyId: string; bucketName: string; secretAccessKey: string };
const newAccount = (): AccountDraft => ({ name: '', accountId: '', accessKeyId: '', bucketName: '', secretAccessKey: '' });

export function BackupTab() {
  const [data, setData] = useState<FullBackupStatus | null>(null);
  const [account, setAccount] = useState<AccountDraft>(newAccount);
  const [editId, setEditId] = useState('');
  const [selected, setSelected] = useState('');
  const [intervalHours, setIntervalHours] = useState(24);
  const [destination, setDestination] = useState('local');
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [importedFileId, setImportedFileId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [recoveryFile, setRecoveryFile] = useState<File | null>(null);
  const [remoteKey, setRemoteKey] = useState('');
  const load = async (setInputs = false) => {
    try {
      const result = await api.getFullBackupStatus();
      setData(result);
      if (setInputs) {
        setEnabled(result.schedule.enabled);
        setIntervalHours(result.schedule.intervalHours);
        setDestination(result.schedule.destination);
        if (result.accounts.length) setSelected(result.accounts[0].id);
      }
    } catch { setStatus('Failed to load backup status. Check your admin login.'); }
  };
  useEffect(() => { void load(true); }, []);
  useEffect(() => {
    if (!data?.jobs.some(j => j.status === 'running')) return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [data?.jobs.map(j => j.id + j.status).join(',')]);
  const perform = async (task: () => Promise<unknown>, success: string) => {
    setBusy(true); setStatus('');
    try { await task(); setStatus(success); await load(); }
    catch (e: any) { setStatus(typeof e?.message === 'string' ? e.message : 'Operation failed'); }
    finally { setBusy(false); }
  };
  const edit = (a: BackupAccount) => {
    setEditId(a.id); setSelected(a.id);
    setAccount({ name: a.name, accountId: a.accountId, accessKeyId: a.accessKeyId, bucketName: a.bucketName, secretAccessKey: '' });
  };
  const saveAccount = () => perform(async () => {
    if (editId) await api.updateBackupAccount(editId, account);
    else await api.createBackupAccount(account);
    setAccount(newAccount()); setEditId('');
  }, 'R2 account saved. Credentials remain encrypted at rest.');
  const saveSchedule = () => perform(async () => {
    await api.saveBackupSchedule({ enabled, intervalHours, destination });
  }, enabled ? 'Automatic backup schedule saved.' : 'Automatic backup disabled.');
  const startBackup = (mode: string) => perform(async () => {
    await api.runFullBackup(mode);
  }, 'Backup started. Check job history for progress.');
  const upload = () => perform(async () => {
    if (!uploadFile) throw new Error('Select a .lxbackup file first');
    const result = await api.uploadFullBackup(uploadFile);
    setImportedFileId(result.fileId);
  }, 'Encrypted backup uploaded. Confirm the restore before proceeding.');
  const importR2 = () => perform(async () => {
    if (!selected || !remoteKey) throw new Error('Select R2 account and backup object path');
    const result = await api.importFullRestoreFromR2(selected, remoteKey);
    setImportedFileId(result.fileId);
  }, 'R2 backup downloaded for verification. Confirm restore to proceed.');
  const restore = () => perform(async () => {
    if (!importedFileId || confirmation !== 'RESTORE LICENX') throw new Error('Restore confirmation is required');
    await api.startFullRestore(importedFileId, confirmation, currentPassword);
    setConfirmation(''); setCurrentPassword('');
  }, 'Restore started. API maintenance mode will activate during recovery.');
  const inputClass = 'w-full mt-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-100 text-sm outline-none focus:border-indigo-600';
  const button = 'px-3 py-2 text-xs rounded bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed';
  const secondaryButton = 'px-3 py-2 text-xs rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed';
  const chosen = data?.accounts.find(a => a.id === selected);
  const makeField = (field: keyof AccountDraft, label: string, type = 'text') => (
    <label key={field} className="block text-xs text-slate-400">{label}
      <input type={type} className={inputClass} value={account[field]} autoComplete="off"
        placeholder={field === 'secretAccessKey' && editId ? 'Leave blank to keep saved key' : ''}
        onChange={event => setAccount(previous => ({ ...previous, [field]: event.target.value }))} />
    </label>
  );
  return (
    <div className="space-y-4 text-slate-200">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Backup & Recovery</h2><p className="text-xs text-slate-400">Administration / Backup · PostgreSQL + application storage</p></div>
        <button className={secondaryButton + ' flex items-center gap-2'} type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={13}/> Refresh</button>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <div className="rounded border border-slate-800 bg-slate-900/70 p-4"><Cloud size={18} className="text-indigo-400"/><div className="mt-2 text-sm font-semibold">{data?.accounts.length ?? 0} R2 account(s)</div><p className="text-xs text-slate-400 mt-2">Encrypted credentials</p></div>
        <div className="rounded border border-slate-800 bg-slate-900/70 p-4"><CalendarClock size={18} className="text-indigo-400"/><div className="mt-2 text-sm font-semibold">{data?.schedule.enabled ? 'Scheduled' : 'Disabled'}</div><p className="text-xs text-slate-400 mt-2">Worker exits after each job</p></div>
        <div className="rounded border border-slate-800 bg-slate-900/70 p-4"><DatabaseBackup size={18} className="text-indigo-400"/><div className="mt-2 text-sm font-semibold">{data?.busy ? 'Running' : 'Idle'}</div><p className="text-xs text-slate-400 mt-2">No permanent backup process</p></div>
      </div>
      {!data?.recoveryKeySaved && (
        <section className="border border-amber-800/60 bg-amber-950/20 rounded p-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-300 text-sm font-semibold"><ShieldAlert size={16}/> Offline recovery key required</div>
          <p className="text-xs text-slate-300">Download and securely save your 32-byte recovery key outside this VPS before enabling backups. Without this key, R2 backups cannot be decrypted after server loss. Never publish it or commit it to GitHub.</p>
          <a className={secondaryButton + ' inline-flex items-center gap-1'} href="/api/backup/recovery-key" onClick={() => { setTimeout(() => { void load(); }, 1000); }}><KeyRound size={13}/> Download recovery key</a>
          <p className="text-xs text-amber-300">Fresh VPS recovery only: you may import the original 32-byte key if no backup jobs or R2 accounts exist yet.</p>
          <div className="flex flex-wrap gap-2 items-center"><input type="file" className="text-xs max-w-xs" onChange={e => setRecoveryFile(e.target.files?.[0] || null)}/>
            <button className={secondaryButton} type="button" disabled={busy || !recoveryFile} onClick={() => void perform(async () => {
              if (!recoveryFile) throw new Error('Select recovery key file');
              await api.importBackupRecoveryKey(recoveryFile);
            }, 'Original recovery key imported.')}>Import existing key</button>
          </div>
        </section>
      )}
      <section className="rounded border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <h3 className="font-semibold text-sm">Cloudflare R2 backup accounts</h3>
        <p className="text-xs text-slate-400">These accounts are separate from website/public asset storage. Credentials are never returned to the browser after saving.</p>
        {Boolean(data?.accounts.length) && <div className="flex flex-wrap gap-2">
          {data?.accounts.map(a => <button type="button" key={a.id} className={secondaryButton} onClick={() => edit(a)}>{a.name} — {a.bucketName}</button>)}
          <button type="button" className={secondaryButton} onClick={() => { setEditId(''); setAccount(newAccount()); }}>+ New account</button>
        </div>}
        <div className="grid sm:grid-cols-2 gap-3">
          {makeField('name','Account name')}
          {makeField('accountId','Cloudflare Account ID')}
          {makeField('accessKeyId','Access Key ID')}
          {makeField('bucketName','Private bucket name')}
          {makeField('secretAccessKey','Secret Access Key','password')}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => void saveAccount()} disabled={busy}>{editId ? 'Update account' : 'Add account'}</button>
          {editId && <button type="button" className={secondaryButton} disabled={busy} onClick={() => void perform(async () => {
            const result = await api.testBackupAccount(editId);
            if (!result.success) throw new Error(result.message);
          },'R2 connection verified successfully')}>Test saved connection</button>}
        </div>
      </section>
      <section className="rounded border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <h3 className="font-semibold text-sm">Scheduled backups</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">Frequency
            <select className={inputClass} value={intervalHours} onChange={e => setIntervalHours(Number(e.target.value))}>
              <option value={1}>Every hour</option><option value={6}>Every 6 hours</option><option value={12}>Every 12 hours</option><option value={24}>Every 24 hours</option><option value={168}>Every week</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">Destination
            <select className={inputClass} value={destination} onChange={e => setDestination(e.target.value)}>
              <option value="local">Private VPS storage</option>
              {data?.accounts.map(a => <option value={'r2:' + a.id} key={a.id}>R2 — {a.name}</option>)}
            </select>
          </label>
          <label className="inline-flex gap-2 items-center text-xs text-slate-300 pb-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/> Enable</label>
          <button type="button" className={button} disabled={busy || !data?.recoveryKeySaved} onClick={() => void saveSchedule()}>Save schedule</button>
        </div>
        <p className="text-xs text-slate-500">Next run: {data?.schedule.enabled ? new Date(data.schedule.nextAt).toLocaleString() : 'Not scheduled'}. App must be running; no separate cron or permanent worker.</p>
      </section>
      <section className="rounded border border-slate-800 p-4 space-y-3">
        <h3 className="font-semibold text-sm">Manual backup</h3>
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className={secondaryButton} disabled={busy || Boolean(data?.busy) || !data?.recoveryKeySaved} onClick={() => void startBackup('local')}><Download size={13} className="inline mr-1"/>Create downloadable backup</button>
          <select aria-label="R2 backup destination" className={inputClass + ' max-w-56'} value={selected} onChange={e => setSelected(e.target.value)}>
            <option value="">Choose R2 account</option>{data?.accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}
          </select>
          <button type="button" className={button} disabled={busy || Boolean(data?.busy) || !selected || !data?.recoveryKeySaved} onClick={() => void startBackup('r2:' + selected)}><UploadCloud size={13} className="inline mr-1"/>Backup to R2</button>
        </div>
      </section>
      <section className="rounded border border-rose-950 bg-rose-950/10 p-4 space-y-3">
        <div className="flex items-center gap-2"><RotateCcw size={16} className="text-rose-400"/><h3 className="font-semibold text-sm">Restore system data</h3></div>
        <p className="text-xs text-slate-400">Restoring replaces current license database and application files. A local pre-restore checkpoint is created first. Test with a disposable installation before using on live data. This does not restore Docker secrets or Caddy certificates.</p>
        <label className="block text-xs text-slate-400">Upload encrypted .lxbackup
          <input type="file" accept=".lxbackup" className="block text-xs mt-2" onChange={e => setUploadFile(e.target.files?.[0] || null)}/>
        </label>
        <button type="button" className={secondaryButton} disabled={busy || !uploadFile} onClick={() => void upload()}>Upload backup</button>
        <div className="flex flex-wrap items-end gap-2">
          <input aria-label="R2 object key" className={inputClass + ' max-w-lg'} placeholder="licenx-full-backups/... .lxbackup" value={remoteKey} onChange={e => setRemoteKey(e.target.value)}/>
          <button className={secondaryButton} type="button" disabled={busy || !selected || !remoteKey} onClick={() => void importR2()}>Load from R2</button>
        </div>
        {importedFileId && <div className="space-y-2">
          <p className="text-xs text-amber-300">Staged file: {importedFileId}. Type RESTORE LICENX to confirm destructive recovery.</p>
          <input aria-label="Type RESTORE LICENX to confirm" className={inputClass + ' max-w-sm'} value={confirmation} onChange={e => setConfirmation(e.target.value)} placeholder="RESTORE LICENX"/>
          <input type="password" autoComplete="current-password" aria-label="Current administrator password" className={inputClass + ' max-w-sm'} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Confirm admin password"/>
          <button type="button" className="block px-3 py-2 text-xs bg-rose-800 rounded disabled:opacity-50" disabled={busy || Boolean(data?.busy) || !currentPassword || confirmation !== 'RESTORE LICENX'} onClick={() => void restore()}>Verify & Restore</button>
        </div>}
      </section>
      <section className="border border-slate-800 rounded p-4 space-y-2">
        <h3 className="font-semibold text-sm">Backup / restore job history</h3>
        {status && <p role="status" className="text-xs text-indigo-300">{status}</p>}
        {!data?.jobs.length ? <p className="text-xs text-slate-500">No jobs yet.</p> :
          <div className="space-y-2">{data?.jobs.map(j => <div key={j.id} className="flex items-center justify-between gap-2 border-b border-slate-800 py-2 text-xs">
            <span className="truncate">{j.action} · {new Date(j.createdAt).toLocaleString()}</span>
            <span className={j.status === 'failed' ? 'text-rose-300' : j.status === 'completed' ? 'text-emerald-300' : 'text-amber-300'}>{j.status}</span>
            {j.status === 'completed' && j.file && j.action === 'backup' && <a href={'/api/backup/download/' + encodeURIComponent(j.id)} className="text-indigo-300">Download</a>}
            {j.r2Key && <button className="text-indigo-300" onClick={() => { setRemoteKey(j.r2Key || ''); }}>R2 key</button>}
            {j.error && <span className="text-rose-300">{j.error}</span>}
          </div>)}</div>}
      </section>
    </div>
  );
}
