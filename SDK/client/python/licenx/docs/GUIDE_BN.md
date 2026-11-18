# LicenX Python SDK — Integration Guide (বাংলা)

**একটি supported SDK:** `licenx`। Config: `licenx.config.py`; install: verified wheel অথবা primary source kit।


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

বিস্তারিত configuration ও API reference **শুধু repository source checkout-এ** আছে: `SDK/client/python/docs/CONFIGURATION.md` এবং `SDK/client/python/docs/API_REFERENCE.md`। Package README-ও source checkout/source ZIP-এ পাওয়া যায়; installed wheel-এর তিনটি packaged Markdown-এর মধ্যে সেটি নেই। Installed SDK-তে [bundled documentation index](README.md) এবং এই English/Bangla guide ব্যবহার করুন।

## ৬. Safe testing

```bash
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

Diagnostic console-এ live hostname/license দিলে server-side binding/log তৈরি হতে পারে। Production credentials দিয়ে পরীক্ষা করবেন না; isolated authorized test data ব্যবহার করুন। Local tests production readiness-এর প্রমাণ নয়।

## ৭. Optional realtime এবং authorization বনাম UI continuity (v1.2.6)

Compatible application-এ literal `app_config`-এর `"useWebSocket": True` (সত্যিকারের Boolean) দিয়ে opt-in করুন, optional `websocket-client` / `licenx[realtime]` dependency ব্যবহার করুন। Server operator-কে Node realtime gateway এবং সংশ্লিষ্ট App-এর WebSocket permission চালু করতে হবে। পুরোনো HTTP-only integration অপরিবর্তিত থাকবে। Global/unscoped license-এর জন্য device-bound WSS ticket তৈরি হয় না; সেক্ষেত্রে signed HTTPS চলবে।

Successful **signed online login**-এর পর SDK short-lived ticket নিয়ে trusted, signed, app/device-bound `license.snapshot` যাচাই করে। Socket connect, unsigned event বা UI hint কোনোভাবেই license permission দেয় না। `client.get_connection_state()` থেকে `CONNECTING`, `CONNECTED`, `RECONNECTING`, `HTTP_FALLBACK`, `OFFLINE_GRACE`, `PAUSED_UNVERIFIED`, `INVALIDATED` ইত্যাদি state পাওয়া যেতে পারে। `on_connection_state_change(state)` background thread-এ চলতে পারে; Qt/Tkinter UI-তে main thread-এ dispatch করুন।

Network failure-এ `offline_grace_seconds` শেষ হলে opted-in client-এর `has_login_session()` **শুধু UI-only in-memory hint** হিসেবে True থাকতে পারে, কিন্তু `is_authenticated()` ও `is_valid()` **False** থাকবে এবং protected কাজ বন্ধ রাখতে হবে। আবার authorization পেতে fresh, nonce-bound signed HTTPS heartbeat প্রয়োজন। Server-এর signed `keep_login_on_network_error` Boolean SDK store করে; তবে **v1.2.6 implementation-এ এর ON/OFF value অনুযায়ী UI hint retention বদলায় না**। তাই OFF থাকলেই visible login স্বয়ংক্রিয়ভাবে বন্ধ হবে—এমন দাবি করবেন না। HTTP-only mode-এর invalidation policy আলাদা। Verified revoke/expiry/unbound denial সব সময় permission বাতিল করে।

## ৮. Error handling এবং নিরাপদ cleanup

- `LoginResult` fields হলো `success`, `status_code`, `message`, `code`, `license_data`, `hwid`, `license_key`, optional `request_id`। Key, PIN, HWID বা session তথ্য log করবেন না। Empty key → `EMPTY_KEY`; saved key না থাকলে `auto_login()` → `NO_SAVED_SESSION`; পূর্বের unconfirmed logout থাকলে নতুন login → `PREVIOUS_SESSION_LOGOUT_FAILED`।
- `client.login(key, pin=None)` পুরোনো `pin` argument গ্রহণ করলেও **ignore করে**। PIN web public-control-এর জন্য; SDK signed login-এর জন্য নয়।
- `client.logout()` Boolean দেয়। `False` মানে remote slot release **confirm হয়নি**। SDK local permission clear করে এবং RAM-এ pending-release information রাখে, যাতে explicit retry সম্ভব হয়। Force-kill-এ unbind নিশ্চিত নয়; anonymous legacy logout fallback নেই।
- `client.ping()` response dictionary দেয়; login key না থাকলে `NOT_AUTHENTICATED`। TLS/signature/security failure-কে normal transient network outage ধরে permission দেবেন না।
- বিস্তারিত [bundled docs index](README.md) ব্যবহার করুন। Repository-only extended `SDK/client/python/docs/API_REFERENCE.md` ও `CONFIGURATION.md` এবং historical source-map notes installed wheel-এর তিনটি packaged Markdown file-এর অংশ নয়।

**Evidence:** `licenx/client.py`, `realtime.py`, `storage.py`, `server.py`, `logout.py`, `test/test_realtime.py` এবং `pyproject.toml`। এই audit-এ source দেখে documentation মিলানো হয়েছে; নতুন wheel-install, GUI বা live network test চালানো হয়নি।
