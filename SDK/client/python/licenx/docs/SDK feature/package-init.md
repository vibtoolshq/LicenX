# Package Exports and Version

Source: `SDK/client/python/licenx/__init__.py`

## Role

This module is the package's stable import surface. It re-exports the high-level client, configuration, device manager, transport, session worker, policy guard, login result/manager, and logout manager so applications can use `from licenx import XLicenseClient` without importing internal modules.

## Public API

`__all__` lists the names exported by `from licenx import *`. Compatibility aliases include `ServerClient`, `LicenseStorage`, and `OfflineLicenseManager`; they refer to the same implementations as their canonical class names.

`__version__` is **`1.2.6`** in the current source and must remain aligned with `[project].version` in `pyproject.toml`. The SDK release workflow checks the `python-sdk-vX.Y.Z` tag against the **`pyproject.toml` version**, with tests and distribution checks before publishing. Do not infer this version from the server application's version policy.

## Example

```python
from licenx import SDKConfig, XLicenseClient, __version__

print(__version__)
client = XLicenseClient()  # Requires a valid discovered application config before login
```

The client version above is the integrating application's release, not this SDK package version. Use `SDK/client/python/licenx/__init__.py` for the exact 11 exported symbols in v1.2.6; `SDKConfigError` is importable from `licenx.config`, but is not re-exported from the package root.
