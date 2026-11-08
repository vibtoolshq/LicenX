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

Install optional transport dependency with `pip install 'licenx[realtime]'` (or `pip install websocket-client>=1.7`). Missing dependency does **not** bypass license checks; the SDK retains signed HTTP heartbeat fallback. The App must be permitted for WebSocket by the server and its Node gateway must be enabled; if not, signed HTTPS remains authoritative. Note: the Admin Panel's UI toggle will be added in WS-04, so this SDK flag alone does not enable realtime on the server.

After a successful **signed online login**, the SDK's daemon requests a short-lived device-bound ticket, opens the validated `wss://` connection with a one-use Authorization header (never in the URL), sends `license.hello`, and only treats a bound, trusted-key-signed `license.snapshot` as connected. Signed change events cause **fresh nonce-bound HTTPS heartbeat checks**, never remote command execution or unsigned privilege grants. A healthy WSS link suppresses routine HTTP polling; disconnect resumes signed HTTP fallback and bounded jittered reconnect. Existing heartbeat's offline grace remains bounded.

On an opted-in new SDK, `client.is_authenticated()` and `client.is_valid()` indicate **license authorization** and are always false after grace expires without fresh signed verification; do **not** use `has_login_session()` as an authorization gate. New `client.has_login_session()` is a **UI-only continuity hint** that remains true during a temporary outage (no plaintext session is written to disk). `client.get_connection_state()` returns `CONNECTED`, `RECONNECTING`, `HTTP_FALLBACK`, `OFFLINE_GRACE`, `PAUSED_UNVERIFIED`, or `INVALIDATED`. Optional `on_connection_state_change` callback runs on a worker thread; a PySide6 UI must marshal updates to its main GUI thread. Host app's own sending/network tasks still need Pause/Retry/Resume; changing the SDK alone cannot fix their exceptions or automatically change UI pages.

Signed revoked/expired/reset/unbound denials, invalid RSA/Ed25519 signature, TLS errors and wrong App/device scope are never grace-eligible. Resuming from `PAUSED_UNVERIFIED` always requires a fresh signed HTTPS heartbeat. Logout or application exit stops the realtime daemon and existing logout/unbind behavior continues. `SDKConfig.export_to_file` omits `useWebSocket` when disabled for backwards-compatible old exports; do not deliver an opted-in new Python config to a strict old SDK parser.

**Security / production limits:** SDK WS-03 uses the existing WS-02 server ticket contract and does not change it. WS-02 global/per-App switches default OFF, tickets are Node-process-local, and Cloudflare is HTTP-only. Live WSS proxy, rolling deployment and capacity verification are WS-05 gates. The server-side stored `keep_login_on_network_error` flag does not yet control host GUI behavior; WS-04 will expose this policy in Admin. UI-continuity changes are opt-in through this new SDK only.
