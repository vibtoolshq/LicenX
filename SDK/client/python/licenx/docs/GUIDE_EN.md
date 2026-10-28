# LicenX Python SDK — Integration Guide (English)

**Use `licenx` for production application integration.** This guide covers the installable package under `SDK/client/python/licenx/`; `SDK/x_license_python/` is a separate reference/compatibility tree.

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
- Legacy/reference implementation: `SDK/x_license_python/` → `import x_license_python`.
- Existing `x_license_python.zip` download is built from the reference tree; it is **not** a `licenx` wheel.

For config fields and public methods see the [configuration reference](../../docs/CONFIGURATION.md), [API reference](../../docs/API_REFERENCE.md) and [package README](../README.md).

## 6. Test safely

From the repository root:

```bash
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

The included diagnostic test console can issue real validation/logout requests and may create device bindings or logs if pointed at a live service. Use isolated, explicitly authorized credentials. Local tests do not certify a deployed instance.
