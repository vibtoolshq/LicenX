# Primary LicenX SDK — Source and Feature Map

The installable **`licenx`** package lives in `SDK/client/python/licenx/`. Import with `from licenx import XLicenseClient`. The separate `SDK/x_license_python/` tree is the **reference SDK**, not the default for new integrations.

## SDK modules

| Source | Responsibility |
| --- | --- |
| [`__init__.py`](package-init.md) | Public SDK exports and version |
| [`client.py`](client.md) | `XLicenseClient` application facade |
| [`config.py`](config.md) | Python-first/legacy configuration |
| [`server.py`](server.md) | HTTPS transport and signature verification |
| [`login.py`](login.md) | Online login and authorization |
| [`logout.py`](logout.md) | Best-effort device unbind |
| [`device.py`](device.md) | HWID and local device metadata |
| [`storage.py`](storage.md) | Heartbeat and nonpersistent session handling |
| [`offline.py`](offline.md) | Online and limited outage/clock policy |
| [`example_app.py`](example-app.md) | Minimal example app |
| [`requirements.txt`](requirements.md) | Dependencies |

## Tests and diagnostics

- [Primary test/diagnostic console](diagnostic-console.md) and [test README](test-readme.md).
- [Login cleanup](test-login-cleanup.md), [heartbeat](test-heartbeat.md), [signature verification](test-signature-verification.md), [transport security](test-secure-transport.md), [session storage](test-storage-security.md) and [README contract](test-readme-quick-start.md).
- [Historical audit record](AUDIT_SUMMARY.md) documents prior evidence and may mention the older reference tree; it is **not** current production certification.

Run the primary tests from repository root:

```bash
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

For current installation instructions see the [primary SDK README](../../README.md), [English guide](../GUIDE_EN.md) and [বাংলা guide](../GUIDE_BN.md). The existing `x_license_python.zip` download is a separate **reference archive**, not the primary `licenx` wheel.
