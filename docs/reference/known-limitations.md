# Feature status, exclusions and verification limits

## Supported but gated or environment-specific

- **Realtime license transport and Admin WSS** are implemented in source but require separate environment/app policies. Default Compose flags are OFF; this audit did not read production flag values.
- **Cloudflare adapter** and **PostgreSQL VPS** are different runtime configurations. API compatibility and database parity cannot be assumed without target-specific tests.
- **R2 assets/full backups** require valid provider setup and private bucket permissions. A local backup archive does not prove R2 remote object integrity.
- **Partner license checks** require registered HTTPS domain, private scoped key and enabled global policy. Static browser JavaScript cannot safely hold that credential.

## Known absent or not established

- No built-in payment gateway/checkout was established; **Buy License** is a configurable navigation URL.
- No public self-service account registration flow was identified; the admin account is first-owner setup plus authenticated management.
- The historic `SDK/x_license_python/` reference source tree is absent; maintained Python package is `licenx`.
- Current public tools inventory may be empty even though publishing is implemented; last owner-provided production snapshot showed 0 published tool cards.
- A dependency name alone (e.g. `@google/genai`) is not proof of a product feature.

## Not independently tested in this forensic documentation pass

- Real production license key login/activation, device binding, SDK heartbeat/revocation end-to-end.
- Production encrypted archive decryption/restore, remote R2 object hash validation, current scheduling outcome.
- Production scale/latency, public-domain realtime WSS, Cloudflare live deployment parity, every state and error branch.
- Running a fresh installation using these docs, full suite test execution, or CI reruns.

## Observed documentation debt (outside this task's write scope)

- Historical `MEMORY.md` sections refer to a deleted reference SDK and earlier NO-GO/NOT_DEPLOYED states. Its leading 2026-11-18 snapshot supersedes them. This docs suite documents the maintained SDK and last accepted HF-01 production state.
- Historical UI text in some modules references a pre-publishing phase even though `PublicToolsPage` is present. Product UI text is **not** modified by documentation-only work; track separately if owner wants a correction.

See [Reconciliation](documentation-reconciliation.md), [Coverage](audit-coverage.md), and the source paths cited in relevant feature guides.