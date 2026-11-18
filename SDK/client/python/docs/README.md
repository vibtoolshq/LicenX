# LicenX Python SDK — Developer Docs

**Single supported Python SDK:** `licenx`, using literal app-root `licenx.config.py` and a verified wheel or primary source kit.


| Read | Purpose |
| --- | --- |
| [English integration guide](GUIDE_EN.md) | Setup, login, heartbeat, logout, security |
| [বাংলা integration guide](GUIDE_BN.md) | একই integration flow বাংলায় |
| [Configuration](CONFIGURATION.md) | `licenx.config.py`, version and trust anchor |
| [API reference](API_REFERENCE.md) | Public `licenx` facade and responses |
| [Package README](../licenx/README.md) | Install and quick start |

**Documentation ownership:** This directory (`SDK/client/python/docs/`) is a **repository-level technical reference**, not a wheel package-data directory or part of the generated primary SDK ZIP. Installed wheels include only `licenx/docs/README.md`, `GUIDE_EN.md`, and `GUIDE_BN.md` as declared by `pyproject.toml`. The historical `licenx/docs/SDK feature/` source notes are repository-only. No documentation file's presence in source should be treated as proof that it ships in a particular release artifact.

For new integrations, install `python -m pip install ./SDK/client/python/licenx` from repository root. Create an app-root `licenx.config.py`, set the real `app_version` and trusted `public_key_pem`, then call `XLicenseClient().login(key)` and `logout()` when finished. The SDK does not persist license keys or permit offline initial login.

[SDK-DFSE forensic audit and traceability](SDK_DFSE_AUDIT_2026-11-18.md) contains verified public API coverage, documentation findings, and distribution/testing limits.

