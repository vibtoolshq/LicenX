# Public navigation and tools catalog

Administrators manage both lists from **Public → Nav Menu** and **Public → Tools**. Public visitors see enabled links in the header and enabled tool cards at `/tools`.

## Publishing navigation

Load saved navigation in `/vcon/public-nav`; edit label, destination, order, target (same or new tab), and enabled status. Save through the versioned `PUT /api/admin/public-catalog` contract. The special `tools` route stays `/tools`; the canonical `buy-license` CTA destination is synchronized with Site Settings' `buyLicenseUrl`.

## Publishing external tools

In `/vcon/public-tools`, add/edit tool name, short description, HTTPS URL, optional image/icon, enabled status and order; save the tool collection. The public gallery shows **No tools published yet** when no enabled cards exist. Tool links are external; the card gallery does not host or execute tools.

## Validation and concurrency

`src/server/publicCatalog.ts` restricts IDs, text, item count (max **24 navigation items**, **100 tool items**), and link schemes; external destinations must be HTTPS and cannot target IP literals or local/internal hostnames. Image icons are bounded to supported raster extensions or the app's approved branding assets. Duplicate IDs and invalid item fields are rejected. Admin updates use a SHA-256 version token and conditional write to avoid silent overwrites; a stale token can return HTTP 409.

The public GET only includes enabled entries; admin GET includes disabled entries. Site Settings Save deliberately strips reserved `publicNavigation`/`publicTools` fields from its editable projection.

**Source:** `src/components/PublicNavMenuTab.tsx`, `PublicToolsTab.tsx`, `PublicHeader.tsx`, `PublicToolsPage.tsx`, `src/server/publicCatalog.ts:15-258`, `src/server/api.ts:3168-3285`.