# Contributing to LicenX

Start with the repository [CONTRIBUTING.md](../../CONTRIBUTING.md), [AGENTS.md](../../AGENTS.md), [AI_INSTRUCTIONS.md](../../AI_INSTRUCTIONS.md) and [MEMORY.md](../../MEMORY.md). Their scope/approval/security rules take precedence over general advice in this documentation.

## Development workflow

1. Confirm the current source baseline and any pre-existing user changes without discarding them.
2. Select an explicit, bounded change; inspect implementation evidence and related tests.
3. Record private investigation/phase notes in ignored `notes/` where allowed. Never publish that directory.
4. Make the smallest compatible change; run one focused verification and diff audit.
5. Update `MEMORY.md` after an authorized implemented change, or provide exact Markdown when write access is unavailable. Keep docs/source evidence aligned.
6. Commit, push or deploy only within specific authorization and safe synchronization rules.

## Updating documentation

For a feature change, update the relevant feature guide, API/schema/security reference if affected, [manifest](../MANIFEST.md) and [coverage report](../reference/audit-coverage.md). All new `docs/` links should be relative, checked and path-valid. Mark screenshots, production acceptance and demo examples as unverified unless actually tested.

**Security:** Never include real tokens, passwords, keys, PINs, customer identifiers, backup recovery material or ignored local forensic notes in tracked documents.