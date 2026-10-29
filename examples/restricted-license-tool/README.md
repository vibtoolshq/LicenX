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

## Provision exactly one restricted consumer (authorized administrator only)

1. In LicenX Admin, identify the exact intended `app_id` and approved tool backend (DNS and TLS).
2. Use the **existing authenticated** `POST /api/admin-api-keys` manager operation (admin session plus CSRF) with this request **body**:
   ```json
   {"name":"Approved tool backend","prefix":"check","permissions":["licenses:check"],"app_id":"EXISTING_APP_ID"}
   ```
3. Store the returned one-time `secret` in the **tool backend's** secret manager, never in Git, HTML, JavaScript, CDN, source map or request logs. It is a privileged membership credential. Existing ordinary Admin APIs `licenses:read` or `admin:*` keys **cannot** access this new route.
4. Test only with synthetic, explicitly authorized test licenses in an isolated environment. Revoke by deleting the consumer key through the existing authenticated Admin API management route. No actual production key is created by this repository example.

The current Admin APIs UI may not list `licenses:check` as a preset; using the existing authenticated creation API is intentional. No management UI was added.

## Controlled server rollout

1. Ensure the GitHub commit passed required CI, have a backup and rollback reference, and safely fast-forward the VPS checkout.
2. With `PUBLIC_LICENSE_CHECK_ENABLED` **unset or `false`**, run `docker compose config -q`, rebuild only the app and check `https://YOUR_LICENX_DOMAIN/api/ready`. This safely deploys the route in **disabled** mode, without provisioning credentials.
3. Disabled-route smoke (no credentials or real license key; use a fictitious key) must return HTTP `503` with `UNAVAILABLE`, no sensitive data. Example:
   ```bash
   curl --fail-with-body -i -X POST https://YOUR_LICENX_DOMAIN/api/v1/public/license/check \
     -H 'Content-Type: application/json' \
     --data '{"license_key":"DEMO-INVALID-KEY"}'
   ```
   `curl` exits nonzero for expected `503`; inspect the printed status/body.
4. **Only when an approved real tool backend and app are identified**, install a random server-only `PUBLIC_LICENSE_CHECK_RATE_SECRET` of at least 32 characters in private VPS configuration and set `PUBLIC_LICENSE_CHECK_ENABLED=true`; restart only the app as a controlled change. The Compose defaults remain disabled. On Cloudflare configure equivalent *private* binding values separately.
5. Run an authorized own-app positive/negative test from the approved tool server, verify no license/device mutations, rate limits, key revocation and `no-store` headers, then enable the tool action at the trusted backend.

**Never paste any real consumer token, backup recovery key or license key into ChatGPT, GitHub, screenshots or an exported log.** Do not auto-enable the feature or create a default credential. Disable with `PUBLIC_LICENSE_CHECK_ENABLED=false` and recreate only the app if unexpected behavior is observed.

## Test the example

```bash
node --test tests/restrictedPublicLicenseTool.test.mjs
```

This test uses a mocked LicenX fetch, ephemeral loopback Node HTTP servers and synthetic keys. It makes **no production request**. No extra package dependencies are needed.

The example `/tool/run` handler returns a harmless placeholder message. **Replace that statement with the actual backend-only tool operation after the approved integration has been reviewed and scoped.** The shown example is not a packaged/hosted user tool, and production activation remains an operator approval gate.
