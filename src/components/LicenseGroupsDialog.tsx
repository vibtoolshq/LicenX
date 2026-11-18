import React, { useState } from 'react';
import { Archive, Check, Loader2, Pencil, Plus, X } from 'lucide-react';
import { useConfirm } from '../context/ConfirmContext';
import { api } from '../services/apiClient';
import type { LicenseGroup } from '../types';

interface LicenseGroupsDialogProps {
  groups: LicenseGroup[];
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}

export const LicenseGroupsDialog: React.FC<LicenseGroupsDialogProps> = ({
  groups, onChanged, onClose,
}) => {
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeGroups = groups.filter(group => group.archived_at == null);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) {
      setError('Enter a Group name (1–80 characters).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (editingId) await api.renameLicenseGroup(editingId, trimmed);
      else await api.createLicenseGroup(trimmed);
      setName('');
      setEditingId(null);
      await onChanged();
    } catch (err: any) {
      setError(err?.message || 'Unable to save Group.');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (group: LicenseGroup) => {
    const ok = await confirm({
      title: 'Archive License Group',
      message: 'Archive "' + group.name + '"? Its ' + group.license_count +
        ' existing licenses will stay assigned, but new batches cannot use this Group.',
      confirmText: 'Archive Group',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await api.archiveLicenseGroup(group.id);
      if (editingId === group.id) { setEditingId(null); setName(''); }
      await onChanged();
    } catch (err: any) {
      setError(err?.message || 'Unable to archive Group.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-3 font-sans">
      <section role="dialog" aria-modal="true" aria-label="Manage License Groups"
        className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 text-xs text-slate-200 shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5">
          <div>
            <h2 className="font-semibold">License Groups</h2>
            <p className="mt-1 text-[11px] text-slate-500">Manage Team, Client or Reseller labels.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close Groups"
            className="rounded p-1 text-slate-400 hover:bg-slate-800"><X size={15}/></button>
        </header>
        <div className="space-y-3 p-3">
          {error && <p role="alert" className="text-rose-400">{error}</p>}
          <form onSubmit={event => { event.preventDefault(); void save(); }} className="flex gap-2">
            <input aria-label="License Group name" value={name} maxLength={80}
              onChange={event => setName(event.target.value)}
              placeholder={editingId ? 'Rename Group' : 'New Group name'}
              className="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-slate-200 outline-none focus:border-indigo-500" />
            <button type="submit" disabled={busy || !name.trim()}
              className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1.5 font-medium disabled:opacity-40">
              {busy ? <Loader2 size={13} className="animate-spin"/> : editingId ? <Check size={13}/> : <Plus size={13}/>}
              {editingId ? 'Save' : 'Create'}
            </button>
            {editingId && <button type="button" onClick={() => { setEditingId(null); setName(''); setError(''); }}
              disabled={busy} className="rounded border border-slate-700 px-2 text-slate-400">Cancel</button>}
          </form>
          <div className="max-h-64 divide-y divide-slate-800 overflow-y-auto rounded border border-slate-800">
            {groups.length === 0 && <p className="p-3 text-slate-500">No Groups yet. Add one above.</p>}
            {groups.map(group => (
              <div key={group.id} className="flex items-center gap-2 p-2">
                <span className="min-w-0 flex-1 truncate" title={group.name}>
                  <span className={group.archived_at != null ? 'text-slate-500' : 'text-slate-200'}>{group.name}</span>
                  <span className="ml-2 text-[10px] text-slate-500">
                    {group.license_count} licenses{group.archived_at != null ? ' · Archived' : ''}
                  </span>
                </span>
                {group.archived_at == null && <>
                  <button type="button" title="Rename Group" aria-label={'Rename ' + group.name}
                    disabled={busy} onClick={() => { setEditingId(group.id); setName(group.name); setError(''); }}
                    className="rounded p-1 text-slate-400 hover:bg-slate-800"><Pencil size={13}/></button>
                  <button type="button" title="Archive Group" aria-label={'Archive ' + group.name}
                    disabled={busy} onClick={() => void archive(group)}
                    className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-amber-300"><Archive size={13}/></button>
                </>}
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-500">
            {activeGroups.length} active Groups · Archiving preserves existing license assignments.
          </p>
        </div>
      </section>
    </div>
  );
};
