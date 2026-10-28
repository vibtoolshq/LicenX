# Reference Python SDK — English Guide

> **Reference/legacy compatibility only.** This guide describes `x_license_python` from `SDK/x_license_python/`. For all **new** LicenX Python application integrations, use the [primary `licenx` package](../../client/python/licenx/README.md) and its [English guide](../../client/python/licenx/docs/GUIDE_EN.md). Do not interchange imports, configuration files or package distributions.

## Reference setup

The reference package is retained for older integrations, compatibility tests and the existing `public/x_license_python.zip` archive. From repository root, reference tests can be run with:

```bash
python -m pip install -r SDK/x_license_python/requirements.txt
PYTHONPATH=SDK python -m unittest discover -s SDK/x_license_python/test -p "test_*.py"
```

On Windows, set `PYTHONPATH=SDK` in the active shell before the unittest command. This reference tree imports as `x_license_python`, **not** `licenx`.

## Legacy API example

```python
from x_license_python import XLicenseClient, SDKConfig

config = SDKConfig.from_file("my_app_vcon_config.json")
client = XLicenseClient(config)
result = client.login("YOUR_LICENSE_KEY")
if not result.success:
    raise SystemExit(result.message)
try:
    client.ping()
finally:
    client.logout()
```

Replace the placeholder license key, server URL and verification key with approved values in your own legacy configuration. Never commit private keys or user credentials. The reference client validates signed server responses, handles HWID/heartbeat/logout and remains subject to its version and online-verification requirements.

## Distribution and security boundary

- **Reference:** `SDK/x_license_python/` → `import x_license_python`.
- **Primary, supported application integration:** `SDK/client/python/licenx/` → `import licenx`.
- The current server/admin `x_license_python.zip` contains the reference implementation. It is **not** the primary installable `licenx` wheel.
- Before shipping an application, obtain a trusted server public verification key and set the real client `app_version`. A server policy `min_version` is not a replacement.

Use the [primary configuration guide](../../client/python/docs/CONFIGURATION.md) for new projects. Reference tests and guide examples are not evidence of a live production deployment.
