# Configuration and site management

## Site Settings

In **Administration → Site Settings** (`/vcon/site-settings`), configure branding and site metadata: name, tagline, page title, description, logo/favicon/social image, footer, support/social URLs, documentation link, Buy License URL, public license check/reset switches, and notice banner. Select **Save** and confirm **Saved successfully**, then reload to confirm persistence.

An image upload requires configured storage; `SiteSettingsTab.handleFileUpload` enforces a 5 MiB client-side image limit and calls `/api/settings/upload`; successful upload attempts to auto-save the returned URL. **Reset** restores form defaults in client state; review before pressing Save. In HF-01, the editable 17-field projection excludes `publicNavigation` and `publicTools` from Site Settings Save while retaining published catalog data.

## Storage & DB

The **Storage & DB** tab exposes R2 configuration/testing, the server public key, credential updates and key rotation controls. Production PostgreSQL connection strings are configured on the server; do not interpret visible UI settings as permission to replace a live database.

## Public links and tools

The **Public → Nav Menu** and **Public → Tools** tabs maintain versioned published lists. See [Public catalog](features/public-catalog.md). Saved catalog items are not interchangeable with the editable 17 Site Settings fields.

## Runtime configuration

Environment names, defaults and feature gates are in [Configuration reference](../reference/configuration-reference.md). Do not copy a populated `.env` into documentation or Git. `README.md`, `.env.example`, `deploy/env.vps.example`, `compose.yaml` and `src/server/db.ts` are implementation evidence.

**Source:** `src/components/SiteSettingsTab.tsx`, `src/components/SettingsTab.tsx`, `src/types.ts:304-345`, `src/server/publicCatalog.ts:185-257`.