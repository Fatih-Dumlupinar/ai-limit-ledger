# Publishing checklist

Task 13 prepares Marketplace listing content and package identity; it does **not** publish a
release, upload a Marketplace artifact, run `vsce publish`, create a PAT/publishing token, or
configure any release automation. The CI package job creates a short-retention validation artifact
only. Ruleset configuration and any future publish workflow remain separate, manually reviewed
work, tracked for Task 14.

This extension is not published yet. It is an independent, unofficial extension and must never
imply endorsement by Microsoft, GitHub, OpenAI, Anthropic, or xAI — see the non-affiliation notice
in `README.md` / `README.tr.md`.

## Identity (set in this task)

- Publisher ID: **`fatihdumlupinar-dev`** (Marketplace publisher, distinct from the `Fatih-Dumlupinar` GitHub account).
- Permanent extension ID once published: **`fatihdumlupinar-dev.ai-limit-ledger`**.
- `package.json`'s `publisher` field has been changed from `local` to `fatihdumlupinar-dev`.
  `name` (`ai-limit-ledger`), `displayName` (`AI Limit Ledger`), and `version` (`0.6.2`) are
  unchanged.

## Installation identity change — read before switching

Changing `publisher` changes VS Code's extension identity from `local.ai-limit-ledger` to
`fatihdumlupinar-dev.ai-limit-ledger`. VS Code treats these as two **completely separate**
extensions, not an upgrade path:

- If you have `local.ai-limit-ledger` installed from an earlier development build, installing a
  VSIX built under the new identity **adds a second extension** rather than replacing it. Running
  both at once can register duplicate status bar items, duplicate commands, and duplicate
  background refresh timers.
- Settings keys (`aiLimitLedger.*`) do not change, so both identities would read/write the same
  settings if run simultaneously — another reason not to run both at once.
- The correct sequence when the time comes: **uninstall `local.ai-limit-ledger` first**, then
  install the `fatihdumlupinar-dev.ai-limit-ledger` build. No user settings are auto-migrated or
  auto-deleted by this project; VS Code's own settings storage is keyed by setting name, not by
  extension identity, so preferences are unaffected by the identity change itself.
- Task 13 does **not** perform this migration — it does not uninstall any existing local
  installation, install a new VSIX into the default profile, or touch user settings. The first
  controlled migration happens in Task 14, alongside the first real publish.

## Before a future publish (Task 14 and later)

1. Confirm the Marketplace publisher `fatihdumlupinar-dev` exists (already created and verified by
   the project owner outside this task — no publisher-portal write actions were taken here).
2. Re-check Marketplace name uniqueness immediately before the first release (a point-in-time
   search during Task 13 found no existing `ai-limit-ledger` package name or "AI Limit Ledger"
   display name on the public Marketplace, but that can change).
3. Create a local-only PAT with **Marketplace: Manage**, or use Microsoft Entra workload identity /
   GitHub OIDC; never put a PAT in this repository, prompts, or logs. Not created as part of
   Task 13.
4. Run `vsce login fatihdumlupinar-dev`, then `vsce package` and `vsce publish`. Not run as part of
   Task 13.
5. For updates, increment the version, update CHANGELOG, run tests/package, then publish. The
   current development artifact is `ai-limit-ledger-0.6.2.vsix`.
6. Before publishing, run both `npm audit` (requires npm registry network access — checks known
   advisories against the resolved dependency tree) and `npm run audit:release -- <file>.vsix` (a
   separate, dependency-free, fully offline local/VSIX content check) against the freshly packaged
   VSIX and confirm the latter reports zero `fail` findings. These two commands check different
   things and neither substitutes for the other.
7. Build and test on a supported Node LTS (Node 24 preferred, Node 22 minimum — see
   `.nvmrc`/`package.json` `engines.node`); Node 20 is end-of-life and unsupported for development.
8. Complete every item in `docs/MARKETPLACE-PREFLIGHT.md`. Screenshots are optional (see below) and
   are not one of the required items.

Before a future publish, first complete the ruleset checks documented in `docs/BRANCH-RULESET.md`
and confirm that the Task 12 CI, CodeQL, Secret Scan, and Dependency Review checks are green. Do
not add Marketplace credentials to CI or to this repository.

Before publishing 0.6.x, verify the Marketplace description clearly says that Copilot uses the
official GitHub Billing REST API plus VS Code auth or an explicit Plan-read PAT, and that Grok
tries the official `x.ai/billing` ACP method first while its CLI-proxy fallback is experimental and
opt-in. Do not imply xAI, GitHub, Microsoft, OpenAI, or Anthropic endorsement.

Marketplace screenshots are **optional** — the Marketplace has no manifest field for them and no
publishing rule that requires them, so a missing screenshot never blocks or delays a publish. If
real product screenshots are added later as a separate, optional documentation-only enhancement,
see `docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md` for the safe, synthetic-data capture procedure and
`docs/MARKETPLACE-ASSET-INVENTORY.md` for the current status of each file.
