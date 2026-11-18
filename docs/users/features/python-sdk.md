# Integrating a Python application with LicenX

The maintained package is `SDK/client/python/licenx/`, version **1.2.6** in `SDK/client/python/licenx/pyproject.toml` and the flat-layout module `SDK/client/python/licenx/__init__.py`. The historic `SDK/x_license_python` tree is no longer present in this checkout.

## Install from source

```bash
python -m pip install ./SDK/client/python/licenx
```

Create an app-root `licenx.config.py` based on the maintained template. It must specify the registered application name, actual running `app_version`, HTTPS LicenX server origin, and administrator-trusted public verification key (do not retrieve it blindly at login). Check [SDK configuration](../../../SDK/client/python/docs/CONFIGURATION.md) for the exact validated fields and discovery precedence.

## Client lifecycle

```python
from licenx import XLicenseClient

client = XLicenseClient()
result = client.login(input("License key: ").strip())
if not result.success:
    raise SystemExit(result.message)
try:
    print("Licensed tier:", client.get_tier())
finally:
    client.logout()
```

`XLicenseClient.login` uses signed server validation, while `ping` and the heartbeat manager maintain lease policy; explicit `logout()` **requests** signed-session-proof v2 device release; its Boolean result indicates whether the remote release was confirmed. The SDK also exposes `is_authenticated`, `get_license_info`, `get_hwid` and diagnostics. The SDK intentionally does not persist customer license keys as a default auto-login mechanism; `auto_login` can report no saved session.

Optional realtime is gated by server policy and client opt-in. Network-unavailable “keep login” hints never authorize previously unverified licensed operations. Do not assume that a successful source test is a live deployment acceptance.

**Source:** `SDK/client/python/licenx/client.py:15-320`, `config.py`, `login.py`, `offline.py`, `realtime.py`, `README.md`, `SDK/client/python/docs/`, `src/server/api.ts:2091-2790`.