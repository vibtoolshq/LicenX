# LicenX Python SDK — Public API Reference

**Single supported Python SDK:** `licenx`, using literal app-root `licenx.config.py` and a verified wheel or primary source kit.


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

## Complete package-root export inventory (source v1.2.7)

`licenx/__init__.py` lists **12** public names in `__all__`. The following aliases are the same underlying classes, not independent implementations.

| Import name | Implementation | Consumer responsibility |
| --- | --- | --- |
| `XLicenseClient` | `client.py:XLicenseClient` | Recommended facade; online signed login, status and cleanup |
| `SDKConfig` | `config.py:SDKConfig` | Configuration model/loaders |
| `DeviceManager` | `device.py:DeviceManager` | Deterministic local HWID and opt-in telemetry |
| `ServerCommunicator` / `ServerClient` | `server.py` | Low-level signed HTTP transport; `ServerClient` is an alias |
| `BackgroundLicenseWorker` / `LicenseStorage` | `storage.py` | Background heartbeat + in-memory lease/grace; alias, no key persistence |
| `OfflineGuard` / `OfflineLicenseManager` | `offline.py` | Local clock check and online-policy helper; alias, **not** an offline login mode |
| `LoginManager` / `LoginResult` | `login.py` | Lower-level online login manager and result dataclass |
| `LogoutManager` | `logout.py` | Logout/release and best-effort exit hooks |

`SDKConfigError` is **not exported by the root package**; import it using `from licenx.config import SDKConfigError`. `RealtimeLicenseWorker` and `SafeDiagnosticBuffer` are importable implementation modules but not in the root `__all__`; applications normally use the facade. All methods below are **synchronous**; realtime/heartbeats use daemon threads internally.

## `XLicenseClient` exact constructor

```python
XLicenseClient(
    config_path=None, config=None, app_name=None, server_url=None,
    public_key_pem=None, auto_logout_on_exit=None, auto_save_session=None,
    enable_background_heartbeat=None, ping_interval_seconds=None,
    offline_grace_seconds=None, on_license_revoked=None, app_version=None,
    useWebSocket=None, on_connection_state_change=None,
)
```

`config_path` accepts a path or an `SDKConfig` instance (legacy positional form); `config=` takes an `SDKConfig` object. If neither is provided, discovery searches the working directory, application entry-point directory and supported executable location. Supplying `app_name` or `server_url` without a config constructs a fresh `SDKConfig`, using remaining constructor options. When an existing config is supplied, `app_version=` and `useWebSocket=` explicitly override its respective attributes; other optional constructor flags are **not all applied as overrides** to an existing config. Set those fields on the `SDKConfig` object instead. `useWebSocket` must be an actual Boolean.

`on_license_revoked(reason: str)` is an optional application callback; `on_connection_state_change(state: str)` is meaningful in opted-in realtime mode. These callbacks may run from background workers. In Qt/Tkinter/other GUI hosts, dispatch UI changes to the main thread.

## Facade methods, parameters and results

| Method | Actual return | Important behavior |
| --- | --- | --- |
| `login(license_key: str, pin: Optional[str] = None)` | `LoginResult` | Online signed validate; may bind device; legacy `pin` is **accepted but ignored** |
| `auto_login()` | `LoginResult` | Usually `NO_SAVED_SESSION` (404); no disk key persistence |
| `logout(clear_saved_license: bool = True)` | `bool` | Stops monitoring/WSS, clears local auth, requests v2 remote release; `False` means remote unbind not confirmed |
| `ping()` | `Dict[str, Any]` | Nonce-bound signed heartbeat response or failure dict; without key returns `{"valid": False, "code": "NOT_AUTHENTICATED", ...}` |
| `is_authenticated()`, `is_valid()` | `bool` | In WSS opt-in mode rechecks authorization/grace; legacy HTTP mode reflects cached login state until worker invalidation |
| `has_login_session()` | `bool` | **UI-only in-memory continuity**, not permission for licensed operations |
| `get_connection_state()` | `str` | `HTTP_ONLY` when WSS off; opt-in states may include `CONNECTING`, `CONNECTED`, `RECONNECTING`, `HTTP_FALLBACK`, `OFFLINE_GRACE`, `PAUSED_UNVERIFIED`, `INVALIDATED` |
| `get_license_info()` | `Optional[Dict[str, Any]]` | Last verified response payload; blocked when opted-in client is not currently authorized |
| `get_tier()` | `str` | Tier from verified payload, default `Standard` when absent; returns `None` string if unavailable |
| `get_hwid()` | `str` | Current process-cached local hardware fingerprint |
| `get_device_telemetry()` | `Dict[str, Any]` | Local device info without optional public-IP lookup by default; treat as sensitive |
| `get_current_key()` | `Optional[str]` | **Raw active license credential** in process memory; never log or upload |

A new `login()` on an existing authenticated facade attempts **confirmed logout first**. An unconfirmed previous release blocks replacement with `PREVIOUS_SESSION_LOGOUT_FAILED` (503), leaving the pending release in RAM for explicit retry. A local failed login does not automatically unbind a customer device.

### `LoginResult` dataclass

```python
LoginResult(
    success: bool,
    status_code: int,
    message: str,
    code: str,
    license_data: Optional[Dict[str, Any]] = None,
    hwid: Optional[str] = None,
    license_key: Optional[str] = None,
    request_id: Optional[str] = None,
)
```

Use `success` to decide whether protected work can begin. On denied results, `status_code` is HTTP-style and `code` is a sanitized machine-readable identifier; optional `request_id` is for support correlation, **not** authentication. Both `license_data` and `license_key` may contain sensitive values.

## Configuration and lower-level class contracts

- `SDKConfig` has source-defined dataclass fields/defaults in `config.py:SDKConfig`; details and error codes are in [Configuration](CONFIGURATION.md).
- `SDKConfig.from_discovered_file()`, `from_config_path(path=None)`, `from_python_file(path)`, `from_json_file(path)`, legacy `from_file(path=None)`, and `export_to_file(path)` are available. Missing discovery returns defaults with **no trusted key**, not a licensed session.
- `DeviceManager.get_hwid()`, `get_device_telemetry(include_public_ip=False)`, `get_validation_telemetry()`, `get_full_telemetry()`, `get_public_ip()`, and platform-probe helpers are synchronous class methods. Full telemetry explicitly contacts a third-party IP service and may fall back to a LAN IP value labeled `public_ip`.
- `ServerCommunicator(config: SDKConfig)` exposes `validate_license(license_key, hwid, telemetry, pin=None) -> (bool, int, dict)`, `ping_heartbeat(license_key, hwid) -> (bool, dict)`, `send_logout(license_key, hwid) -> bool`, `verify_signature(payload, signature_b64) -> bool`, and bounded `get_diagnostics()`. The legacy `pin` argument is ignored in the signed license flow. `send_logout` uses **only signed-session-proof v2 logout**; no anonymous v1/deactivate fallback.
- `BackgroundLicenseWorker(app_name, ping_interval_seconds=1200, offline_grace_seconds=0, on_invalidated=None, on_heartbeat_success=None)` manages `start_monitoring(server_communicator, license_key, hwid)`, `stop_monitoring()`, `is_authorized()`, and opt-in realtime helpers. `save_session()` only clears, and `load_saved_session()` returns `None` after removing any legacy file.
- `LoginManager(config, communicator, storage)` provides `login(license_key, pin=None)` and `auto_login()`. `LogoutManager(communicator, storage, auto_logout_on_exit=True)` provides `logout(license_key=None, clear_saved_data=True)`, `has_pending_release()`, `retry_pending_logout()`, and process-exit hooks.
- `OfflineGuard.is_clock_tampered(server_time_ms, max_drift_minutes=15.0)`, `verify_clock(server_time_ms=0, max_drift_minutes=15.0)`, `check_online_policy(strict_online_only=True)` are helpers. They cannot authorize offline initial login; a missing timestamp is treated as no drift detected.

## Verified and non-verified errors

`SDKConfigError(code, message)` is a `ValueError` subclass raised by config file/schema/trust-anchor parsing. Observed codes: `CONFIG_FILE_NOT_FOUND`, `CONFIG_FILE_READ_ERROR`, `CONFIG_PARSE_ERROR`, `CONFIG_SCHEMA_ERROR`, `CONFIG_VALUE_ERROR`, `CONFIG_SOURCE_AMBIGUOUS`. Invalid policy integers and `useWebSocket` may raise plain `ValueError` when constructing `SDKConfig` directly. Transport failures are generally converted to safe response dictionaries such as `SSL_ERROR`, `TIMEOUT`, `SERVER_UNREACHABLE`, `REQUEST_ERROR`; signature and challenge rejection never authorize a session. `logout() == False` must be handled separately from `LoginResult.success`.

**Evidence:** `SDK/client/python/licenx/{__init__,client,config,login,logout,server,storage,device,offline,realtime}.py`, and targeted tests in `test/`. Signatures/defaults were compared to source; **the examples were not executed** in this documentation-only audit because the authorized Windows workspace did not expose a Python runtime.
