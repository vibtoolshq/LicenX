# Login Manager and Result

Source: `SDK/client/python/licenx/login.py`

## `LoginResult`

The dataclass communicates `success`, HTTP-style `status_code`, human-readable `message`, stable `code`, optional verified `license_data`, local `hwid`, normalized `license_key`, and optional safe `request_id`. Do not log the key field or expose it in reports.

## Online Login Flow

`LoginManager.login()` rejects an empty key locally, obtains minimal device metadata and HWID, then calls `ServerCommunicator.validate_license()`. The communicator requires actual `app_version` and verifies the response signature before success is returned. The current login manager does **not** reject an otherwise verified server response based only on local wall-clock drift, and it does **not** attempt a remote logout on a rejected/unsigned login. This prevents untrusted failures from releasing an unrelated binding. A client replacing an already authenticated session first attempts an explicit prior-session logout through `XLicenseClient.login()`.

After successful validation, the manager calls `save_session()` only when both auto-login and auto-save are enabled, and starts the monitoring worker when `enable_background_heartbeat` **or** `useWebSocket` is enabled. The current worker disables key persistence, so calling the save method does not save credentials.

`auto_login()` first checks `auto_login_enabled`, then asks storage for a key and revalidates online. Since storage deliberately returns no saved key, callers should offer an explicit fresh-key entry path. There is no offline login path.

## Error Correlation

Failed server responses may provide a canonical `request_id`; the result retains it only when it is a string. It is useful for support correlation and should not be treated as proof of authorization or as a secret.
