import React, { useEffect, useState } from 'react';
import { ArrowUpRight, ImageIcon, Loader2, Wrench } from 'lucide-react';
import { api } from '../services/apiClient';
import type { PublicCatalogPublished, PublicToolItem, SiteSettings } from '../types';
import { PublicHeader, safePublicHref } from './PublicHeader';

const BRANDING_ICON = /^\/api\/public\/assets\/branding\/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(png|jpe?g|gif|webp|ico)$/i;
const RASTER_EXTENSION = /\.(?:png|jpe?g|gif|webp|ico)$/i;

/** Render only public, validated, click-safe destinations, even with stale client data. */
export function publishedToolCards(tools: PublicToolItem[]): PublicToolItem[] {
  return tools
    .filter(tool => tool.enabled && typeof tool.url === 'string' &&
      tool.url.startsWith('https://') && safePublicHref(tool.url) !== null)
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** No SVG/data/javascript icons, HTML injection or unvalidated origin strings. */
export function safePublicToolIcon(value: string): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  if (BRANDING_ICON.test(value)) return value;
  if (!value.startsWith('https://')) return null;
  const href = safePublicHref(value);
  if (!href) return null;
  try {
    return RASTER_EXTENSION.test(new URL(href).pathname) ? href : null;
  } catch {
    return null;
  }
}

export function PublicToolCard({ tool }: { tool: PublicToolItem }) {
  const [failedIcon, setFailedIcon] = useState('');
  const href = safePublicHref(tool.url);
  if (!tool.enabled || !href || !href.startsWith('https://')) return null;
  const icon = safePublicToolIcon(tool.iconUrl);
  const showIcon = icon && failedIcon !== icon;

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={'Open tool ' + tool.name}
      className="group flex min-w-0 flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900/70 p-4 transition-colors hover:border-indigo-500/50 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
          {showIcon ? (
            <img src={icon} alt={tool.name + ' icon'} loading="lazy"
              className="h-9 w-9 object-contain" onError={() => setFailedIcon(icon)} />
          ) : <ImageIcon size={20} className="text-slate-500" aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-slate-100">{tool.name}</h2>
          <span className="text-[10px] text-slate-500">External tool</span>
        </div>
        <ArrowUpRight size={16} className="shrink-0 text-slate-500 group-hover:text-indigo-400"
          aria-hidden="true" />
      </div>
      {tool.description && (
        <p className="min-w-0 break-words text-[11px] leading-relaxed text-slate-400">{tool.description}</p>
      )}
      <span className="mt-auto inline-flex items-center gap-1.5 text-[11px] font-medium text-indigo-400">
        Open Tool <ArrowUpRight size={12} aria-hidden="true" />
      </span>
    </a>
  );
}

export function PublicToolsGrid({ tools }: { tools: PublicToolItem[] }) {
  const visible = publishedToolCards(tools);
  if (visible.length === 0) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 text-center">
        <Wrench size={24} className="mx-auto mb-3 text-slate-500" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-300">No tools published yet</p>
        <p className="mt-1 text-[11px] text-slate-500">Check back after the site administrator adds tools.</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map(tool => <PublicToolCard key={tool.id} tool={tool} />)}
    </div>
  );
}

export function PublicToolsPage({ siteSettings }: { siteSettings: SiteSettings }) {
  const [catalog, setCatalog] = useState<PublicCatalogPublished | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    api.getPublicCatalog()
      .then(result => {
        if (active) {
          setCatalog(result);
          setLoadFailed(false);
        }
      })
      .catch(() => {
        if (active) {
          setCatalog(null);
          setLoadFailed(true);
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 font-mono text-xs text-slate-300 selection:bg-indigo-600/20">
      <PublicHeader siteSettings={siteSettings} catalog={catalog}/>
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-5 px-3.5 py-8 sm:py-10">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-slate-100">Tools</h1>
          <p className="text-xs text-slate-400">
            Useful tools published by {siteSettings.siteName || 'LicenX'}. Open a card to visit its website.
          </p>
        </div>
        {loading ? (
          <div role="status" className="flex items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-10 text-slate-400">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Loading published tools…
          </div>
        ) : loadFailed ? (
          <div role="alert" className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-5 text-amber-200">
            Tools are temporarily unavailable. Please try again later.
          </div>
        ) : (
          <PublicToolsGrid tools={catalog?.tools ?? []} />
        )}
      </main>
      <footer className="border-t border-slate-900/90 px-4 py-5 text-center text-[10px] text-slate-500">
        {siteSettings.siteName || 'LicenX'} · <a href="/" className="text-indigo-400 hover:underline">Portal Home</a>
      </footer>
    </div>
  );
}
