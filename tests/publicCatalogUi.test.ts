import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublicNavMenuTab, nextNavId, reorderNavItems } from '../src/components/PublicNavMenuTab.js';
import { PublicToolsTab, nextToolId, reorderToolItems, shouldShowToolIcon, toolDraftError } from '../src/components/PublicToolsTab.js';
import { DEFAULT_SITE_SETTINGS } from '../src/types.js';
import type { PublicCatalogPublished, PublicNavItem, PublicToolItem } from '../src/types.js';
import { PublicHeader, publishedHeaderLinks, safePublicHref } from '../src/components/PublicHeader.js';
import { PublicToolsGrid, PublicToolsPage, publishedToolCards, safePublicToolIcon } from '../src/components/PublicToolsPage.js';

const source = (file: string) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const nav = (id: string, order: number): PublicNavItem => ({
  id, label: id, href: id === 'tools' ? '/tools' : 'https://example.org',
  kind: 'link', enabled: true, target: 'same', order,
});
const tool = (id: string, order: number): PublicToolItem => ({
  id, name: id, description: '', url: 'https://example.org/tool',
  iconUrl: '', enabled: true, order,
});

test('PN-01 P02: Nav Menu reorder is stable, nonmutating and usable by drag/keyboard controls', () => {
  const original = [nav('tools', 0), nav('a', 1), nav('b', 2)];
  const reordered = reorderNavItems(original, 2, 0);
  assert.deepEqual(reordered.map(item => [item.id, item.order]),
    [['b', 0], ['tools', 1], ['a', 2]]);
  assert.deepEqual(original.map(item => item.id), ['tools', 'a', 'b']);
  assert.equal(reorderNavItems(original, 0, -1), original);
  assert.equal(reorderNavItems(original, 1, 1), original);
  assert.equal(nextNavId(original), 'link-1');
  assert.equal(nextNavId([...original, nav('link-1', 3)]), 'link-2');
  assert.match(source('src/components/PublicNavMenuTab.tsx'), /onDragStart=/);
  assert.match(source('src/components/PublicNavMenuTab.tsx'), /onDrop=/);
  assert.match(source('src/components/PublicNavMenuTab.tsx'), /Move Up\/Down/);
  assert.match(source('src/components/PublicNavMenuTab.tsx'), /aria-label=\{'Move ' \+ item\.label \+ ' up'\}/);
});

test('PN-01 P02: Tools reorder, stable IDs and local client-side invalid drafts', () => {
  const original = [tool('tool-1', 0), tool('tool-2', 1), tool('tool-3', 2)];
  const reordered = reorderToolItems(original, 0, 2);
  assert.deepEqual(reordered.map(item => [item.id, item.order]),
    [['tool-2', 0], ['tool-3', 1], ['tool-1', 2]]);
  assert.equal(original[0].order, 0);
  assert.equal(nextToolId(original), 'tool-4');
  assert.equal(reorderToolItems(original, 20, 0), original);
  assert.equal(toolDraftError(original), '');
  assert.match(toolDraftError([tool('repeated', 0), tool('repeated', 1)]), /unique ID/);
  assert.match(toolDraftError([tool('unsafe', 0), tool('unsafe', 1)]), /unique ID/);
  assert.match(toolDraftError([{
    ...tool('unsafe', 0), url: 'javascript:alert(1)',
  }]), /HTTPS/);
  assert.match(toolDraftError([{ ...tool('huge', 0), name: 'a'.repeat(81) }]), /1–80/);
  assert.match(toolDraftError(Array.from({ length: 101 }, (_, i) => tool('tool-' + (i + 1), i))), /100/);
});

test('PN-01 P02: invalid and failed icon URLs fall back without rendering a broken image', () => {
  const remote = 'https://example.org/logo.png';
  assert.equal(shouldShowToolIcon(remote), true);
  assert.equal(shouldShowToolIcon(remote, remote), false);
  assert.equal(shouldShowToolIcon('javascript:alert(1)'), false);
  assert.equal(shouldShowToolIcon('/api/public/assets/branding/tool.png'), true);
  assert.equal(shouldShowToolIcon('/api/public/assets/branding/tool.svg'), false);
  assert.match(source('src/components/PublicToolsTab.tsx'), /onError=\{\(\) => setFailedIcons/);
  assert.match(source('src/components/PublicToolsTab.tsx'), /<ImageIcon size=\{18\}/);
});

test('PN-01 P02: both pages render compact loading state and disabled save without calling backend on render', () => {
  const navHtml = renderToStaticMarkup(React.createElement(PublicNavMenuTab));
  const toolsHtml = renderToStaticMarkup(React.createElement(PublicToolsTab));
  assert.match(navHtml, /Public · Nav Menu/);
  assert.match(navHtml, /Save Navigation/);
  assert.match(navHtml, /Loading saved navigation/);
  assert.match(navHtml, /disabled=""/);
  assert.match(toolsHtml, /Public · Tools/);
  assert.match(toolsHtml, /Save Tools/);
  assert.match(toolsHtml, /Loading saved tools/);
  assert.match(toolsHtml, /disabled=""/);
});

test('PN-01 P02: Admin routes, sidebar/titles and tab types are strictly additive', () => {
  const app = source('src/App.tsx');
  const sidebar = source('src/components/Sidebar.tsx');
  const header = source('src/components/HeaderBar.tsx');
  const types = source('src/types.ts');
  assert.match(types, /\| "public-nav"/);
  assert.match(types, /\| "public-tools"/);
  assert.match(app, /'public-nav',\s*'public-tools'/);
  assert.match(app, /path === '\/vcon\/public-nav'/);
  assert.match(app, /path === '\/vcon\/public-tools'/);
  assert.ok(app.indexOf("path === '/vcon/public-tools'") < app.indexOf("path.includes('/apps')"));
  assert.match(app, /activeTab === 'public-nav' && <PublicNavMenuTab \/>/);
  assert.match(app, /activeTab === 'public-tools' && <PublicToolsTab \/>/);
  assert.match(app, /activeTab === 'backup' && <BackupTab \/>/);
  assert.match(app, /activeTab === 'server' && <ServerDiagnosticsTab \/>/);
  assert.match(sidebar, /id: 'public',\s*label: 'Public'/);
  assert.match(sidebar, /id: 'public-nav',\s*label: 'Nav Menu'/);
  assert.match(sidebar, /id: 'public-tools',\s*label: 'Tools'/);
  assert.match(sidebar, /id: 'system-admin',\s*label: 'Administration'/);
  assert.match(header, /'public-nav': 'Public Nav Menu'/);
  assert.match(header, /'public-tools': 'Public Tools'/);
  // P03 extends only exact public /tools routing while preserving unknown 404.
  assert.match(app, /isPublicToolsPath/);
  assert.match(app, /if \(!isAdminRoute && !isPublicHome && !isPublicToolsPath\)/);
});

test('PN-01 P02: Admin pages use scoped versioned APIs, explicit save, stale-draft retention and error codes', () => {
  const navFile = source('src/components/PublicNavMenuTab.tsx');
  const toolsFile = source('src/components/PublicToolsTab.tsx');
  for (const file of [navFile, toolsFile]) {
    assert.match(file, /api\.getAdminPublicCatalog\(\)/);
    assert.match(file, /api\.updateAdminPublicCatalog\(/);
    assert.match(file, /catalog\.version/);
    assert.match(file, /error\.status === 409/);
    assert.match(file, /setConflict\(true\)/);
    assert.match(file, /setDirty\(false\)/);
    assert.match(file, /aria-live="polite"/);
    assert.match(file, /onDragOver=/);
    assert.doesNotMatch(file, /setInterval|window\.location\.assign|new WebSocket|child_process|runFullBackup|startFullRestore/);
  }
  assert.match(navFile, /section: 'navigation'/);
  assert.match(navFile, /Import Legacy Free HTML \(disabled\)/);
  assert.match(navFile, /enabled: false, target: 'new'/);
  assert.match(navFile, /id: 'buy-license'/);
  assert.match(navFile, /Removing the button never deletes|removing the button never deletes/i);
  assert.match(toolsFile, /section: 'tools'/);
  assert.match(toolsFile, /api\.uploadSiteAsset\(/);
  assert.match(toolsFile, /folder: 'branding'/);
  assert.match(toolsFile, /MAX_ICON_BYTES = 5 \* 1024 \* 1024/);
  assert.match(toolsFile, /type="file"/);
  assert.match(toolsFile, /iconUrl: result\.url/);
  assert.doesNotMatch(toolsFile, /fetch\(|new FormData|<iframe|dangerouslySetInnerHTML/);
});

test('PN-01 P02: P01 backend/source contracts and protected public header are not repurposed', () => {
  assert.match(source('src/services/apiClient.ts'), /updateAdminPublicCatalog: \(data: PublicCatalogUpdate\)/);
  assert.match(source('src/server/publicCatalog.ts'), /CATALOG_VERSION_CONFLICT/);
  assert.match(source('src/components/LandingPage.tsx'), /<PublicHeader siteSettings=\{siteSettings\} \/>/);
  assert.doesNotMatch(source('src/components/LandingPage.tsx'), /href="https:\/\/html\.vibid\.my\/"/);
  assert.match(source('src/components/SiteSettingsTab.tsx'), /api\.saveSiteSettings\(settings\)/);
  assert.match(source('src/App.tsx'), /const isPublicHome =/);
});


test('PN-01 P03: public href validation rejects privileged, executable and unsafe destinations', () => {
  assert.equal(safePublicHref('/tools'), '/tools');
  assert.equal(safePublicHref('/check'), '/check');
  assert.equal(safePublicHref('https://example.org/tool'), 'https://example.org/tool');
  for (const candidate of [
    'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'file:///C:/secret', 'http://example.org',
    '//evil.example', '/vcon/public-nav', '/api/admin/public-catalog', '/tools?next=/vcon',
    'https://localhost/', 'https://127.0.0.1/private', 'https://[::1]/',
    'https://user:password@example.org/', 'https://example.org/has space',
    'https://example.org/\nsecret', 'https://example.org\\@evil.example/',
  ]) {
    assert.equal(safePublicHref(candidate), null, candidate);
  }
});

test('PN-01 P03: shared header renders only ordered enabled navigation and safe CTA links', () => {
  const items: PublicNavItem[] = [
    { ...nav('later', 4), label: 'Later', href: 'https://example.org/tools', target: 'new' },
    { ...nav('disabled', 2), label: 'Unpublished Secret', enabled: false },
    { ...nav('tools', 0), label: 'Tools', href: '/tools', target: 'same' },
    { ...nav('buy-license', 1), label: 'Buy License', kind: 'cta', href: 'https://example.org/buy', target: 'new' },
    { ...nav('bad', 3), label: 'Bad Link', href: 'javascript:alert(1)' },
  ];
  const visible = publishedHeaderLinks(items);
  assert.deepEqual(visible.map(item => item.id), ['tools', 'buy-license', 'later']);
  const catalog: PublicCatalogPublished = { navigation: items, tools: [] };
  const html = renderToStaticMarkup(React.createElement(PublicHeader, {
    siteSettings: { ...DEFAULT_SITE_SETTINGS, siteName: 'Private Portal', logoUrl: '' },
    catalog,
  }));
  assert.match(html, /Private Portal/);
  assert.match(html, /href="\/tools"/);
  assert.match(html, /href="https:\/\/example.org\/buy"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /aria-label="Public navigation"/);
  assert.match(html, /aria-label="Toggle public navigation"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls=/);
  assert.doesNotMatch(html, /Unpublished Secret|Bad Link|Free HTML|javascript:/);
  assert.ok(html.indexOf('href="/tools"') < html.indexOf('href="https://example.org/buy"'));

  const placeholder: PublicCatalogPublished = {
    navigation: [{ ...nav('buy-license', 0), kind: 'cta', href: '#', label: 'Buy License' }],
    tools: [],
  };
  const placeholderHtml = renderToStaticMarkup(React.createElement(PublicHeader, {
    siteSettings: DEFAULT_SITE_SETTINGS, catalog: placeholder,
  }));
  assert.match(placeholderHtml, /aria-disabled="true"/);
  assert.doesNotMatch(placeholderHtml, /href="#"/);
});

test('PN-01 P03: public tools filter hidden/unsafe cards, render grid with safe links and icon fallback', () => {
  const published = [
    { ...tool('hidden', 0), name: 'Unpublished Tool', enabled: false },
    { ...tool('second', 2), name: 'Second Tool', description: 'Compact editor',
      url: 'https://example.org/second', iconUrl: '/api/public/assets/branding/editor.png' },
    { ...tool('first', 1), name: 'First Tool', description: 'A useful tool',
      url: 'https://example.org/first', iconUrl: 'https://example.org/icon.svg' },
    { ...tool('bad', 3), name: 'Unsafe Tool', url: 'javascript:alert(1)' },
  ];
  assert.deepEqual(publishedToolCards(published).map(item => item.id), ['first', 'second']);
  assert.equal(safePublicToolIcon('/api/public/assets/branding/editor.png'),
    '/api/public/assets/branding/editor.png');
  assert.equal(safePublicToolIcon('https://example.org/image.webp'),
    'https://example.org/image.webp');
  assert.equal(safePublicToolIcon('data:image/svg+xml,evil'), null);
  assert.equal(safePublicToolIcon('https://example.org/icon.svg'), null);
  assert.equal(safePublicToolIcon('/vcon/private.png'), null);
  const html = renderToStaticMarkup(React.createElement(PublicToolsGrid, { tools: published }));
  assert.match(html, /First Tool/);
  assert.match(html, /Second Tool/);
  assert.match(html, /Compact editor/);
  assert.match(html, /Open Tool/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /loading="lazy"/);
  assert.doesNotMatch(html, /Unpublished Tool|Unsafe Tool|javascript:|<iframe/);
  const empty = renderToStaticMarkup(React.createElement(PublicToolsGrid, {
    tools: [published[0]],
  }));
  assert.match(empty, /No tools published yet/);
  const fallback = renderToStaticMarkup(React.createElement(PublicToolsGrid, {
    tools: [{ ...tool('fallback', 0), iconUrl: 'https://example.org/icon.svg' }],
  }));
  assert.doesNotMatch(fallback, /src="https:\/\/example.org\/icon.svg"/);
});

test('PN-01 P03: direct /tools route precedes existing 404 and public forms remain protected', () => {
  const app = source('src/App.tsx');
  const landing = source('src/components/LandingPage.tsx');
  const toolsPage = source('src/components/PublicToolsPage.tsx');
  assert.match(app, /const isPublicToolsPath = currentPath === '\/tools' \|\| currentPath === '\/tools\/'/);
  assert.match(app, /if \(!isAdminRoute && !isPublicHome && !isPublicToolsPath\)/);
  assert.match(app, /if \(!isAdminRoute && isPublicToolsPath\)/);
  assert.match(app, /<PublicToolsPage siteSettings=\{siteSettings\} \/>/);
  assert.ok(app.indexOf('if (!isAdminRoute && isPublicToolsPath)') <
    app.indexOf('// Root Public URL -> Landing Page'));
  assert.match(app, /currentPath === '\/check'/);
  assert.match(app, /<NotFoundPage/);
  assert.match(landing, /<PublicHeader siteSettings=\{siteSettings\} \/>/);
  assert.doesNotMatch(landing, /href="https:\/\/html\.vibid\.my\/"/);
  assert.match(landing, /siteSettings\.noticeBannerEnabled/);
  assert.match(landing, /siteSettings\.docsUrl/);
  assert.match(landing, /siteSettings\.telegramUrl/);
  assert.match(landing, /siteSettings\.discordUrl/);
  assert.match(landing, /setHeroLogoError/);
  assert.match(toolsPage, /api\.getPublicCatalog\(\)/);
  assert.match(toolsPage, /catalog=\{catalog\}/);
  assert.match(toolsPage, /role="alert"/);
  assert.match(toolsPage, /<PublicToolsGrid tools=\{catalog\?\.tools \?\? \[\]\} \/>/);
});

test('PN-01 P03: public /tools has a safe loading state and CI is source-only', () => {
  const html = renderToStaticMarkup(React.createElement(PublicToolsPage, {
    siteSettings: DEFAULT_SITE_SETTINGS,
  }));
  assert.match(html, /Loading published tools/);
  assert.match(html, /LicenX/);
  assert.match(html, /Portal Home/);
  const workflow = source('.github/workflows/pn01-public-catalog.yml');
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /npm ci --no-audit --no-fund/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /tests\/publicCatalogApi\.test\.ts/);
  assert.match(workflow, /tests\/publicCatalogUi\.test\.ts/);
  assert.match(workflow, /tests\/siteSettingsSync\.test\.ts/);
  assert.match(workflow, /tests\/publicAccessRoutes\.test\.ts/);
  assert.match(workflow, /npm run build/);
  // Match executable secret bindings/deploy commands, not explanatory comments.
  assert.doesNotMatch(workflow, /(^\s*run:\s*ssh\b)|docker compose up|\$\{\{\s*secrets\.|deploy-production|pull_request_target/m);
});
