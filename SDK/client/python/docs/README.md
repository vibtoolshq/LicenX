# LicenX Python SDK — Developer Docs

**Single supported Python SDK:** `licenx`, using literal app-root `licenx.config.py` and a verified wheel or primary source kit.


| Read | Purpose |
| --- | --- |
| [English integration guide](GUIDE_EN.md) | Setup, login, heartbeat, logout, security |
| [বাংলা integration guide](GUIDE_BN.md) | একই integration flow বাংলায় |
| [Configuration](CONFIGURATION.md) | `licenx.config.py`, version and trust anchor |
| [API reference](API_REFERENCE.md) | Public `licenx` facade and responses |
| [Package README](../licenx/README.md) | Install and quick start |

For new integrations, install `python -m pip install ./SDK/client/python/licenx` from repository root. Create an app-root `licenx.config.py`, set the real `app_version` and trusted `public_key_pem`, then call `XLicenseClient().login(key)` and `logout()` when finished. The SDK does not persist license keys or permit offline initial login.

