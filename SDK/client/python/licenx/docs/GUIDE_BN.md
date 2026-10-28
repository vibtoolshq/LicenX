# LicenX Python SDK — Integration Guide (বাংলা)

**নতুন Python application-এর primary SDK হলো `licenx`**, path `SDK/client/python/licenx/`। `SDK/x_license_python/` শুধু reference/legacy compatibility-র জন্য রাখা হয়েছে।

## ১. Install

Python 3.8+ দিয়ে repository root থেকে:

```bash
python -m pip install ./SDK/client/python/licenx
```

সঠিক package import হবে `from licenx import XLicenseClient`। Signed license response যাচাইয়ের জন্য `cryptography` প্রয়োজন। HTTP transport-এর `requests` optional; standard-library `urllib` fallback আছে। GitHub release wheel/sdist তৈরি করতে পারে, কিন্তু PyPI-তে automatic publish করে না।

## ২. Application config

আপনার application-এর root-এ `licenx.config.py` তৈরি করুন:

```python
app_config = {
    "server_url": "https://license.example.com",
    "app_name": "my_app_slug",
    "app_version": "1.0.0",
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "ping_interval_seconds": 1200,
    "offline_grace_seconds": 0,
    "auto_logout_on_exit": True,
    "enable_background_heartbeat": True,
}
```

`server_url`, `app_name`, `app_version` এবং `public_key_pem`-এ নিজের approved value ব্যবহার করুন। **`app_version` হলো running client-এর প্রকৃত version; server policy `min_version` নয়।** Private signing key কখনো client-এ রাখবেন না। Config file data-only হিসেবে parse হয়; এটি execute করা হয় না। পুরোনো supported JSON config বিদ্যমান integration-এ ব্যবহার করা যায়।

## ৩. Login ও app protection

```python
from licenx import XLicenseClient

client = XLicenseClient()
result = client.login(input("License key: ").strip())
if not result.success:
    raise SystemExit(f"License denied: {result.message} ({result.code})")

try:
    print("Tier:", client.get_tier())
    # এখানে license-protected app logic চলবে।
finally:
    client.logout()
```

SDK license key স্বয়ংক্রিয়ভাবে local file-এ save করে না। তাই restart-এর পর সাধারণত আবার key প্রয়োজন হয়। `auto_login()`-এর জন্য persistent saved session আশা করবেন না। License key/PIN/secret debug log-এ print করবেন না।

## ৪. Validation ও session lifecycle

- Online `login()` server-এর সঙ্গে যোগাযোগ করে; app/HWID/device limit এবং signed response যাচাই করে। Wrong signature, identity বা challenge হলে access deny হয়।
- Login সফল হলে background heartbeat শুরু হতে পারে (default 1,200 সেকেন্ড; configured সীমা 60–1,200)।
- প্রয়োজন হলে `client.ping()` এবং কাজ শেষে `client.logout()` চালান। Exit hooks best-effort; force kill/network failure-এ server unbind নিশ্চিত নয়।
- Initial login **offline নয়**। পূর্বে verified session-এর কিছু transient outage-এ configured 0–3,600 সেকেন্ড grace প্রযোজ্য হতে পারে; explicit denial বা signature failure-এ নয়।
- Client SDK login-এর জন্য **customer PIN লাগে না**। PIN হলো অনুমোদিত self-service device-control/reset flow-এর credential।
- Support diagnosis-এর জন্য `LoginResult.request_id` optional sanitized request ID দিতে পারে; license key expose করবেন না।

## ৫. Reference বনাম primary

| ব্যবহার | Path / import |
| --- | --- |
| নতুন production integration | `SDK/client/python/licenx/` → `import licenx` |
| Reference/legacy compatibility | `SDK/x_license_python/` → `import x_license_python` |
| Server-এর পুরোনো `x_license_python.zip` | Reference package archive; primary wheel নয় |

আরও দেখুন: [Config guide](../../docs/CONFIGURATION.md), [API reference](../../docs/API_REFERENCE.md), [Package README](../README.md)।

## ৬. Safe testing

```bash
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

Diagnostic console-এ live hostname/license দিলে server-side binding/log তৈরি হতে পারে। Production credentials দিয়ে পরীক্ষা করবেন না; isolated authorized test data ব্যবহার করুন। Local tests production readiness-এর প্রমাণ নয়।
