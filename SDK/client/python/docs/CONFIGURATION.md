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

The SDK fails closed on invalid signed responses and untrusted verification keys. Sensitive license keys are not persisted by this SDK. See [English guide](../licenx/docs/GUIDE_EN.md) or [বাংলা guide](../licenx/docs/GUIDE_BN.md).
