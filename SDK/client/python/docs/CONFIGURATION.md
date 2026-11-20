# LicenX Python SDK — Configuration

**Primary package:** `SDK/client/python/licenx/` (`import licenx`). Application root-এ `licenx.config.py` ব্যবহার করুন; template: [`SDK/client/python/licenx.config.py`](../licenx.config.py)। Config loader কেবল literal data parse করে; executable code চালায় না। Existing integrations-এর supported JSON config compatibility বজায় আছে।

```python
app_config = {
    "server_url": "https://license.example.com",
    "app_name": "my_app_slug",
    "app_version": "1.0.0",
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----",
    "ping_interval_seconds": 1200,
    "offline_grace_seconds": 0,
}
```

| Field | Requirement |
| --- | --- |
| `server_url` | HTTPS for any remote server; loopback HTTP is for local development |
| `app_name` | Admin-defined app identifier/slug |
| `app_version` | **Actual installed app version**; do not use server `min_version` |
| `public_key_pem` | Administrator-provided trusted RSA/Ed25519 public verification key |
| `ping_interval_seconds` | 60–1,200 seconds; default 1,200 |
| `offline_grace_seconds` | 0–3,600 seconds; default 0; never authorizes offline initial login |
| `request_timeout_seconds` | Request timeout setting (default 35); heartbeat calls clamp each attempt to 1–20 seconds to bound offline recovery delays |

After an online login, a verified transient heartbeat outage within the configured offline grace triggers recovery attempts about every 30 seconds (plus bounded network request time); successful signed heartbeats reset the grace timer. Heartbeat and GET transports retry temporary connection/timeout failures at most twice with 1s/2s backoff; other POST operations retain their prior single retry. TLS verification errors, revoked licenses and invalid/mismatched signatures **never** receive offline grace. Sending workloads still need application-level pause/retry/resume for their own network connections.

The SDK fails closed on invalid signed responses and untrusted verification keys. Sensitive license keys are not persisted by this SDK. See [English guide](../licenx/docs/GUIDE_EN.md) or [বাংলা guide](../licenx/docs/GUIDE_BN.md).

## WS-03: Optional WebSocket realtime (updated SDK only)

**Old SDKs and old configuration files remain HTTP-only.** The new Python SDK defaults `useWebSocket=False`; there is no automatic SDK upgrade. For a compatible new SDK deployment, add the optional literal field to `licenx.config.py`:

```python
app_config = {
    "server_url": "https://license.example.com",
    "app_name": "my_app_slug",
    "app_version": "1.0.0",
    "public_key_pem": "YOUR TRUSTED REAL RSA OR ED25519 PUBLIC KEY PEM",
    "ping_interval_seconds": 1200,
    "offline_grace_seconds": 1200,
    "useWebSocket": True,
}
```

Install optional transport dependency with `pip install 'licenx[realtime]'` (or `pip install websocket-client>=1.7`). Missing dependency does **not** bypass license checks; the SDK retains signed HTTP heartbeat fallback. The App must be permitted for WebSocket by the server and its Node gateway must be enabled; if not, signed HTTPS remains authoritative. The current **Edit Application** UI exposes the per-app WebSocket switch (`src/components/EditAppModal.tsx`); the independent Node server transport gate must also be enabled. This SDK flag alone never enables the gateway.

After a successful **signed online login**, the SDK's daemon requests a short-lived device-bound ticket, opens the validated `wss://` connection with a one-use Authorization header (never in the URL), sends `license.hello`, and only treats a bound, trusted-key-signed `license.snapshot` as connected. Signed change events cause **fresh nonce-bound HTTPS heartbeat checks**, never remote command execution or unsigned privilege grants. A healthy WSS link suppresses routine HTTP polling; disconnect resumes signed HTTP fallback and bounded jittered reconnect. Existing heartbeat's offline grace remains bounded.

On an opted-in new SDK, `client.is_authenticated()` and `client.is_valid()` indicate **license authorization** and are always false after grace expires without fresh signed verification; do **not** use `has_login_session()` as an authorization gate. New `client.has_login_session()` is a **UI-only continuity hint** that remains true during a temporary outage (no plaintext session is written to disk). `client.get_connection_state()` returns `CONNECTED`, `RECONNECTING`, `HTTP_FALLBACK`, `OFFLINE_GRACE`, `PAUSED_UNVERIFIED`, or `INVALIDATED`. Optional `on_connection_state_change` callback runs on a worker thread; a PySide6 UI must marshal updates to its main GUI thread. Host app's own sending/network tasks still need Pause/Retry/Resume; changing the SDK alone cannot fix their exceptions or automatically change UI pages.

Signed revoked/expired/reset/unbound denials, invalid RSA/Ed25519 signature, TLS errors and wrong App/device scope are never grace-eligible. Resuming from `PAUSED_UNVERIFIED` always requires a fresh signed HTTPS heartbeat. Logout or application exit stops the realtime daemon and existing logout/unbind behavior continues. `SDKConfig.export_to_file` omits `useWebSocket` when disabled for backwards-compatible old exports; do not deliver an opted-in new Python config to a strict old SDK parser.

**Security / production limits:** SDK WS-03 uses the existing WS-02 server ticket contract and does not change it. WS-02 global/per-App switches default OFF, tickets are Node-process-local, and Cloudflare is HTTP-only. Live WSS proxy, rolling deployment and capacity verification are WS-05 gates. The server-side `keep_login_on_network_error` Boolean exists in the app/API and signed WSS snapshot, but the current Edit Application modal does not expose that separate flag. The SDK stores signed metadata, while host GUI continuity is implemented by the opted-in worker and must not be mistaken for authorization. UI-continuity changes are opt-in through this new SDK only.

## Signed legacy Keep Login metadata (current source v1.2.7)

With `useWebSocket=True`, the server's `keep_login_on_network_error` Boolean is present in the signed, device-bound `license.snapshot`; missing policy defaults OFF, invalid type or tampering fails verification. **Current behavior is important:** `BackgroundLicenseWorker.apply_signed_realtime_policy()` stores the Boolean, but UI-continuity after a transient outage **does not branch on that stored Boolean** in this source. Tests explicitly confirm ON and OFF both retain an in-memory UI hint while protected operations are paused when proof/grace is insufficient (`test_realtime.py:test_signed_legacy_policy_flag_does_not_change_ui_continuity`). A signed App change can trigger HTTPS revalidation and reconnect.

- **OFF (metadata default):** in opted-in WSS mode, transient failure has bounded `offline_grace_seconds`; afterward `is_authenticated()` and `is_valid()` return false, `PAUSED_UNVERIFIED` is reported, but `has_login_session()` may remain true as a **non-authorizing UI hint**. The worker does not auto-clear that hint solely because this flag is false.
- **ON:** the same current UI-hint behavior applies. A fresh nonce-bound signed HTTPS heartbeat is required to resume authorization; `has_login_session()` **never** authorizes protected operations. Neither ON nor OFF makes initial login work offline.
- **No WSS/signed policy:** stored metadata defaults OFF and cannot grant privileges. Existing `useWebSocket=False` HTTP-only clients remain on their separate heartbeat invalidation path; do not infer their UI hint follows the opted-in WSS rules.
- **Admin revoke/reset/expiry/bad RSA/Ed25519 signature:** always invalidates regardless of this toggle.

Actual GUI persistence and background send queue pausing remain the host application's responsibility. `pip install 'licenx[realtime]'` installs the optional transport; ordinary installs do not change. No ticket/license keys are saved to disk.

See `deploy/WS05_RELEASE_GATE.md` for explicit rollout/rollback safety requirements.

## Complete `SDKConfig` field/default matrix — current source 1.2.7

The table is the dataclass definition in `SDK/client/python/licenx/config.py:SDKConfig`. `min_version` is *server/application minimum-version metadata*, **not** the actual running client `app_version` required for signed validation.

| `app_config` field | Declared default | Validation or operational significance |
| --- | --- | --- |
| `server_url: str` | `http://localhost:3000` | Remote requests must use HTTPS; loopback HTTP allowed for local work. Network URL validation happens when building the request. |
| `public_key_pem: str` | `""` | **Required nonblank trusted RSA/Ed25519 PEM** when loading JSON/Python config; direct empty defaults are not usable for signed login |
| `app_name: str` | `vcon_default` | App identifier/slug as registered with the license service |
| `display_name: str` | `Default App` | Local display label |
| `min_version: str` | `1.0.0` | Informational server minimum, **never substitute for `app_version`** |
| `app_version: Optional[str]` | `None` | Actual installed client version; a missing value prevents signed validation |
| `ping_interval_seconds: int` | `1200` | **Exact** integer from 60 through 1200 |
| `offline_grace_seconds: int` | `0` | **Exact** integer from 0 through 3600 |
| `request_timeout_seconds: int` | `35` | Used for regular requests; heartbeat clamps to 1–20 seconds per attempt. No general bound beyond integer type is enforced by mapping loader. |
| `auto_logout_on_exit: bool` | `True` | Best-effort `atexit` / signal cleanup; not guaranteed on hard termination |
| `auto_login_enabled: bool` | `True` | Switch for auto-login *attempts*; current worker does **not** persist license keys |
| `auto_save_session: bool` | `True` | Retained compatibility field; **does not override the current no-persistence implementation** |
| `enable_background_heartbeat: bool` | `True` | Background monitoring in HTTP mode; opted-in WSS also starts monitoring |
| `strict_online_only: bool` | `True` | Local policy metadata; initial login always performs online signed validation |
| `useWebSocket: bool` | `False` | Opt-in WSS; requires installed `websocket-client`, enabled Node gateway and permitted scoped app |

### Loader precedence and validation

1. `SDKConfig.from_config_path(path)` loads **that exact file** (`.py` through literal AST, other paths through JSON). A missing explicit path raises `SDKConfigError("CONFIG_FILE_NOT_FOUND")`.
2. `SDKConfig.from_discovered_file()` scans current working directory, main script directory and supported executable directory; one `licenx.config.py` takes precedence if unique, otherwise one legacy `*_vcon_config.json` or `vcon_config.json` may be used. Distinct competing candidates raise `CONFIG_SOURCE_AMBIGUOUS`; inode/symlink aliases to the same file are deduplicated.
3. The Python loader permits a module docstring followed by literal dictionaries named `app_config`, `client_options` and `sdk_fixed_constraints`; only `app_config` **controls runtime configuration**. The latter two maps are parsed but ignored. No imports, callable expressions, attribute access or arbitrary code execution are accepted. `generated_at` string metadata is accepted but not applied. Unknown `app_config` fields fail; JSON compatibility ignores unknown fields while still validating supported ones.
4. If discovery finds no usable file, `SDKConfig()` defaults are returned. That is **not a licensed configuration**: there is no trusted public key and `app_version` is absent.
5. File/schema errors raise `SDKConfigError(ValueError)` with `CONFIG_FILE_NOT_FOUND`, `CONFIG_FILE_READ_ERROR`, `CONFIG_PARSE_ERROR`, `CONFIG_SCHEMA_ERROR`, `CONFIG_VALUE_ERROR` or `CONFIG_SOURCE_AMBIGUOUS`. Direct `SDKConfig(...)` value-range construction can raise ordinary `ValueError`.
6. `SDKConfig.export_to_file(path)` creates a JSON file with supported fields. It omits `useWebSocket` when false for legacy export compatibility; it never exports the `client_options` or `sdk_fixed_constraints` informational maps.

**Security boundary:** The presence of `public_key_pem` in a downloaded JSON file does not itself prove its trustworthiness. Compare it with an independently provisioned key/fingerprint. Neither the `auto_save_session` flag nor `has_login_session()` grants authorization; only a verified signed online response and the current bounded lease policy do.

**Evidence:** `SDK/client/python/licenx/config.py:SDKConfig,from_discovered_file,from_python_file,_from_mapping,export_to_file`; `client.py:XLicenseClient.__init__`; `server.py:ServerCommunicator._build_url`; `storage.py:BackgroundLicenseWorker`; `test/test_python_config.py`, `test/test_realtime.py`. These details were statically checked against the local source; no current packaging installation or live network validation ran.
