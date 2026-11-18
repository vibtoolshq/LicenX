# Existing-documentation reconciliation

The audit compared the current implementation and available existing docs (`README.md`, `MEMORY.md`, `AGENTS.md`, `project/README.md`, SDK guides, deployment/release notes, historic feature documentation). **Only `docs/` is authorized for changes** in this task; existing historical files outside `docs/` were not rewritten.

| Source/document claim or potential conflict | Verified evidence | Resolution in this suite |
| --- | --- | --- |
| Old `MEMORY.md` mentions the reference `SDK/x_license_python/` | Folder absent; primary `licenx 1.2.6` is maintained in `SDK/client/python/licenx/pyproject.toml` | All current guides use `licenx`; older memory records explicitly treated as historical |
| Old snapshot marks HF-01 “NOT DEPLOYED” | User operator supplied Step 1–12 production app-only rollout acceptance on `b9ca5d4`; subsequent docs-only GitHub commits are not automatically VPS deployments | Current audit uses last accepted **production** commit and identifies GitHub vs VPS difference |
| Old `PublicToolsTab.tsx` feedback says public gallery is a future phase | `src/App.tsx` routes `/tools`; `PublicToolsPage.tsx` renders cards/empty state | Document current implemented gallery; note stale UI message as documentation/UI debt |
| Root npm metadata says `react-example 0.0.5` while product is LicenX | `package.json` names internal package; maintained SDK is separately versioned `1.2.6` | Dependency reference explains distinct metadata |
| Some prose calls public license checking read-only | `src/server/api.ts:1768-1822` can persist expired status; restricted partner handler does not update license/device status | Separate both APIs and their effects in portal/API docs |
| Source contains optional realtime modules; older CI reports show success | `compose.yaml` has separate default-off flags; `server.ts` conditionally enables them | Document **source implemented, deployment gated**; do not call production WSS certified |
| “Backup completed” sometimes interpreted as “restore ready” | `backupControl.ts` has key/worker status but restore performs substantial verification/changes | Require isolated restore drill; no production restore claimed |

## Reconciliation policy

For every new documentation edit, trace code/data contracts before updating descriptions. If a product defect, stale button label, unsafe policy or misleading external README appears, report it with evidence. Modifying product source, root README, SDK release notes or `MEMORY.md` is outside **this task's strict `docs/` write scope**. No out-of-scope files were changed.

**Scope qualifier:** Not every historical SDK feature audit or deployment snapshot was manually reconciled line by line. The linked [source inventory](source-inventory.md) machine-read these files; targeted human reconciliation focused on active code/docs conflicts. Unexamined claims must not be treated as confirmed.