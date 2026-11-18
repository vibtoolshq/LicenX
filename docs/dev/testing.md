# Tests and verification

## Declared commands

```bash
npm run lint
npm test
npm run build
python -m unittest discover -s SDK/client/python/licenx/test -p "test_*.py"
```

`npm run lint` is the TypeScript no-emit type check; `npm test` uses Node's test runner via `tsx`, with serial concurrency on `tests/*.test.ts` and `tests/*.test.mjs`. Prefer relevant targeted files during a scope-locked change. `tests/e2e/` contains disposable browser/network scenarios called by specific CI workflows.

## Coverage domains observed in source

| Test area | Source and examples |
| --- | --- |
| Admin auth, cookies, API input and rate limit | `tests/adminAuth.test.ts`, `adminApiEndpoints.test.ts` |
| Application/license/device policy | `tests/deviceBinding.test.ts`, `licenseHeartbeat.test.ts` |
| Public site and catalog | `tests/publicCatalogApi.test.ts`, `publicCatalogUi.test.ts` |
| Restricted partner check | `tests/publicLicenseApi*.test.ts` (inspect actual file set) |
| Backup and schedule | `tests/backupScheduleTiming.test.ts`, `backupSystemDocker.mjs` |
| Realtime transport/security | `tests/adminRealtime*.test.ts`, SDK integration test files |
| Installer, schema, DB setup | `tests/installer.test.ts`, `dbConfiguration.test.ts` |
| Python SDK | `SDK/client/python/licenx/test/` |

A passing TypeScript build is not proof that a live license/device workflow succeeds. Disposable CI WSS load and backup restore tests are **environment-limited** and do not certify production with customer records.

## Testing safely

- Never point automated tests to live customer license keys, the real PostgreSQL database or public R2 bucket.
- Use a dedicated disposable PostgreSQL database with the test prefix enforced by the test harness.
- Keep public-domain browser acceptance and real SDK/device-binding checks separately authorized and evidenced.
- For documentation changes use link/path validation and Markdown structure checks rather than invoking full app suites.

## Audit state for this suite

The documentation task performed read-only source inspection and documentation QA only. It did **not** rerun the app test suite, a live VPS installer, a restore or SDK license activation. [Audit report](../reference/audit-coverage.md).