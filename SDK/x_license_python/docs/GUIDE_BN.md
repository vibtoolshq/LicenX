# Reference Python SDK — বাংলা গাইড

> **শুধু Reference / Legacy Compatibility।** এই নথি `SDK/x_license_python/`-এর পুরোনো `x_license_python` package বোঝায়। **নতুন Python application**-এর জন্য [primary `licenx` SDK](../../client/python/licenx/README.md) ও তার [বাংলা guide](../../client/python/licenx/docs/GUIDE_BN.md) অনুসরণ করুন।

## Reference package

- Code path: `SDK/x_license_python/`
- Python import: `from x_license_python import XLicenseClient`
- Server-এর বিদ্যমান `public/x_license_python.zip` এই reference source থেকে তৈরি হয়; primary `licenx` wheel নয়।
- Reference tests ও পূর্বের integrations-এর compatibility বজায় রাখতে এই package রাখা হয়েছে।

```bash
python -m pip install -r SDK/x_license_python/requirements.txt
```

```python
from x_license_python import SDKConfig, XLicenseClient

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

পুরোনো configuration-এর hostname, app identifier, app version ও trusted public key নিজের অনুমোদিত value দিয়ে সেট করুন। Client-এ server private key রাখা বা license key log করা যাবে না। Online signed verification, HWID binding, heartbeat ও logout নিয়ম আগের integration-এর ওপর নির্ভর করবে।

## নতুন Integration-এর সঠিক পদ্ধতি

```bash
python -m pip install ./SDK/client/python/licenx
```

```python
from licenx import XLicenseClient
```

Primary package `licenx.config.py` ব্যবহার করে; reference JSON/config flow-এর সঙ্গে মিশিয়ে ফেলবেন না। প্রকৃত client `app_version` দিন, server `min_version` নয়। বিস্তারিত: [বাংলা primary guide](../../client/python/licenx/docs/GUIDE_BN.md)। Reference test result production deployment certification নয়।
