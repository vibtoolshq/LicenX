# Restricted License Tool — Backend Integration Example

**Audience:** an approved website/tool **backend**, not public browser JavaScript. This self-contained Node.js example demonstrates LicenX membership gating for one protected action. It is not a user-identity login system and does not implement your actual tool logic.

**LicenX endpoint:** `POST /api/v1/public/license/check`; **read-only**, app-scoped, no device binding or license activation. The validator remains disabled by default.

## Boundary and flow

1. A user supplies a license key to the tool backend via HTTPS `POST /tool/run` with JSON `{"license_key":"..."}`.
2. The backend keeps its `LICENX_CONSUMER_TOKEN` private; the browser never receives it. It calls the fixed LicenX HTTPS origin with that Bearer token and the license key.
3. The backend checks `valid:true`, `status:"active"`, timestamp and expiry, then executes the *example placeholder action*. All denied/unknown/suspended/expired/unactivated keys fail closed.
4. Every protected action **rechecks** authorization with LicenX. It does not create a persistent user session, store license keys or allocate a LicenX device slot.

The browser `Origin` header can be checked against the configured tool origin but **does not authenticate callers**. A CLI request can omit `Origin`; its license key is the membership credential. Protect any valuable tool action on this backend, not by hiding browser UI. License keys can be shared; this is **not proof of human identity**. Use a separate session/identity mechanism if required.

## Run locally (with an approved, separately configured test backend)

Requirements: Node.js 24+ (Node built-ins only), a reachable LicenX endpoint, valid HTTPS and a private server-only consumer key. No direct browser bearer key.

| Environment | Purpose |
| --- | --- |
| `LICENX_API_BASE_URL` | Exact LicenX root origin (e.g. `https://license.example.com`, no path/query) |
| `LICENX_CONSUMER_TOKEN` | **Secret** `vcon_sec_...` token; only in private server environment |
| `TOOL_PUBLIC_ORIGIN` | Exact public HTTPS origin of the approved tool |
| `PORT` | Optional loopback listening port, default `3001` |

```bash
# Provide the required variables through a private secret manager / environment.
node examples/restricted-license-tool/server.mjs
```

The service listens on `127.0.0.1:3001`, not on a public interface. Publish only behind your trusted HTTPS reverse proxy with request/body limits and proxy-side rate limiting. Make sure the proxy forwards requests to `/tool/run`; never expose the backend's environment or logs.

The built-in sample also applies a small **per-socket-IP 10/minute** in-memory limit, a 1 KiB input limit, no CORS wildcard, no-store responses, 5-second LicenX timeout and strict no-redirect upstream requests. It does not provide a multi-instance shared rate limit: use the tool's trusted proxy/edge protections for larger deployments.

## Admin Panel: approve domains and control access

1. Open **Admin Panel → Admin APIs → Public API**. The global Public API switch is **OFF by default**. Use a verified HTTPS domain (e.g., `https://tools.example.com`) and choose the associated LicenX application.
2. Click **Add Domain & Generate Token**. The server creates an app-scoped `licenses:check`-only consumer credential, stores its hash and returns the token **once**. Save it in the approved tool backend's private secret manager.
3. Put exactly that domain origin in the tool server's `TOOL_PUBLIC_ORIGIN` setting. The sample connector automatically sends `X-LicenX-Tool-Origin` with the private Bearer credential. An unknown domain, disabled domain, revoked credential or wrong app is denied.
4. From the same panel, enable/disable the global API, disable individual domains, or permanently revoke domains/credentials. A revoked domain must be re-registered to receive a new token. No production token is created by checking out this example.

**Security boundary:** The domain claim is supplied by the calling backend and can be forged. Access security comes from the unique, server-held, revocable credential bound to its registered domain and app. Do not put the token in Git, HTML, public JS or logs.

## Controlled server rollout

1. Ensure the GitHub commit passed required CI, have a backup and rollback reference, and safely fast-forward the VPS checkout.
2. With the admin database's new Public API switch **OFF** (the migration default), run `docker compose config -q`, rebuild only the app and check `https://YOUR_LICENX_DOMAIN/api/ready`. This safely deploys the route in **disabled** mode, without provisioning credentials.
3. Disabled-route smoke (no credentials or real license key; use a fictitious key) must return HTTP `503` with `UNAVAILABLE`, no sensitive data. Example:
   ```bash
   curl --fail-with-body -i -X POST https://YOUR_LICENX_DOMAIN/api/v1/public/license/check \
     -H 'Content-Type: application/json' \
     --data '{"license_key":"DEMO-INVALID-KEY"}'
   ```
   `curl` exits nonzero for expected `503`; inspect the printed status/body.
4. **Admin-controlled activation:** the database migration generates a private random rate-limit secret automatically. Once the approved domain and app-scoped token are registered through **Admin APIs → Public API**, use that panel's global enable switch. Compose permits control by default but the database flag starts **disabled**. The deployment owner may set `PUBLIC_LICENSE_CHECK_ENABLED=false` as an emergency override; an explicitly configured `PUBLIC_LICENSE_CHECK_RATE_SECRET` is optional. Cloudflare requires its own migrated database/bindings.
5. Run an authorized own-app positive/negative test from the approved tool server, verify no license/device mutations, rate limits, key revocation and `no-store` headers, then enable the tool action at the trusted backend.

**Never paste any real consumer token, backup recovery key or license key into ChatGPT, GitHub, screenshots or an exported log.** Do not auto-enable the feature or create a default credential. Disable with `PUBLIC_LICENSE_CHECK_ENABLED=false` and recreate only the app if unexpected behavior is observed.

## Test the example

```bash
node --test tests/restrictedPublicLicenseTool.test.mjs
```

This test uses a mocked LicenX fetch, ephemeral loopback Node HTTP servers and synthetic keys. It makes **no production request**. No extra package dependencies are needed.

The example `/tool/run` handler returns a harmless placeholder message. **Replace that statement with the actual backend-only tool operation after the approved integration has been reviewed and scoped.** The shown example is not a packaged/hosted user tool, and production activation remains an operator approval gate.
