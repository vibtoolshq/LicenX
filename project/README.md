# LicenX — Product and Developer Guide

এই নথি LicenX-এর বাস্তব user flow, API boundary ও source structure-এর সংক্ষিপ্ত নির্দেশিকা। বিস্তারিত install/operation: [Root README](../README.md)।

## System boundaries

| Actor | Access | দায়িত্ব |
| --- | --- | --- |
| Administrator | `/vcon` (admin login) | Application, license, device, API keys, branding, storage ও backup control |
| Customer | Public portal | License status; অনুমোদিত self-service reset-এর জন্য license PIN |
| Licensed application | Signed REST validation + Python SDK | License validate, HWID binding, heartbeat, logout — **PIN নয়** |
| External store | Scoped Admin API Bearer token | অনুমোদিত application-এর license issue/read/reset/status |

Admin session, API Bearer token, license key এবং customer PIN ভিন্ন credential। Customer PIN দিয়ে admin access হয় না, আর client-side login-এ PIN পাঠানো হয় না।

## Primary Python SDK

নতুন integration-এর **একমাত্র recommended package**: [`SDK/client/python/licenx/`](../SDK/client/python/licenx/README.md)। Python package/import `licenx`; পাবলিক facade `XLicenseClient`।

```bash
python -m pip install ./SDK/client/python/licenx
```

```python
from licenx import XLicenseClient

client = XLicenseClient()  # app-root licenx.config.py
result = client.login(input("License key: ").strip())
if not result.success:
    raise SystemExit(result.message)
try:
    # Licensed app logic.
    pass
finally:
    client.logout()
```

`licenx.config.py`-তে trusted `public_key_pem`, HTTPS `server_url`, app identifier এবং **actual app_version** দিতে হবে। `min_version` সার্ভারের policy, client version নয়। SDK license key persist করে না; online login ও signed-response verification প্রয়োজন। [English guide](../SDK/client/python/docs/GUIDE_EN.md) · [বাংলা guide](../SDK/client/python/docs/GUIDE_BN.md)।

**Reference only:** `SDK/x_license_python/` একটি compatibility/reference SDK, primary নয়। বর্তমানে downloadable `x_license_python.zip` এখনো ওই reference tree থেকে build হয়; নতুন app-এর জন্য primary package wheel/source install ব্যবহার করুন।

## License and device lifecycle

1. Admin app slug/version policy সেট করেন এবং license তৈরি করেন।
2. Client app `/api/v1/license/validate`-এ license key, app identifier/version, HWID এবং nonce দেয়; server scope/status/device limit যাচাই করে এবং signed response পাঠায়।
3. SDK trusted public key দিয়ে signature/identity/challenge যাচাই করে। কোনো যাচাই ব্যর্থ হলে access deny হয়।
4. Successful login-এর পর heartbeat device lease ধরে রাখে; explicit logout device slot release করার চেষ্টা করে।
5. Suspended/revoked/expired license এবং inactive parent app-এর ক্ষেত্রে authorization ব্যর্থ হয়। Temporary network outage-এর grace কেবল configured policy অনুযায়ী; offline login সমর্থিত নয়।
6. Customer PIN শুধু অনুমোদিত self-service device-control/reset flow-তে ব্যবহৃত হয়।

## Endpoint and source map

| Feature | Source |
| --- | --- |
| UI/admin navigation | `src/components/` |
| Node REST APIs | `src/server/api.ts` |
| Cloudflare handler | `src/server/cloudflareHandler.ts` |
| PostgreSQL schema | `src/server/database/postgresSchema.ts` |
| Initial owner setup | `src/server/bootstrap.ts`, `scripts/install-vps.sh` |
| Full backup | `src/server/backupControl.ts` এবং সংশ্লিষ্ট storage/worker modules |
| **Primary Python facade** | `SDK/client/python/licenx/client.py` |
| Primary login/session | `SDK/client/python/licenx/login.py`, `storage.py`, `logout.py` |
| Primary config/HWID/crypto transport | `SDK/client/python/licenx/config.py`, `device.py`, `server.py` |
| Primary SDK guide | `SDK/client/python/docs/` |
| Reference-only compatibility SDK | `SDK/x_license_python/` |

## Developer safeguards

Production ও CI আলাদা। Source tests, CI smoke tests এবং actual VPS operations-এর status আলাদাভাবে report করুন। Runtime parity বজায় রাখতে Node ও Cloudflare API behavior একসঙ্গে যাচাই করুন। Private plans/forensic reports কেবল ignored `notes/`-এ রাখুন; public docs root/SDK-তে রাখুন। User অনুমতি ছাড়া feature/API/schema পরিবর্তন করবেন না।
