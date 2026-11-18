# Public license portal and self-service

**URL:** `/` (also `/check` and `/home`), as routed by `src/App.tsx:36-43`. No administrator account is needed to open the page. Whether particular actions work is controlled by Site Settings.

## Quick license check

Enter a license key and select **Check License**. `LandingPage.handleQuickCheck` calls `POST /api/v1/user/license/check`, which returns status, device limit and number of active bindings. If public checking is disabled, the server returns HTTP 403. A missing key gives 400 and an unknown key 404.

**Important:** This request may update an expired license's stored status to `expired`. It is a user-facing status query, but not guaranteed database read-only. It does not create a device binding.

## PIN-protected license control

Enter the same license key and the separate four-digit PIN to open the device control panel (`POST /api/v1/user/control/open`). A successful response exposes the license's validity and active device details. Wrong PIN gives 403 and repeated failures can trigger 429 `Retry-After`.

Choose the reset action only if you intend to sign out active devices. `POST /api/v1/user/control/reset` is protected by the PIN and the `allowPublicReset` setting. It marks active bindings as logged out, frees the slots and records a reset audit event. No self-service unbind should be presented as harmless.

## Product availability

The site header can show configured navigation links and a Buy License CTA; LicenX's UI **does not implement an end-to-end payment checkout** in the inspected scope. CTA points to an admin-configured URL or can be disabled when the URL is `#`.

**Source:** `src/components/LandingPage.tsx:183-238`, `PublicHeader.tsx`, `src/server/api.ts:1768-2060`, `src/server/publicAccessSettings.ts`.