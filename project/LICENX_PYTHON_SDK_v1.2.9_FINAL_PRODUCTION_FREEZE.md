# LicenX Python SDK v1.2.9 — Final Production Reference & Configuration Freeze

**Freeze date:** 2026-11-21. **Status:** v1.2.9 is the latest verified published **non-prerelease** Python SDK. This is the approved production integration baseline **for the tested signed-licensing and strict TLS/WSS scope**, not a claim of unconditional coverage of every backend, GUI or hostile production network. Existing `pyproject.toml` metadata retains its `Development Status :: 4 - Beta` classifier; this documentation does not silently change packaging metadata.

| Release identity | Source |
| --- | --- |
| Package and Python import | `licenx`, Python 3.8+, `cryptography>=41.0.0` |
| Official release | `python-sdk-v1.2.9`, published 2026-11-20 — https://github.com/vibtoolshq/LicenX/releases/tag/python-sdk-v1.2.9 |
| Package declarations | `SDK/client/python/licenx/__init__.py`, `SDK/client/python/licenx/pyproject.toml`, both `1.2.9` |
| Release-request source SHA | `cf51975542b2cec28d7c4a22a2c212a59fcd95a0` in `SDK/release-requests/python-sdk-v1.2.9.txt` |
| Verified PyPI wheel SHA256 (previous release audit) | `736e0664cace3d1f3eb5cf0f406360d8ca368f293f434342d98bc40e0a2de3d3` |
| Reviewed repository baseline | `main@83462f1497bb87f8a6c1e6d6ef6aed82ff6130e4` |

> **Binding integration rule for all newly developed applications:** Use a **Python literal configuration file**, normally **`licenx.config.py`** in the application root. **Never use a downloaded JSON file directly as a new application's runtime LicenX configuration.** JSON is an **Admin Panel export/download and migration/interchange artifact only**. The current SDK still implements old JSON loaders for backward compatibility; this documentation policy does not remove or disable them.

## A. Maintained SDK scope

The only maintained client distribution is the flat `SDK/client/python/licenx/` Python package. Its high-level integration facade is `XLicenseClient`. It does not itself implement the LicenX Admin Panel, customer portal, server-side license issuance, PostgreSQL, VPS deployment, backups, WebSocket gateway enablement or application-specific work queues.

```bash
python -m pip install "licenx==1.2.9"
python -m pip install "licenx[realtime]==1.2.9"
# Alternatively, from the trusted source checkout:
python -m pip install ./SDK/client/python/licenx
```

The optional `requests` extra adds Requests transport, with `urllib` fallback. The optional `realtime` extra adds `websocket-client>=1.7,<2` and `certifi>=2024.2.2`; WSS remains opt-in and subject to independent server and per-App policies. The SDK uses a trusted RSA/Ed25519 verification key and HTTPS for remote endpoints.

## B. Complete implemented feature inventory (source v1.2.9)

| # | Feature | Implementation |
| --- | --- | --- |
| 01 | App config discovery, exact Python `app_config` parsing via AST/literals, explicit paths and validation | `config.py` |
| 02 | Signed online license validation, login result, App scope and actual client-version checks | `client.py`, `login.py`, `server.py` |
| 03 | RSA/Ed25519 signature, canonical payload, nonce/challenge, identity and signed-time verification; fail closed | `server.py`, `login.py` |
| 04 | Secure HTTPS transport, error handling, timeout and bounded retries; loopback-only HTTP exception | `server.py` |
| 05 | Device fingerprint/HWID and minimal validation telemetry | `device.py` |
| 06 | Optional device details, motherboard/storage/MAC/CPU probes, public-IP lookup and explicit full telemetry | `device.py` |
| 07 | Session/lease monitoring and authenticated manual/background heartbeats | `storage.py`, `server.py`, `client.py` |
| 08 | Bounded post-login offline grace, monotonic deadline, pause and verified recovery; **no initial offline login** | `storage.py`, `offline.py` |
| 09 | Optional ticketed WSS, short-lived device ticket, Authorization header, signed `license.snapshot` | `realtime.py` |
| 10 | Strict WSS certificate-chain and hostname checks with OS + bundled certifi trust; missing/untrusted CA fails closed | `realtime.py` |
| 11 | WSS liveness detection, retry/backoff/reconnect and signed HTTPS heartbeat fallback | `realtime.py`, `storage.py` |
| 12 | Signed scoped realtime changes/events; unsigned frames and socket-open status cannot authorize | `realtime.py` |
| 13 | Distinct UI connection states and application authorization; `has_login_session()` is a UI hint only | `client.py`, `storage.py` |
| 14 | Server-driven revoke/suspend/expire/unbind and callback-driven access lock | `client.py`, `storage.py`, `login.py` |
| 15 | Explicit device logout/release through current signed-session v2 bearer; no anonymous legacy unbind fallback | `logout.py`, `server.py` |
| 16 | RAM-only pending logout retry and best-effort process-exit hooks | `logout.py`, `client.py` |
| 17 | No reversible persisted license key/session; `auto_login()` generally yields `NO_SAVED_SESSION` | `storage.py`, `login.py` |
| 18 | Guarded session replacement; old unconfirmed logout blocks concurrent replacement | `client.py`, `logout.py` |
| 19 | Opt-in per-device dynamic stats using a fresh signed report-only capability token kept in RAM | `client.py`, `server.py` |
| 20 | Privacy-safe diagnostic buffer: bounded stage/code/attempt and optional TLS verify code | `diagnostics.py`, `server.py`, `realtime.py` |
| 21 | Invalid/missing signature, wrong App/device scope, invalid time, forged events and untrusted TLS all deny privileges | `server.py`, `realtime.py` |
| 22 | App callbacks (`on_license_revoked`, `on_connection_state_change`); GUI thread marshalling remains host responsibility | `client.py`, `example_app.py` |
| 23 | Clock drift and online-policy helpers; **not** an offline-activation mode | `offline.py` |
| 24 | Structured config, transport, login, heartbeat, logout, stats and realtime error codes | `config.py`, `login.py`, `server.py`, `client.py` |
| 25 | Historical SDK JSON import/discovery/export retained **only for older integrations**; not the frozen new-app policy | `config.py` |
| 26 | Example app, packaged EN/BN guides, public API references and focused regression tests | `example_app.py`, `docs/`, `test/` |

### Public import surface: all 12 `licenx.__all__` names

`XLicenseClient`, `SDKConfig`, `DeviceManager`, `ServerCommunicator`, `ServerClient`, `BackgroundLicenseWorker`, `LicenseStorage`, `OfflineGuard`, `OfflineLicenseManager`, `LoginManager`, `LoginResult`, `LogoutManager`.

`ServerClient`, `LicenseStorage` and `OfflineLicenseManager` are aliases, not three additional implementations. `RealtimeLicenseWorker`, `SafeDiagnosticBuffer`, and `SDKConfigError` exist in submodules but are not exported in the root `__all__` list. The recommended public integration uses the facade.

### Facade API A–Z

| Method | Exact role |
| --- | --- |
| `XLicenseClient(config_path=None, config=None, ..., app_version=None, useWebSocket=None, on_license_revoked=None, on_connection_state_change=None)` | Configure facade, optional callbacks and WSS |
| `login(key, pin=None)` | Signed online `LoginResult`; legacy `pin` parameter is ignored |
| `auto_login()` | Attempts saved login; normally `NO_SAVED_SESSION` because no key persistence |
| `logout(clear_saved_license=True)` | Stops monitoring, clears auth and requests remote v2 unbind; `False` means unconfirmed |
| `ping()` | Signed manual heartbeat result dictionary |
| `is_authenticated()`, `is_valid()` | Required authorization check for protected work |
| `has_login_session()` | In-memory UI-continuity hint **not permission** |
| `get_connection_state()` | UI/transport state; `HTTP_ONLY` when realtime off |
| `get_license_info()` | Verified license payload or none when unavailable |
| `get_tier()` | Verified tier, otherwise string `"None"` |
| `get_hwid()` | Local fingerprint; do not log |
| `get_device_telemetry()` | Local device data; privacy-sensitive |
| `get_current_key()` | Sensitive in-memory credential; never log/save |
| `report_stats(flat_dict)` | Explicit per-device nonsecret stats reporting |

`LoginResult` includes `success`, `status_code`, `message`, `code`, optional `license_data`, `hwid`, `license_key`, `request_id`; treat identifying data and credentials as sensitive. Low-level maintenance interfaces: `SDKConfig` loaders, `ServerCommunicator.validate_license()`, `ping_heartbeat()`, `send_logout()`, `verify_signature()`, `request_stats_capability()`, `send_stats()`, `get_diagnostics()`, `DeviceManager` telemetry helpers, `BackgroundLicenseWorker` state helpers and `LogoutManager.retry_pending_logout()`.

## C. Final frozen **Python-only configuration** contract

**Canonical SDK auto-discovery filename is exactly `licenx.config.py`.** Place it at the app root. The SDK searches current working directory, entry-point directory and supported packaged-executable directory. It does **not** automatically discover `config.licenX.py` or `config-licenx.py`. Those alternate **Python** names are permitted only with an explicit Python path, for example `XLicenseClient(config_path="config-licenx.py")`. Prefer the canonical name globally.

```python
# Application root: licenx.config.py (literal data only)
app_config = {
    "server_url": "https://license.example.com",
    "app_name": "registered_app_slug",
    "app_version": "1.0.0",  # The actual running binary version.
    "public_key_pem": """-----BEGIN PUBLIC KEY-----
REPLACE_WITH_INDEPENDENTLY_VERIFIED_PUBLIC_KEY
-----END PUBLIC KEY-----""",
    "ping_interval_seconds": 1200,
    "offline_grace_seconds": 0,
    "request_timeout_seconds": 35,
    "auto_login_enabled": False,
    "auto_save_session": False,
    "enable_background_heartbeat": True,
    "strict_online_only": True,
    "useWebSocket": True,  # Requires realtime extra + enabled server/App gateway.
}
```

The shown PEM is a **placeholder** and cannot authenticate a real app; replace it with the administrator-provisioned public key independently verified against a trusted fingerprint. The SDK safely parses literal `app_config` using `ast.parse`/`ast.literal_eval` and **does not execute Python config statements**. It allows an optional module docstring and literal dictionaries named `app_config`, `client_options`, and `sdk_fixed_constraints`. Only `app_config` controls runtime; the latter two are informational/ignored by the SDK loader. Imports, function calls, expressions and arbitrary executable code are rejected.

```python
from licenx import XLicenseClient

client = XLicenseClient()  # Only licenx.config.py is auto-discovered.
result = client.login("LICENSE_ENTERED_BY_USER")
if not result.success:
    raise SystemExit(result.code)
try:
    if not client.is_valid():
        raise RuntimeError("License verification is not current")
    # Protected operations must continually enforce SDK authorization.
    pass
finally:
    if not client.logout():
        print("Warning: remote device release was not confirmed")
```

### All 15 `SDKConfig` fields and defaults

| Field | Source default | Meaning |
| --- | --- | --- |
| `server_url` | `http://localhost:3000` | Require HTTPS on remote servers; HTTP only local development |
| `public_key_pem` | empty | Independently trusted RSA/Ed25519 public verification key required |
| `app_name` | `vcon_default` | Registered application scope/slug |
| `display_name` | `Default App` | Local display label |
| `min_version` | `1.0.0` | Server minimum-version metadata; **not** running `app_version` |
| `app_version` | `None` | Real application binary version; needed for signed validation |
| `ping_interval_seconds` | `1200` | Integer 60–1200 |
| `offline_grace_seconds` | `0` | Integer 0–3600; never initial offline login |
| `request_timeout_seconds` | `35` | Integer; heartbeat attempts bounded to 1–20 seconds |
| `auto_logout_on_exit` | `True` | Best-effort process-exit cleanup |
| `auto_login_enabled` | `True` | Attempt policy only; no key persistence |
| `auto_save_session` | `True` | Compatibility field; does not persist license key |
| `enable_background_heartbeat` | `True` | Background online verification |
| `strict_online_only` | `True` | Initial login is always online |
| `useWebSocket` | `False` | Explicit optional realtime opt-in |

`generated_at` may be accepted as export metadata but is not a runtime dataclass setting. Unknown fields in Python literal `app_config` are rejected. Config error codes include `CONFIG_FILE_NOT_FOUND`, `CONFIG_FILE_READ_ERROR`, `CONFIG_PARSE_ERROR`, `CONFIG_SCHEMA_ERROR`, `CONFIG_VALUE_ERROR`, and `CONFIG_SOURCE_AMBIGUOUS`. Multiple discovered Python/JSON candidates can cause ambiguity; prefer one canonical Python file or an explicit Python-only path.

### Admin JSON download rule — **export only**, never direct new-app runtime

1. Admin may download/export configuration as JSON for developer exchange or migration.
2. Developer validates HTTPS origin, exact `app_name`, installed `app_version`, supported fields and **independently** trusted `public_key_pem` fingerprint.
3. Developer manually or deterministically converts the trusted settings into a **literal Python dictionary** in `licenx.config.py`; omit unsupported JSON keys. **Never execute downloaded content.**
4. App only ships/loads its Python configuration. **Prohibited for new apps:** direct `.json` config paths, `SDKConfig.from_json_file()` in the host integration, `json.load()` as LicenX config, or embedding Admin JSON as runtime config.
5. Existing SDK `from_json_file()`, `from_file()`, JSON fallback discovery, `export_to_file()` still exist and are deliberately **not broken or removed**. A future parser removal would be a separate breaking change needing explicit approval and migration.

## D. Realtime, license and security invariants

| State | Role |
| --- | --- |
| `HTTP_ONLY` | WSS opt-in off; regular signed HTTPS mode |
| `CONNECTING` | Establishing WSS |
| `CONNECTED` | Verified device/App signed snapshot accepted; not itself a new grant |
| `RECONNECTING` | WSS transport outage and bounded retry |
| `HTTP_FALLBACK` | Fresh signature-verified HTTPS continuation |
| `OFFLINE_GRACE` | Bounded authorized continuity after prior online validation |
| `PAUSED_UNVERIFIED` | No current trusted proof: block protected operations |
| `INVALIDATED` | Verified terminal license denial: lock app |

- Default `useWebSocket=False`; server/global and per-App switches independently control WSS. No global CA bypass or relaxed hostname checks.
- Short-lived ticket is device bound and provided in an Authorization header, never a query URL. WSS signed snapshot and events must be verified; a raw transport event is not authorization.
- A failed WSS connection is not a revocation. Only a fresh signed, nonce-bound HTTPS heartbeat can authorize `HTTP_FALLBACK`; a forged signature, wrong host certificate or expired proof is rejected.
- `is_valid()`/`is_authenticated()` are the only SDK facade permission checks; `has_login_session()` or `CONNECTED` are not permission.
- After grace expiry deny protected operations even when the in-memory UI/session hint remains. Signed `keep_login_on_network_error` metadata does **not** change the current opted-in worker's UI-hint retention between ON and OFF.
- Revocation, expiry, device removal and app deactivation must lock protected functionality; GUI app implements its own UI-thread marshaling, safe job pause and no automatic unsanctioned resume.
- Logout uses only proof-bound v2 device release. `False` means unbinding remains unconfirmed; don't silently start a replacement session.
- SDK never grants an offline first activation and never stores plaintext/reversible license keys in local session files.
- `report_stats()` is **optional** client-reported telemetry, not license proof or billing truth: 1–40 flat nonsecret fields, labels max 64 characters, strings max 256, finite scalars, 4096 UTF-8 bytes, server rate limiting and RAM-only capability token.
- Diagnostic data must remain allowlisted (`stage`, `code`, `attempt`, optional TLS verify code). No raw credentials, license key, token, PIN or HWID in logs.

## E. Actual verification evidence / production-readiness limits

| Verification | Outcome |
| --- | --- |
| Official SDK release v1.2.9 | Published GitHub non-prerelease release and independently verified PyPI wheel in earlier audit |
| SDK strict TLS/source security tests | 78/78 focused checks PASS (previous SDK phase) |
| Official SDK release CI | 27/27 checks PASS (previous release phase) |
| CalGrid SDK 1.2.9 integration | 40/40 scoped tests PASS |
| Real fresh RDP with CalGrid v1.0.5 | Owner observed immediate verified WSS login, application-only network outage/recovery, instant test-license revocation and rejected revoked-key re-login |
| Isolated SDK v1.2.9 additional security fixture | 9/9 PASS: shipped CA hash, real loopback invalid CA/hostname rejection, signed RSA/nonce fallback and tampered signature denial |
| Compiled app directly pointed at hostile live TLS endpoint | **NOT RUN**; isolated SDK evidence is not this specific live test |
| Controlled live WSS-only outage while actual HTTPS remained available | **NOT RUN**; isolated WSS fault with cryptographically real signed heartbeat evidence exists |
| Every server, Admin UI, VPS operation, other host app | Not retested or certified by this documentation freeze |

**Conclusion:** LicenX Python SDK `1.2.9` is the latest verified published non-prerelease SDK and the chosen **production integration baseline for tested signed licensing, TLS, realtime recovery and revocation**. Freeze the new-app configuration contract to **literal Python `licenx.config.py` only**; Admin Panel JSON remains download/export/interchange material. This is an explicit **developer-integration policy**, not a runtime parser change. Any future SDK/API/config behavior change requires a new scoped reviewed release.

## F. Authoritative sources

- [`SDK/client/python/licenx/README.md`](../SDK/client/python/licenx/README.md) and source modules `__init__.py`, `client.py`, `config.py`, `device.py`, `diagnostics.py`, `example_app.py`, `login.py`, `logout.py`, `offline.py`, `realtime.py`, `server.py`, `storage.py`.
- [`SDK/client/python/docs/CONFIGURATION.md`](../SDK/client/python/docs/CONFIGURATION.md) — parser, field defaults, compatibility.
- [`SDK/client/python/docs/API_REFERENCE.md`](../SDK/client/python/docs/API_REFERENCE.md) — public facade and all exports.
- [`SDK/release-requests/python-sdk-v1.2.9.txt`](../SDK/release-requests/python-sdk-v1.2.9.txt) — frozen source release request.
- [`project/README.md`](README.md) — app/Admin/SDK boundaries.

**FINAL FREEZE: All new LicenX-integrated apps use the literal Python `licenx.config.py`. No direct Admin JSON runtime configs. Historical JSON compatibility remains backward compatible.**
