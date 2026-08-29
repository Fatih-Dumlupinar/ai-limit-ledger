# Installation migration: `local.ai-limit-ledger` → `fatihdumlupinar-dev.ai-limit-ledger`

VS Code identifies an extension by `<publisher>.<name>`, not by display name. Changing the
`publisher` field (done in Task 13, from `local` to `fatihdumlupinar-dev`) therefore changes the
extension's identity from `local.ai-limit-ledger` to `fatihdumlupinar-dev.ai-limit-ledger`. **VS
Code treats these as two completely separate extensions, not as an upgrade path for one extension.**
This document describes the controlled migration; the actual migration itself is a manual action
you take after the Marketplace version is live — it is not automated by this task or by either
release workflow.

## Before you start

- Confirm the Marketplace version is actually published and verified: open
  <https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger> and
  confirm it shows `0.7.0`.
- This task does not perform a default-profile migration. Treat the steps below as something you
  run yourself, when you choose to.

## What is shared between the two identities, and what is not

- **Settings are shared.** Every `aiLimitLedger.*` setting key is unchanged by the publisher
  switch, so both identities read/write the same settings if both happen to be installed and
  active at once — which is exactly why running both together is not supported (see below).
- **`globalState` and Secret Storage are not automatically migrated.** VS Code partitions
  per-extension `globalState` and `SecretStorage` by extension identity. Anything
  `local.ai-limit-ledger` stored under its own identity (e.g. Claude/Copilot/Grok consent
  bookkeeping, chained-status-line backup) does **not** carry over to
  `fatihdumlupinar-dev.ai-limit-ledger` automatically. Nothing in this project exports a secret or
  converts one to plain text to work around this — see `PRIVACY.md`.
- **Provider consent/repair is per-identity.** Because consent bookkeeping does not carry over, you
  will need to re-run consent flows (Claude Code enable, experimental transports, Copilot/Grok
  opt-ins) under the new identity if you use them.

## Migration steps

1. **Do not install both at once.** Running `local.ai-limit-ledger` and
   `fatihdumlupinar-dev.ai-limit-ledger` simultaneously can register duplicate status bar items,
   duplicate commands, and duplicate background refresh timers, since both read the same settings
   keys independently.
2. Uninstall `local.ai-limit-ledger` from the profile you are migrating.
3. Install `fatihdumlupinar-dev.ai-limit-ledger` from the Marketplace.
4. Run **Developer: Reload Window** once.
5. Confirm there is exactly one AI Limit Ledger status bar item and no duplicate commands in the
   Command Palette.
6. Open the Dashboard and confirm both EN and TR (`aiLimitLedger.display.language`) render
   correctly.
7. Re-run any provider enable/consent flow you previously used (Claude Code status-line enable,
   experimental Claude OAuth usage, Copilot connect, Grok enable) — expect to see the normal
   first-time setup state, not an error, since this identity has never held that consent before.
8. Watch the first provider refresh under the new identity to confirm network/CLI behavior looks
   the same as before (a Diagnose command for the relevant provider is the fastest way to check).

## If something goes wrong

You can remove `fatihdumlupinar-dev.ai-limit-ledger` and reinstall the earlier
`local.ai-limit-ledger` VSIX manually from a local build. This restores the old identity's UI, but
**does not guarantee data continuity** — `globalState`/`SecretStorage` migration is not guaranteed
in either direction, for the same partitioning reason described above. Treat any provider
consent/repair state as something you may need to redo either way.

## Scope note

This document intentionally does not cover migrating VS Code's default profile as part of this
task — see `docs/RELEASE-PROCESS.md` step 10. It describes the same procedure you would use for the
default profile, but running it there is a decision you make separately, after you have verified
the migration works in a disposable profile first.
