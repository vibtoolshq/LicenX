# LicenX Python SDK — Public API Reference

**Primary supported package:** [`licenx`](../licenx/README.md), version 1.2.3 at the tracked manifest. `SDK/x_license_python` remains reference-only. No API behavior changed by this document.

```python
from licenx import SDKConfig, XLicenseClient, LoginResult

client = XLicenseClient()  # Discover app-root licenx.config.py
result: LoginResult = client.login("YOUR_LICENSE_KEY")
if result.success:
    print(client.get_tier())
    client.ping()  # Optional; background heartbeat starts on successful login
    client.logout()
```

| Name | Responsibility |
| --- | --- |
| `SDKConfig` | Config model; `from_discovered_file()` and `from_python_file(path)` for Python-first config |
| `XLicenseClient(config=...)` | Create client with explicit config, or use default discovery |
| `client.login(key)` | Online, signed license validation and device authorization |
| `client.auto_login()` | Retry saved session if available; this SDK does not persist license keys |
| `client.ping()` | Send a signed-challenge heartbeat |
| `client.logout()` | Request remote release of device binding |
| `client.get_tier()`, `client.get_hwid()` | License tier and bound HWID information |
| `LoginResult` | `success`, `status_code`, `message`, `code`, `hwid`, optional `request_id` |

**Trust boundary:** Configure the real client `app_version` and an administrator-provided `public_key_pem`; do not accept signing keys from the same unauthenticated response you are trying to verify. Initial login requires online verification. The customer PIN is not needed for the client login route.

Full integration docs: [English](../licenx/docs/GUIDE_EN.md) · [বাংলা](../licenx/docs/GUIDE_BN.md).
