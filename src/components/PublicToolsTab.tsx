import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Image as ImageIcon, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import { api, ApiError } from '../services/apiClient';
import type { PublicCatalogAdmin, PublicToolItem } from '../types';

const inputStyle = 'w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none';
const actionStyle = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon']);
const MAX_ICON_BYTES = 5 * 1024 * 1024;

/** Pure ordering helper shared by native drag/drop and keyboard/touch-safe controls. */
export function reorderToolItems(items: PublicToolItem[], from: number, to: number): PublicToolItem[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) ||
    from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const copy = items.slice();
  const [moving] = copy.splice(from, 1);
  copy.splice(to, 0, moving);
  return copy.map((item, order) => ({ ...item, order }));
}

export function nextToolId(items: PublicToolItem[]): string {
  const used = new Set(items.map(item => item.id));
  for (let index = 1; index <= 110; index++) {
    const candidate = 'tool-' + index;
    if (!used.has(candidate)) return candidate;
  }
  return 'tool-new';
}

/** Validate the draft for readable errors; authoritative validation stays on the P01 server. */
export function toolDraftError(items: PublicToolItem[]): string {
  if (items.length > 100) return 'Only 100 tools are supported.';
  const used = new Set<string>();
  for (const item of items) {
    if (used.has(item.id)) return 'Every tool requires a unique ID.';
    used.add(item.id);
    if (!item.name.trim() || item.name.length > 80) return 'Tool names must be 1–80 characters.';
    if (item.description.length > 240) return 'Descriptions must not exceed 240 characters.';
    if (!item.url.trim() || item.url.length > 2048 || !item.url.startsWith('https://'))
      return 'Tool destinations must be HTTPS URLs (maximum 2048 characters).';
    if (item.iconUrl.length > 2048) return 'Icon URLs must not exceed 2048 characters.';
  }
  return '';
}

function safelyPreviewIcon(iconUrl: string): boolean {
  if (/^\/api\/public\/assets\/branding\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp|gif|ico)$/i.test(iconUrl)) return true;
  try {
    const url = new URL(iconUrl);
    return url.protocol === 'https:' && !url.username && !url.password &&
      /\.(png|jpe?g|webp|gif|ico)$/i.test(url.pathname);
  } catch { return false; }
}

export function shouldShowToolIcon(url: string, failedUrl = ''): boolean {
  return Boolean(url) && url !== failedUrl && safelyPreviewIcon(url);
}

function asBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Cannot read selected image'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('Invalid image data'));
      } else {
        resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      }
    };
    reader.readAsDataURL(file);
  });
}

export function PublicToolsTab() {
  const [catalog, setCatalog] = useState<PublicCatalogAdmin | null>(null);
  const [items, setItems] = useState<PublicToolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failedIcons, setFailedIcons] = useState<Record<string, string>>({});
  const dragged = useRef<number | null>(null);

  const load = async () => {
    setLoading(true);
    setFeedback('');
    try {
      const result = await api.getAdminPublicCatalog();
      setCatalog(result);
      setItems(result.tools.map(item => ({ ...item })));
      setDirty(false);
      setConflict(false);
    } catch (error) {
      setFeedback(error instanceof ApiError && error.status === 401
        ? 'Admin session expired. Sign in and reload this page.'
        : 'Unable to load tools. Check your connection and try Reload.');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const edit = (id: string, patch: Partial<PublicToolItem>) => {
    if (saving || uploadingId) return;
    setItems(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item));
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const move = (from: number, to: number) => {
    if (saving || uploadingId || from === to || to < 0 || to >= items.length) return;
    setItems(previous => reorderToolItems(previous, from, to));
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const add = () => {
    if (saving || uploadingId || items.length >= 100) return;
    setItems(previous => [...previous, {
      id: nextToolId(previous), name: 'New Tool', description: '',
      url: 'https://example.com/', iconUrl: '',
      enabled: false, order: previous.length,
    }]);
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const remove = (id: string) => {
    if (saving || uploadingId) return;
    setItems(previous => previous.filter(item => item.id !== id)
      .map((item, order) => ({ ...item, order })));
    setDirty(true);
    setConflict(false);
    setFeedback('');
  };
  const discard = () => {
    if (!catalog || saving || uploadingId) return;
    setItems(catalog.tools.map(item => ({ ...item })));
    setDirty(false);
    setConflict(false);
    setFeedback('Unsaved changes discarded.');
  };

  const uploadIcon = async (id: string, file: File | undefined) => {
    if (!file || saving || uploadingId) return;
    if (!IMAGE_TYPES.has(file.type) || !file.size || file.size > MAX_ICON_BYTES) {
      setFeedback('Icon must be PNG, JPG, WebP, GIF or ICO and no larger than 5 MB.');
      return;
    }
    setUploadingId(id);
    setFeedback('');
    try {
      const dataBase64 = await asBase64(file);
      const result = await api.uploadSiteAsset({
        filename: file.name, contentType: file.type, dataBase64, folder: 'branding',
      });
      // Uploaded file is stored by the existing branding pipeline; Save associates it with the tool.
      setItems(previous => previous.map(item => item.id === id ? { ...item, iconUrl: result.url } : item));
      setDirty(true);
      setConflict(false);
      setFeedback('Icon uploaded to existing branding storage. Save Tools to apply it to the catalog.');
    } catch (error) {
      setFeedback(error instanceof ApiError && error.status === 401
        ? 'Admin session expired. Sign in again; your draft is retained.'
        : 'Icon upload failed. Your existing tool data is unchanged.');
    } finally { setUploadingId(null); }
  };

  const save = async () => {
    if (!catalog || !dirty || saving || uploadingId || loading) return;
    const error = toolDraftError(items);
    if (error) { setFeedback(error); return; }
    setSaving(true);
    setFeedback('');
    try {
      const updated = await api.updateAdminPublicCatalog({
        section: 'tools', version: catalog.version,
        items: items.map((item, order) => ({ ...item, order })),
      });
      setCatalog(updated);
      setItems(updated.tools.map(item => ({ ...item })));
      setDirty(false);
      setConflict(false);
      setFeedback('Tools saved. Public /tools gallery will be added in Phase-03.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setFeedback('The catalog changed elsewhere. Your draft is retained; review and Reload before saving.');
      } else {
        setFeedback(error instanceof ApiError && error.status === 401
          ? 'Admin session expired. Sign in again; your unsaved changes are retained.'
          : error instanceof ApiError && error.status === 403
            ? 'Permission or CSRF validation failed. Nothing was saved.'
            : 'Unable to save. Check the values and connection; your unsaved draft is retained.');
      }
    } finally { setSaving(false); }
  };

  const busy = saving || Boolean(uploadingId);
  return (
    <section className="space-y-4 text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Public · Tools</h2>
          <p className="text-xs text-slate-400 mt-1">Manage the public Tools directory. Cards become visible after Phase-03 integration.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={actionStyle} onClick={() => void load()}
            disabled={busy || loading} aria-label="Reload saved tools"><RefreshCw size={14}/>Reload</button>
          <button type="button" className={actionStyle} onClick={discard} disabled={!dirty || busy || loading}>Cancel</button>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            onClick={() => void save()} disabled={!catalog || !dirty || busy || loading || conflict}>
            <Save size={14}/>{saving ? 'Saving…' : 'Save Tools'}
          </button>
        </div>
      </div>

      <p role="status" aria-live="polite" className={'text-xs ' + (conflict ? 'text-amber-300' : 'text-slate-400')}>
        {feedback || (loading ? 'Loading saved tools…' : dirty ?
          'Unsaved changes · Select Save Tools to publish your configuration.' : 'Current saved configuration')}
      </p>
      {conflict && <p className="text-xs text-amber-300">Reload replaces this local draft. Copy unfinished data before reloading.</p>}

      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-3">
        <div className="flex justify-between items-center gap-3">
          <button type="button" className={actionStyle} onClick={add} disabled={loading || busy || !catalog || items.length >= 100}>
            <Plus size={14}/>Add Tool
          </button>
          <span className="text-xs text-slate-500">{items.length} / 100</span>
        </div>
        {items.length === 0 && !loading && <p className="text-xs text-slate-400">No tools added. Select Add Tool to create the first card.</p>}

        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={item.id} draggable={!busy} onDragStart={event => {
              dragged.current = index;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id);
            }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
              onDrop={event => { event.preventDefault(); if (dragged.current !== null) move(dragged.current, index); dragged.current = null; }}
              onDragEnd={() => { dragged.current = null; }}
              className="rounded-md border border-slate-800 bg-slate-950/80 p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-300">
                  <GripVertical size={15} className="text-slate-500"/> {index + 1}. {item.id}
                </span>
                <div className="flex gap-1.5">
                  <button type="button" className={actionStyle} onClick={() => move(index, index - 1)}
                    disabled={busy || index === 0} aria-label={'Move ' + item.name + ' up'}><ArrowUp size={13}/></button>
                  <button type="button" className={actionStyle} onClick={() => move(index, index + 1)}
                    disabled={busy || index === items.length - 1} aria-label={'Move ' + item.name + ' down'}><ArrowDown size={13}/></button>
                  <button type="button" className={actionStyle} onClick={() => remove(item.id)}
                    disabled={busy} aria-label={'Remove ' + item.name}><Trash2 size={13}/></button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="text-xs text-slate-400">Name
                  <input className={'mt-1 ' + inputStyle} value={item.name} maxLength={80}
                    onChange={event => edit(item.id, { name: event.target.value })}/>
                </label>
                <label className="text-xs text-slate-400">Tool destination (HTTPS)
                  <input className={'mt-1 ' + inputStyle} value={item.url} maxLength={2048}
                    onChange={event => edit(item.id, { url: event.target.value })}/>
                </label>
              </div>
              <label className="block text-xs text-slate-400">Short description
                <textarea className={'mt-1 ' + inputStyle} rows={2} maxLength={240} value={item.description}
                  onChange={event => edit(item.id, { description: event.target.value })}/>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
                <label className="text-xs text-slate-400">Icon URL (optional, PNG/JPG/WebP/GIF/ICO)
                  <input className={'mt-1 ' + inputStyle} value={item.iconUrl} maxLength={2048}
                    onChange={event => edit(item.id, { iconUrl: event.target.value })}/>
                </label>
                <label className={actionStyle + ' cursor-pointer'}>
                  <Upload size={14}/> {uploadingId === item.id ? 'Uploading…' : 'Upload Icon'}
                  <input type="file" className="sr-only" accept=".png,.jpg,.jpeg,.webp,.gif,.ico,image/png,image/jpeg,image/webp,image/gif,image/x-icon"
                    disabled={busy} aria-label={'Upload icon for ' + item.name}
                    onChange={event => {
                      void uploadIcon(item.id, event.currentTarget.files?.[0]);
                      event.currentTarget.value = '';
                    }}/>
                </label>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 shrink-0 rounded border border-slate-700 bg-slate-900 flex items-center justify-center overflow-hidden">
                  {shouldShowToolIcon(item.iconUrl, failedIcons[item.id]) ? (
                    <img className="h-9 w-9 object-contain" src={item.iconUrl} alt={'Icon preview: ' + item.name}
                      onError={() => setFailedIcons(previous => ({ ...previous, [item.id]: item.iconUrl }))}/>
                  ) : <ImageIcon size={18} className="text-slate-500"/>}
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={item.enabled}
                    onChange={event => edit(item.id, { enabled: event.target.checked })}/> Visible to public users
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Drag cards or use Move Up/Down for keyboard and touch ordering. Uploaded icons use the existing
        Site Settings branding storage; no new upload service is added. Save Tools explicitly to persist changes.
        Public cards and the /tools route are Phase-03 only.
      </p>
    </section>
  );
}
