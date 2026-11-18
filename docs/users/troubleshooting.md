# Troubleshooting LicenX

| Symptom | What the implementation indicates | Safe next action |
| --- | --- | --- |
| `/api/health` responds but app is not ready | Liveness does not check PostgreSQL/storage; readiness does | Check `/api/ready` and container health, then inspect sanitized server logs |
| First admin setup asks for owner code | PostgreSQL owner-claim gate is active | Use the private code generated on **your own** VPS; do not share it |
| Login fails / is throttled | Admin credentials or per-identity login throttling | Verify account; honor retry policy, do not disable safeguards |
| Site Settings Save 400/422 | Historic pre-HF-01 catalog fields were resubmitted | Use the current deployed HF-01 build; verify Save plus reload, do not edit DB JSON manually |
| No cards on `/tools` | Public page only shows **enabled** published items | Check Admin → Tools; zero published cards is a valid empty state |
| Buy License CTA is disabled | Its configured URL may be `#` | Configure an approved HTTPS destination in Site Settings |
| Public check gives 403 | Site policy disables check or caller violates restricted partner API rules | Distinguish `/v1/user/license/check` from `/v1/public/license/check` |
| PIN control returns 429 | Incorrect-attempt throttling applied | Respect `Retry-After`; do not bypass |
| SDK login denied | Version, app scope, signature, expiration, device limit or transport check | Use sanitized SDK result code, actual `app_version` and trusted key |
| WebSocket missing | Server or app realtime feature gate off, bootstrap not authorized | Test HTTPS-only behavior first; verify flags through approved operations |
| Backup scheduling rejected | Recovery key not downloaded, invalid interval/destination | Save recovery key off-server; choose 1/6/12/24/168 hours |
| Restore makes readiness return 503 | Backup controller intentionally pauses normal traffic | Check actual job status; do not restart/migrate concurrently |

Avoid pasting passwords, license keys, signing keys, PINs, database URLs or backup recovery keys into support tickets. See [Security](../dev/security.md) and [Known limitations](../reference/known-limitations.md).