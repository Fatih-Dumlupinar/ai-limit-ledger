# Publishing checklist

Task 13 prepared Marketplace listing content and package identity. Task 14 adds the release system
(`.github/workflows/release-candidate.yml` and `.github/workflows/finalize-release.yml`, both
`workflow_dispatch`-only) described in `docs/RELEASE-PROCESS.md`. Neither this repository nor
either workflow ever runs `vsce publish`, holds a PAT/`VSCE_PAT`, or calls a Marketplace publish
API — the Marketplace upload is always a manual VSIX upload performed by the publisher-portal
owner.

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
- Task 13 did **not** perform this migration — it did not uninstall any existing local
  installation, install a new VSIX into the default profile, or touch user settings. The first
  controlled migration is a manual, user-driven step described in
  `docs/INSTALLATION-MIGRATION-0.7.0.md`, done after the 0.7.0 Marketplace version is live.

## Publishing 0.7.0 and later versions

See `docs/RELEASE-PROCESS.md` for the full step-by-step procedure. In summary:

1. Confirm the Marketplace publisher `fatihdumlupinar-dev` exists (already created and verified by
   the project owner outside this task — no publisher-portal write actions were taken here).
2. Re-check Marketplace name uniqueness immediately before the first release (a point-in-time
   search during Task 13 found no existing `ai-limit-ledger` package name or "AI Limit Ledger"
   display name on the public Marketplace, but that can change).
3. Dispatch `.github/workflows/release-candidate.yml` with the exact version to build. It packages,
   audits, and uploads a candidate artifact (VSIX, SHA-256, SBOM, release manifest) — it never
   publishes anything.
4. Verify the candidate's SHA-256, then upload the VSIX to the Marketplace **manually** through the
   publisher portal at
   `https://marketplace.visualstudio.com/manage/publishers/fatihdumlupinar-dev`. This project
   deliberately does not create a PAT, `VSCE_PAT`, or any other Marketplace publishing credential —
   no workflow runs `vsce login` or `vsce publish`. If full automation is wanted later, Microsoft's
   current Entra workload-identity / federated-credential approach for Marketplace publishing is a
   separate, deliberately-scoped future task.
5. For updates, increment the version, update `CHANGELOG.md`, run tests/package, then repeat the
   candidate/upload/finalize cycle for the new version. The 0.7.0 development artifact is
   `ai-limit-ledger-0.7.0.vsix`.
6. Before publishing, run both `npm audit` (requires npm registry network access — checks known
   advisories against the resolved dependency tree) and `npm run audit:release -- <file>.vsix` (a
   separate, dependency-free, fully offline local/VSIX content check) against the freshly packaged
   VSIX and confirm the latter reports zero `fail` findings. These two commands check different
   things and neither substitutes for the other. `release-candidate.yml` runs both automatically.
7. Build and test on a supported Node LTS (Node 24 preferred, Node 22 minimum — see
   `.nvmrc`/`package.json` `engines.node`); Node 20 is end-of-life and unsupported for development.
8. Complete every item in `docs/MARKETPLACE-PREFLIGHT.md`. Screenshots are optional (see below) and
   are not one of the required items.
9. After the Marketplace upload is verified, dispatch `.github/workflows/finalize-release.yml`
   (gated behind the `production-release` GitHub Environment) to create the git tag and GitHub
   Release. It never touches the Marketplace.

Before publishing, first complete the ruleset checks documented in `docs/BRANCH-RULESET.md` and
confirm that CI, CodeQL, Secret Scan, and Dependency Review are green on the commit being released.
Do not add Marketplace credentials to CI or to this repository — see `docs/RELEASE-PROCESS.md` for
why.

Before publishing 0.6.x, verify the Marketplace description clearly says that Copilot uses the
official GitHub Billing REST API plus VS Code auth or an explicit Plan-read PAT, and that Grok
tries the official `x.ai/billing` ACP method first while its CLI-proxy fallback is experimental and
opt-in. Do not imply xAI, GitHub, Microsoft, OpenAI, or Anthropic endorsement.

Marketplace screenshots are **optional** — the Marketplace has no manifest field for them and no
publishing rule that requires them, so a missing screenshot never blocks or delays a publish. If
real product screenshots are added later as a separate, optional documentation-only enhancement,
see `docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md` for the safe, synthetic-data capture procedure and
`docs/MARKETPLACE-ASSET-INVENTORY.md` for the current status of each file.
