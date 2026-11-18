# LicenX Python SDK — Integration Guide (English)

**Single supported Python SDK:** `licenx`, using literal app-root `licenx.config.py` and a verified wheel or primary source kit.


## 1. Install

From the LicenX repository root, with Python 3.8+:

```bash
python -m pip install ./SDK/client/python/licenx
```

`cryptography` is required to validate signed server responses. The optional `requests` HTTP transport falls back to `urllib`. A tagged release may provide `licenx` wheel/sdist assets on GitHub; the repository does not automatically publish to PyPI.

## 2. Configure the client

Create `licenx.config.py` next to your application entry point:

```python
app_config = {
    "server_url": "https://license.example.com",
    "app_name": "my_app_slug",
    "app_version": "1.0.0",
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "ping_interval_seconds": 1200,
    "offline_grace_seconds": 0,
    "auto_logout_on_exit": True,
    "enable_background_heartbeat": True,
}
```

Replace the example hostname, app slug, version and public key with **real, administrator-provisioned** values. The public key must be a trusted RSA/Ed25519 verification key; never embed the server's private key. Set `app_version` to the actual installed application release, not the server's `min_version` policy field.

The SDK uses a data-only Python configuration loader; ambiguous discovered config files fail rather than silently choosing an arbitrary one. Existing integrations may continue using supported legacy JSON config.

## 3. Login and protect your application

```python
from licenx import XLicenseClient

client = XLicenseClient()
result = client.login(input("Enter license key: ").strip())
if not result.success:
    raise SystemExit(f"Denied: {result.message} ({result.code})")

try:
    print("Licensed tier:", client.get_tier())
    # Start protected functionality here.
finally:
    client.logout()
```

Never print full license keys, response tokens or user HWIDs in unattended logs. `LoginResult` exposes `success`, `message`, `code` and an optional sanitized `request_id` for support correlation.

## 4. Validation and session lifecycle

1. The SDK sends the license key, HWID, app identifier/version and a fresh challenge to the configured HTTPS service.
2. The server applies app/license/device restrictions and signs the response; the SDK validates the trusted signature, request identity and nonce. A mismatch **fails closed**.
3. A successful login can start a background heartbeat (default 1,200 seconds; policy range 60–1,200 seconds).
4. Use `client.ping()` for an explicit heartbeat; use `client.logout()` for explicit release. Exit handlers make a best-effort cleanup request.
5. Initial login requires a live validation call. Only recognized transient outages after prior validation can use configured grace (0–3,600 seconds). Explicit denial or signature failure is not covered by grace.
6. Local license-key persistence is disabled. `auto_login()` normally reports no stored session; a secure app-owned key store is separate functionality.

**Client login does not require the customer's license-control PIN.** That PIN is for the server's allowed public self-service device-control flow.

## 5. Distribution and compatibility

- Primary package: `SDK/client/python/licenx/` → `import licenx`.

The extended config and API references live in the **repository-only** paths `SDK/client/python/docs/CONFIGURATION.md` and `SDK/client/python/docs/API_REFERENCE.md`. The package README is `SDK/client/python/licenx/README.md` in a source checkout/source ZIP, but it is not one of the three installed wheel package-data documents. For an installed SDK, start at [the bundled documentation index](README.md); do not assume repository-relative links are present.

## 6. Test safely

From the repository root:

```bash
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

The included diagnostic test console can issue real validation/logout requests and may create device bindings or logs if pointed at a live service. Use isolated, explicitly authorized credentials. Local tests do not certify a deployed instance.

## 7. Optional realtime and authorization versus UI continuity (v1.2.6)

For compatible applications, explicitly opt in with `"useWebSocket": True` in the literal `app_config` (Boolean, not a string), install the optional `websocket-client` transport (`licenx[realtime]` extra), and have an operator enable the Node realtime gateway plus the app's WebSocket permission. Existing HTTP clients remain HTTP-only. A global/unscoped license cannot acquire the device-bound WSS ticket and continues using verified HTTPS.

After signed online login, the worker obtains a short-lived ticket and requires a trusted signed, app/device-bound `license.snapshot`. Socket opens, unsigned change frames and UI hints **never** grant licensed privileges. The worker may report `CONNECTING`, `CONNECTED`, `RECONNECTING`, `HTTP_FALLBACK`, `OFFLINE_GRACE`, `PAUSED_UNVERIFIED` or `INVALIDATED` through `get_connection_state()`. Handle `on_connection_state_change(state)` on a worker thread; GUI code must marshal UI updates to its main thread.

When temporary transport failure exceeds `offline_grace_seconds`, opted-in clients can retain `has_login_session() == True` as **UI-only memory**, while `is_authenticated()` and `is_valid()` return **False** and protected operations remain blocked. Recovery requires a newly verified nonce-bound HTTPS heartbeat. The source stores the signed server `keep_login_on_network_error` Boolean but **does not use its ON/OFF value to change that UI-hint retention behavior** in v1.2.6; both values behave the same for this purpose. Do not promise that the OFF setting automatically removes the visible login session. HTTP-only clients have their separate invalidation behavior. Signed revoked/expired/unbound proof invalidates regardless of UI continuity.

## 8. Error handling and operational safety

- `LoginResult` has `success`, `status_code`, `message`, `code`, `license_data`, `hwid`, `license_key`, and optional `request_id`. Never log the credential fields. Empty key returns `EMPTY_KEY`; a missing saved key returns `NO_SAVED_SESSION` for `auto_login()`; a failed previous logout can block a replacement login with `PREVIOUS_SESSION_LOGOUT_FAILED`.
- `client.login(key, pin=None)` accepts a legacy `pin` parameter but **ignores it**. The PIN is only for public portal control, not the signed SDK login route.
- `logout()` returns `bool`: a `False` result means the server-side slot release was **not confirmed**. The client clears local authorization, stores an in-RAM pending release, and can explicitly retry; force termination cannot guarantee cleanup. There is no anonymous legacy logout fallback.
- `ping()` returns a response dictionary; without an authenticated key it returns `NOT_AUTHENTICATED`. Signed negative proof, TLS errors and signature failures have different recovery rules. Only a **verified** server response is an authorization decision.
- For more than facade methods, consult the **repository-only** extended `SDK/client/python/docs/API_REFERENCE.md` and `CONFIGURATION.md`. These references and the historical source-map notes are **not** among the wheel's three declared packaged Markdown files; use [bundled docs](README.md) from an installed distribution.

**Evidence:** `licenx/client.py`, `realtime.py`, `storage.py`, `server.py`, `logout.py`, `test/test_realtime.py`, and the package metadata. This guide was aligned by source inspection; installation/GUI/network requests were **not executed** for this audit.
