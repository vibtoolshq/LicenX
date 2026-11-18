# LicenX Python SDK — `licenx`

**Primary Python client SDK for LicenX applications.** Version **1.2.6** (current source version; requires a compatible hardened Node/VPS server); Python **3.8+**. Package/install/import name: `licenx`. Repository overview: the root `README.md` in the trusted LicenX source checkout (not a file automatically installed next to this wheel metadata).

> **Single supported SDK:** `licenx` (installable from a verified wheel or the Admin's primary `licenx-python-sdk.zip` source kit). The reference SDK is retired. PyPI publication is not automatic.

## Installation

From the LicenX repository root:

```bash
python -m pip install ./SDK/client/python/licenx
```

Or run `python -m pip install .` within this package directory. The package depends on `cryptography>=41.0.0` for trusted RSA/Ed25519 response verification; optional `requests` transport has a standard-library `urllib` fallback. The release workflow can attach wheel and source distribution files to GitHub Releases; **PyPI publication requires an explicitly authorized release request and passing release workflow**.

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

### Optional per-device application statistics (SDK-STAT-01)

After a verified login, applications can explicitly send dynamic flat title/value pairs. Nothing is collected automatically. The first report performs an additional signed, nonce-bound validation solely to obtain a RAM-held report token; ordinary login/heartbeat request formats and logout proof remain unchanged:

```python
result = client.report_stats({"Total": 5000, "Send": 200, "Failed": 4800, "Logins": 4})
if not result["success"]:
    print("Statistics unavailable:", result["code"])
```

Statistics are **client-reported**, not trusted for billing or license permissions. Up to 40 arbitrary nonsecret labels (max 64 characters), with finite numbers, booleans, null, or strings (max 256 characters); flat JSON, 4096 UTF-8 bytes max. No nested objects, passwords, HWIDs, license keys or tokens. The report-only token is obtained from a verified signed response and kept only in RAM; every upload is checked against the current live server binding and rate limited. Older servers return `STATS_UNSUPPORTED`. Network, expired session and invalid statistics never silently succeed. Avoid reporting from a tight loop.

### Manual Heartbeat & Logout

On successful login, background heartbeats are enabled by default. Use `client.ping()` for an explicit check and `client.logout()` when the licensed operation ends. `logout()` returns **False** if the remote device release could not be confirmed; the SDK clears local authorization and retains a pending release **in memory** for an explicit retry. The remote logout path requires a session-bound v2 proof; there is **no anonymous v1/deactivate fallback**. Normal exit hooks attempt slot release, but abrupt termination/network failure cannot guarantee remote unbinding. **Do not log license keys, PINs or access tokens.** The basic example above prints the HWID for an *interactive demo only*; do not copy that identifier into unattended production logs.

A lifecycle-safe host integration uses a `finally` block after an authenticated login:

```python
from licenx import XLicenseClient

client = XLicenseClient()  # Read your trusted app-root licenx.config.py
result = client.login(input("License key: ").strip())
if not result.success:
    raise SystemExit(result.message)

try:
    print("Licensed tier:", client.get_tier())
    # Run only licensed host functionality while authorized.
finally:
    if not client.logout():
        print("Warning: remote device unbind was not confirmed")
```

For opt-in `useWebSocket=True`, distinguish `client.has_login_session()` (UI-only hint) from `client.is_authenticated()` or `client.is_valid()` (authorization status). A signed legacy `keep_login_on_network_error` metadata flag does **not** change the current opted-in worker's UI-hint retention behavior between true/false; after grace expires, protected operations remain blocked until a fresh verified HTTPS check.

The SDK deliberately does **not** persist license keys in reversible local session files. `auto_login()` commonly returns `NO_SAVED_SESSION`; prompt the user again or integrate your own secure OS-backed credential management. Initial login always requires online validation; configured outage grace applies only to allowed temporary conditions after validation.

## Public API

| Interface | Role |
| --- | --- |
| `XLicenseClient` | Primary application facade |
| `SDKConfig` | Load/discover client settings |
| `LoginResult` | Login result, `success`, `code`, `message`, optional `request_id` |
| `client.login(key)` | Signed online validation and binding |
| `client.ping()` | Explicit heartbeat |
| `client.report_stats({...})` | Opt-in per-device dynamic statistics snapshot |
| `client.logout()` | Logout and slot release request |
| `client.get_tier()`, `client.get_hwid()` | Active license information |

Other modules (`server`, `storage`, `device`, `offline`, `login`, `logout`) support the facade; direct low-level integration is not required for normal use.

## Documentation and testing

- [English integration guide](docs/GUIDE_EN.md) · [বাংলা integration guide](docs/GUIDE_BN.md)
- Extended configuration and API references: `SDK/client/python/docs/CONFIGURATION.md` and `SDK/client/python/docs/API_REFERENCE.md` (**repository-only; not included in a standard installed wheel or source ZIP**).
- Source-level historical feature notes: `SDK/client/python/licenx/docs/SDK feature/` (**repository-only and deliberately excluded from the source ZIP**).
- Diagnostic console and tests: `SDK/client/python/licenx/test/` (**repository-only; not included in the generated source ZIP**).

```bash
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

Use synthetic test credentials and a controlled endpoint; test-console full diagnostics can affect device bindings and logs on the selected server. A passing local suite is not a production certification.
