import React, { useEffect, useId, useState } from 'react';
import { ExternalLink, Menu, ShieldCheck, X } from 'lucide-react';
import { api } from '../services/apiClient';
import type { PublicCatalogPublished, PublicNavItem, SiteSettings } from '../types';

const PUBLIC_PATHS = new Set(['/', '/tools', '/home', '/check', '/index.html']);
const UNSAFE_URL_CHARACTERS = /[\u0000-\u0020\u007f\\<>"'\u202a-\u202e\u2066-\u2069]/u;

/**
 * Defense in depth: public navigation receives server-published values, but
 * never render a link with an executable or privileged URL even if stale data
 * reaches the browser. Validation authority remains with the P01 API.
 */
export function safePublicHref(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 ||
      UNSAFE_URL_CHARACTERS.test(value)) return null;
  if (PUBLIC_PATHS.has(value)) return value;
  if (!value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !hostname || url.username || url.password ||
        hostname.endsWith('.') || /(^localhost$|\.localhost$|\.local$|\.internal$|\.test$|\.invalid$)/.test(hostname) ||
        /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function publishedHeaderLinks(items: PublicNavItem[]): PublicNavItem[] {
  return items
    .filter(item => item.enabled && (safePublicHref(item.href) !== null ||
      (item.id === 'buy-license' && item.kind === 'cta' && item.href === '#')))
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export interface PublicHeaderProps {
  siteSettings: SiteSettings;
  /** When supplied, the parent owns the public catalog request (including loading/null). */
  catalog?: PublicCatalogPublished | null;
}

export function PublicHeader({ siteSettings, catalog }: PublicHeaderProps) {
  const [loadedCatalog, setLoadedCatalog] = useState<PublicCatalogPublished | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileId = useId();

  useEffect(() => {
    setLogoError(false);
  }, [siteSettings.logoUrl]);

  useEffect(() => {
    if (catalog !== undefined) return;
    let active = true;
    setFetchFailed(false);
    api.getPublicCatalog().then(result => {
      if (active) setLoadedCatalog(result);
    }).catch(() => {
      if (active) {
        setFetchFailed(true);
        setLoadedCatalog(null);
      }
    });
    return () => { active = false; };
  }, [catalog]);

  const visible = publishedHeaderLinks((catalog === undefined ? loadedCatalog : catalog)?.navigation ?? []);
  const renderLink = (item: PublicNavItem) => {
    const href = safePublicHref(item.href);
    const cta = item.kind === 'cta';
    const style = cta
      ? 'inline-flex shrink-0 items-center gap-1.5 rounded-md bg-indigo-600/90 px-2.5 py-1.5 text-[11px] font-medium text-slate-100 transition-colors hover:bg-indigo-600'
      : 'inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-indigo-400';
    // Existing Site Settings may deliberately leave the CTA unconfigured as "#".
    if (href === null) return (
      <span key={item.id} aria-disabled="true" title="Set the Buy License URL in Site Settings"
        className={style + ' cursor-not-allowed opacity-60'}>{item.label}</span>
    );
    const newTab = item.target === 'new';
    return (
      <a key={item.id} href={href} target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noopener noreferrer' : undefined} onClick={() => setMenuOpen(false)}
        className={style}>
        <span>{item.label}</span>
        {newTab && <ExternalLink className="h-2.5 w-2.5 opacity-75" aria-hidden="true" />}
      </a>
    );
  };

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md"
      onKeyDown={event => { if (event.key === 'Escape') setMenuOpen(false); }}>
      <div className="mx-auto flex h-12 w-full max-w-5xl items-center justify-between gap-3 px-3.5">
        <a href="/" aria-label="LicenX public home"
          className="inline-flex min-w-0 shrink-0 items-center gap-2 rounded-sm hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
          {siteSettings.logoUrl && !logoError ? (
            <img src={siteSettings.logoUrl} alt={siteSettings.siteName || 'Logo'}
              className="h-6 w-6 rounded border border-slate-800 bg-slate-900 object-contain"
              onError={() => setLogoError(true)} />
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded border border-indigo-500/30 bg-indigo-500/10 text-indigo-400/90">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          <span className="max-w-36 truncate text-xs font-semibold tracking-wide text-slate-200 sm:max-w-52">
            {siteSettings.siteName || 'LicenX'}
          </span>
        </a>

        <nav aria-label="Public navigation" className="hidden min-w-0 max-w-[70vw] items-center gap-2 overflow-x-auto whitespace-nowrap md:flex">
          {visible.map(renderLink)}
          {fetchFailed && <span role="status" className="text-[10px] text-slate-500">Navigation unavailable</span>}
        </nav>

        <button type="button" aria-label="Toggle public navigation" aria-controls={mobileId}
          aria-expanded={menuOpen} onClick={() => setMenuOpen(previous => !previous)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-800 bg-slate-900 text-slate-300 hover:text-indigo-300 md:hidden">
          {menuOpen ? <X size={15} aria-hidden="true" /> : <Menu size={15} aria-hidden="true" />}
        </button>
      </div>

      <nav id={mobileId} aria-label="Public mobile navigation"
        className={(menuOpen ? 'flex' : 'hidden') + ' flex-col gap-1 border-t border-slate-800 bg-slate-950 px-3.5 py-2 md:hidden'}>
        {visible.map(renderLink)}
        {fetchFailed && <span role="status" className="text-[11px] text-slate-400">Navigation temporarily unavailable.</span>}
        {!fetchFailed && visible.length === 0 && <span className="text-[11px] text-slate-500">No public links available.</span>}
      </nav>
    </header>
  );
}
