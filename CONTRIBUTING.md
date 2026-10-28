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

4. For Python client changes, test the **primary** SDK at [`SDK/client/python/licenx`](SDK/client/python/licenx/README.md). Run reference `SDK/x_license_python` tests when compatibility or archive behavior is affected.
5. Include a concise change explanation, regression evidence, security impact and any backward-compatibility caveat in your pull request.

## Python SDK layout

- **Primary application integration:** `SDK/client/python/licenx/`, installed with `python -m pip install ./SDK/client/python/licenx`; import `licenx`.
- **Reference/compatibility implementation:** `SDK/x_license_python/`; import `x_license_python`. Do not present it as the default for new integrations.
- **Existing downloadable ZIP:** `public/x_license_python.zip` is generated from the reference tree. Changing its source/contract requires an explicit implementation change, not just documentation edits.

## Safety and documentation

Do not commit passwords, signing keys, licenses, `.env`, backup archives or anything under private `notes/`. Preserve existing routes, database migrations, SDK imports and UI behavior unless an authorized change requires otherwise. Update relevant public Markdown when behavior changes, and label historical verification evidence as such.

Security reports: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
