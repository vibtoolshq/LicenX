# Contributing to LicenX

Thanks for improving LicenX. Changes should be small, reviewable, compatible and verified against the existing codebase.

## Development workflow

1. Fork the repository, create a topic branch and keep unrelated work out of the diff.
2. Read [AGENTS.md](AGENTS.md) and [AI_INSTRUCTIONS.md](AI_INSTRUCTIONS.md). Follow the applicable scope and private-notes rules.
3. Install dependencies and run focused checks:

   ```bash
   npm ci
   npm run lint
   npm test
   npm run build
   ```

4. Test the **single supported** Python SDK at [`SDK/client/python/licenx`](SDK/client/python/licenx/README.md). Verify source archive parity and wheel/sdist packaging whenever a distribution contract changes.
5. Include a concise change explanation, regression evidence, security impact and any backward-compatibility caveat in your pull request.

## Python SDK layout

- **Primary application integration:** `SDK/client/python/licenx/`, installed with `python -m pip install ./SDK/client/python/licenx`; import `licenx`.
- **Configuration:** app-root `licenx.config.py` is parsed as literal data. Protect the trusted server origin/public key independently in consuming applications.
- **Primary SDK source archive:** `public/licenx-python-sdk.zip` comes from `SDK/client/python/licenx`. Old `x_license_python` imports are a breaking compatibility change; use `licenx`.

## Safety and documentation

Do not commit passwords, signing keys, licenses, `.env`, backup archives or anything under private `notes/`. Preserve existing routes, database migrations, SDK imports and UI behavior unless an authorized change requires otherwise. Update relevant public Markdown when behavior changes, and label historical verification evidence as such.

Security reports: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
