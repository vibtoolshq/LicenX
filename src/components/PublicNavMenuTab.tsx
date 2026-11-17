import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { api, ApiError } from '../services/apiClient';
import type { PublicCatalogAdmin, PublicNavItem } from '../types';

const LEGACY_URL = 'https://html.vibid.my/';
const inputStyle = 'w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none';
const actionStyle = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40';

/** Keep server ordering canonical; this helper supports both drag and keyboard reordering. */
export function reorderNavItems(items: PublicNavItem[], from: number, to: number): PublicNavItem[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) ||
      from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const copy = items.slice();
  const [moving] = copy.splice(from, 1);
  copy.splice(to, 0, moving);
  return copy.map((item, order) => ({ ...item, order }));
}

export function nextNavId(items: PublicNavItem[], prefix = 'link'): string {
  const used = new Set(items.map(item => item.id));
  for (let index = 1; index <= 100; index++) {
    const candidate = prefix + '-' + index;
    if (!used.has(candidate)) return candidate;
  }
  return prefix + '-new';
}

function navDraftError(items: PublicNavItem[]): string {
  if (items.length > 24) return 'Only 24 navigation items are supported.';
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) return 'Every navigation item needs a unique ID.';
    ids.add(item.id);
    if (!item.label.trim() || item.label.length > 60) return 'Navigation labels must be 1–60 characters.';
    if (!item.href.trim() || item.href.length > 2048) return 'Enter a destination URL (maximum 2048 characters).';
    if (item.kind === 'cta' && item.id !== 'buy-license') return 'Only Buy License can be the CTA.';
    if (item.id === 'tools' && item.href !== '/tools') return 'The Tools route must remain /tools.';
  }
  return '';
}

export function PublicNavMenuTab() {
  const [catalog, setCatalog] = useState<PublicCatalogAdmin | null>(null);
  const [items, setItems] = useState<PublicNavItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [feedback, setFeedback] = useState('');
  const dragged = useRef<number | null>(null);

  const load = async () => {
    setLoading(true);
    setFeedback('');
    try {
      const result = await api.getAdminPublicCatalog();
      setCatalog(result);
      setItems(result.navigation.map(item => ({ ...item })));
      setDirty(false);
      setConflict(false);
    } catch (error) {
      setFeedback(error instanceof ApiError && error.status === 401
        ? 'Admin session expired. Sign in and reload this page.'
        : 'Unable to load navigation. Check your connection and try Reload.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const edit = (index: number, patch: Partial<PublicNavItem>) => {
    if (saving) return;
    setItems(previous => previous.map((item, position) =>
      position === index ? { ...item, ...patch } : item));
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const move = (from: number, to: number) => {
    if (saving || from === to || to < 0 || to >= items.length) return;
    setItems(previous => reorderNavItems(previous, from, to));
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const add = () => {
    if (saving || items.length >= 24) return;
    setItems(previous => [...previous, {
      id: nextNavId(previous), label: 'New Link', href: 'https://example.com/',
      kind: 'link', enabled: false, target: 'new', order: previous.length,
    }]);
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const importLegacy = () => {
    if (saving || items.length >= 24 || items.some(item => item.id === 'legacy-free-html')) return;
    setItems(previous => [...previous, {
      id: 'legacy-free-html', label: 'Free HTML', href: LEGACY_URL,
      kind: 'link', enabled: false, target: 'new', order: previous.length,
    }]);
    setDirty(true);
    setConflict(false);
    setFeedback('Legacy link added as DISABLED draft. Review its URL before enabling and saving.');
  };
  const addCta = () => {
    if (saving || !catalog || items.length >= 24 || items.some(item => item.id === 'buy-license')) return;
    setItems(previous => [...previous, {
      id: 'buy-license', label: 'Buy License', href: catalog.buyLicenseUrl || '#',
      kind: 'cta', enabled: true, target: 'new', order: previous.length,
    }]);
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const remove = (index: number) => {
    if (saving) return;
    setItems(previous => previous.filter((_, position) => position !== index)
      .map((item, order) => ({ ...item, order })));
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };

  const cancelChanges = () => {
    if (!catalog || saving) return;
    setItems(catalog.navigation.map(item => ({ ...item })));
    setDirty(false);
    setConflict(false);
    setFeedback('Unsaved changes discarded.');
  };

  const save = async () => {
    if (!catalog || !dirty || loading || saving) return;
    const error = navDraftError(items);
    if (error) { setFeedback(error); return; }
    setSaving(true);
    setFeedback('');
    try {
      const result = await api.updateAdminPublicCatalog({
        version: catalog.version, section: 'navigation',
        items: items.map((item, order) => ({ ...item, order })),
      });
      setCatalog(result);
      setItems(result.navigation.map(item => ({ ...item })));
      setDirty(false);
      setConflict(false);
      setFeedback('Navigation saved. Public header integration follows in Phase-03.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setFeedback('Another Admin or Site Settings update changed this catalog. Your draft is retained. Review and Reload before saving.');
      } else {
        setFeedback(error instanceof ApiError && error.status === 401
          ? 'Admin session expired. Sign in again; your unsaved draft is still here.'
          : error instanceof ApiError && error.status === 403
            ? 'Permission or CSRF validation failed. Nothing was saved.'
            : 'Save failed. Fix invalid values or connectivity and try again. Your draft is retained.');
      }
    } finally { setSaving(false); }
  };

  return (
    <section className="space-y-4 text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Public · Nav Menu</h2>
          <p className="text-xs text-slate-400 mt-1">Manage header links, the Buy License CTA and display order. Changes require Save.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={actionStyle} onClick={() => void load()} disabled={saving || loading}
            aria-label="Reload saved navigation"><RefreshCw size={14}/>Reload</button>
          <button type="button" className={actionStyle} onClick={cancelChanges} disabled={!dirty || saving || loading}>
            Cancel
          </button>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            onClick={() => void save()} disabled={!dirty || saving || loading || conflict || !catalog}>
            <Save size={14}/>{saving ? 'Saving…' : 'Save Navigation'}
          </button>
        </div>
      </div>

      <p role="status" aria-live="polite" className={'text-xs ' + (conflict ? 'text-amber-300' : 'text-slate-400')}>
        {feedback || (loading ? 'Loading saved navigation…' : dirty ? 'Unsaved changes · Select Save Navigation to publish your configuration.' : 'Current saved configuration')}
      </p>
      {conflict && <p className="text-xs text-amber-300">Reload replaces this local draft. Copy any unfinished URLs before reloading.</p>}

      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={actionStyle} onClick={add} disabled={loading || saving || !catalog || items.length >= 24}>
            <Plus size={14}/>Add Link
          </button>
          <button type="button" className={actionStyle} onClick={addCta}
            disabled={loading || saving || !catalog || items.length >= 24 || items.some(item => item.id === 'buy-license')}>
            <Plus size={14}/>Restore Buy License CTA
          </button>
          <button type="button" className={actionStyle} onClick={importLegacy}
            disabled={loading || saving || !catalog || items.length >= 24 || items.some(item => item.id === 'legacy-free-html')}>
            Import Legacy Free HTML (disabled)
          </button>
        </div>
        <p className="text-xs text-slate-500">
          The current public header still includes its historical hardcoded Free HTML link until Phase-03.
          Importing it is optional; newly added links default to hidden.
        </p>
        {items.length === 0 && !loading && <p className="text-xs text-slate-400">No navigation entries. Add a link or restore the CTA.</p>}

        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={item.id} draggable={!saving} onDragStart={event => {
              dragged.current = index;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id);
            }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
              onDrop={event => { event.preventDefault(); if (dragged.current !== null) move(dragged.current, index); dragged.current = null; }}
              onDragEnd={() => { dragged.current = null; }}
              className="rounded-md border border-slate-800 bg-slate-950/80 p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs font-medium text-slate-300">
                  <GripVertical className="text-slate-500" size={15}/> {index + 1}. {item.id === 'buy-license' ? 'Buy License CTA' : item.id === 'tools' ? 'Tools route' : item.id}
                </span>
                <div className="flex gap-1.5">
                  <button type="button" className={actionStyle} onClick={() => move(index, index - 1)} disabled={saving || index === 0}
                    aria-label={'Move ' + item.label + ' up'}><ArrowUp size={13}/></button>
                  <button type="button" className={actionStyle} onClick={() => move(index, index + 1)} disabled={saving || index === items.length - 1}
                    aria-label={'Move ' + item.label + ' down'}><ArrowDown size={13}/></button>
                  <button type="button" className={actionStyle} onClick={() => remove(index)} disabled={saving}
                    aria-label={'Remove ' + item.label}><Trash2 size={13}/></button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                <label className="text-xs text-slate-400 sm:col-span-4">Label
                  <input className={'mt-1 ' + inputStyle} maxLength={60} value={item.label} onChange={e => edit(index, { label: e.target.value })}/>
                </label>
                <label className="text-xs text-slate-400 sm:col-span-8">Destination URL
                  <input className={'mt-1 ' + inputStyle} maxLength={2048} value={item.href}
                    disabled={item.id === 'tools'} onChange={e => edit(index, { href: e.target.value })}/>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={item.enabled} onChange={e => edit(index, { enabled: e.target.checked })}/>
                  Visible
                </label>
                <label className="flex items-center gap-2">Open
                  <select className={inputStyle} value={item.target}
                    onChange={e => edit(index, { target: e.target.value as PublicNavItem['target'] })}>
                    <option value="same">Same tab</option><option value="new">New tab</option>
                  </select>
                </label>
                <span>{item.kind === 'cta' ? 'CTA button' : 'Navigation link'}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Drag an item to reorder, or use Move Up/Down with mouse, keyboard or touch. The Buy License URL remains
        synchronized with Administration → Site Settings; removing the button never deletes that setting.
        Public header rendering changes only in Phase-03.
      </p>
    </section>
  );
}
