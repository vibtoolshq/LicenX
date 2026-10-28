# LicenX Python SDK — `licenx`

**Primary Python client SDK for LicenX applications.** Version **1.2.3**; Python **3.8+**. Package/install/import name: `licenx`. Repository overview: [LicenX README](../../../../README.md).

> `SDK/x_license_python` is a **reference/compatibility implementation**. The existing admin `x_license_python.zip` download contains that reference implementation, **not** the installable `licenx` wheel.

## Installation

From the LicenX repository root:

```bash
python -m pip install ./SDK/client/python/licenx
```

Or run `python -m pip install .` within this package directory. The package depends on `cryptography>=41.0.0` for trusted RSA/Ed25519 response verification; optional `requests` transport has a standard-library `urllib` fallback. The release workflow can attach wheel and source distribution files to GitHub Releases; **PyPI publication is not automatic**.

## Configuration

Create `licenx.config.py` in the **application root**. The SDK reads this as a data-only `app_config` dictionary (it does not execute arbitrary config statements):

```python
app_config = {
    "server_url": "https://license.example.com",
    "app_name": "my_app_slug",
    "app_version": "1.0.0",  # Actual running app version
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "ping_interval_seconds": 1200,
    "offline_grace_seconds": 0,
}
```

Replace the placeholder public key with the trusted public key provisioned by your LicenX administrator. The `app_version` must describe the running client; do **not** substitute server policy `min_version`. A missing/invalid trust anchor or required app version fails closed. Legacy JSON configuration is supported for existing users.

## Quick start

### Basic Integration

```python
from licenx import XLicenseClient

client = XLicenseClient()
license_key = input("Enter license key: ").strip()
result = client.login(license_key)

if not result.success:
    raise SystemExit(f"Login failed: {result.message} ({result.code})")

print(f"License Activated! Tier: {client.get_tier()}")
print(f"Hardware ID: {result.hwid}")
```

### Manual Heartbeat & Logout

On successful login, background heartbeats are enabled by default. Use `client.ping()` for an explicit check and `client.logout()` when the licensed operation ends. Normal exit hooks also attempt slot release, but abrupt termination/network failure cannot guarantee remote unbinding. **Do not log license keys, PINs or access tokens.**

The SDK deliberately does **not** persist license keys in reversible local session files. `auto_login()` commonly returns `NO_SAVED_SESSION`; prompt the user again or integrate your own secure OS-backed credential management. Initial login always requires online validation; configured outage grace applies only to allowed temporary conditions after validation.

## Public API

| Interface | Role |
| --- | --- |
| `XLicenseClient` | Primary application facade |
| `SDKConfig` | Load/discover client settings |
| `LoginResult` | Login result, `success`, `code`, `message`, optional `request_id` |
| `client.login(key)` | Signed online validation and binding |
| `client.ping()` | Explicit heartbeat |
| `client.logout()` | Logout and slot release request |
| `client.get_tier()`, `client.get_hwid()` | Active license information |

Other modules (`server`, `storage`, `device`, `offline`, `login`, `logout`) support the facade; direct low-level integration is not required for normal use.

## Documentation and testing

- [English integration guide](docs/GUIDE_EN.md) · [বাংলা integration guide](docs/GUIDE_BN.md)
- [Configuration reference](../docs/CONFIGURATION.md) · [API reference](../docs/API_REFERENCE.md)
- [SDK feature/source index](docs/SDK%20feature/README.md) · [Diagnostic test console](test/README.md)

```bash
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

Use synthetic test credentials and a controlled endpoint; test-console full diagnostics can affect device bindings and logs on the selected server. A passing local suite is not a production certification.
