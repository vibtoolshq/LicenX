# LicenX Production Baseline — License Core (2026-11-16)

**Status:** RELEASED — restricted to verified License Core login/validation and session stability. This is **not** a blanket production certification of Admin Realtime or all lifecycle operations.

## Immutable release identifiers

| Item | Frozen reference |
| --- | --- |
| Server GitHub Release | [server-prod-2026.11.16](https://github.com/vibtoolshq/LicenX/releases/tag/server-prod-2026.11.16) |
| Server source commit | `2fb5d32976292d8ec86e88eb1b3c322e47210ae1` |
| Server tag | `server-prod-2026.11.16` (annotated; **not cryptographically signed**) |
| Python SDK release | [python-sdk-v1.2.6](https://github.com/vibtoolshq/LicenX/releases/tag/python-sdk-v1.2.6) (already published; immutable) |
| SDK package / version | `licenx==1.2.6` (import `licenx`) |
| SDK wheel SHA256 | `a15db11d39900af77261983fb086b6e42fecbacf2066d145196961d16b67fa60` |
| SDK source archive SHA256 | `37250eec2b8f959cbac6c8e611c6758790e9afebdb844372ef198c16f5b5cdc4` |
| Server endpoint | `https://ivib.cc` |
| Signed-validation public key SHA256 | `8ebad42d5ba26a1ec48e59ab2c8a49293ca2f25aa8a9b6b51b4b5804f7ffcf0f` |
| Reference desktop client | CalGrid `v1.0.1`, approved source `3f90c40af9c71844036560734c2e8efc4a6556b0` |
| Reference CalGrid Windows ZIP SHA256 | `54bff99ac4ada6d0150d33b901ac91fdbfb87069d5b13c36e8e98135fc960a20` |

The server tag points to the **already-deployed exact source SHA**, not the later documentation-only commit. A Git tag alone cannot restore PostgreSQL records, storage, TLS state or secrets. This PB-01 release does **not** rebuild or redeploy VPS components.

## Acceptance evidence (specific, not inferred)

- Production signed HTTPS validation was observed with HTTP 200, and active HWID binding was shown in the Admin device inspector.
- The operator observed CalGrid v1.0.1 successfully log in on a Windows PC and a separate RDP Windows host. The operator reported more than three hours of stable RDP login with no unexpected automatic logout.
- Admin browser Realtime smoke: 14/14 checks PASS for HTTPS/readiness, session/CSRF bootstrap controls, unauthenticated rejection, WSS handshake, `admin.ready`, `admin.scoped`, one-use proof rejection and authenticated fresh-bootstrap reconnect.
- Two-browser Admin session/logout and browser offline/online recovery were separately **operator-reported PASS**. These results do not certify every HTTP fallback, app isolation or revocation edge case.
- Previous isolated production PostgreSQL full-backup restore checked 14 tables and existing data continuity; encrypted app-storage and proxy/environment backups, offsite encrypted R2 archive verification, and retained Docker rollback image are in **private operational records**.

## Explicit exclusions and risks

- **Admin Realtime full release gate remains separate and not fully signed off.** Real two-App scoped event isolation, live event delivery, >100 fixture-device staging pagination/load, precise missed-event cursor/resync and HTTP fallback under full outage/revoked authorization, and owner sign-off are not proven by the browser smoke. See [Admin Realtime release gate](ADMIN_REALTIME_RELEASE_GATE.md).
- **License lifecycle acceptance is narrower than complete security certification:** device revoke/expiry behavior, proof-based logout/unbind on all clients, older-client migration and wider network interruption/recovery still need independent tests.
- Cloudflare Pages/Workers routing and old-client compatibility are not inferred from VPS checks; any active non-Node route needs its own production review.
- Deployed image is an existing reviewed artifact; this release did not build/sign/push a container image or publish a new SDK package. The annotated Git tag is unsigned; verify commit SHA and wheel checksum when restoring.
- Do not publish database dumps, tokens, license/HWID/IP records, private keys, recovery passphrases, private backup paths, `.env` or any customer information in public release artifacts.

## Freeze, rollback and next updates

1. Treat server tag `server-prod-2026.11.16`, SDK `python-sdk-v1.2.6`, wheel checksum and trusted verification key as immutable **License Core baseline** references.
2. Preserve encrypted off-host full PostgreSQL backup with isolated-restore proof, app-storage and TLS/proxy/environment backup, verified R2 archive and known-good Docker rollback image in private operator storage. Do not publish or mutate those backups in this documentation task.
3. Use **new commit/branch**, new server tag, and **new SDK version/tag when its package changes**; never move or overwrite these existing tags or alter already-published SDK assets.
4. Verify migration/rollback and relevant security regression before any future production deploy. Keep app/license data and signing-key continuity protected. Do not delete PostgreSQL or app-storage volumes.
5. Separate follow-up gates: Admin Realtime delivery/isolation/fallback/load, full license lifecycle and legacy cutover. A future development phase requires separate approval.

**PB-01 publication:** documentation-only commit follows the already-published server tag; no runtime, SDK or production data changes.
