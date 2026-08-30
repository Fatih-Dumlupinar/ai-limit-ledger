# Release process

This is the secure, manual-approval release process introduced in Task 14, used for the 0.7.0
first Marketplace release and every release after it. It has two security gates: the pull request
that adds this process (reviewed and merged like any other change), and the manual Marketplace
upload plus `production-release` environment approval that happen after merge. No step in this
process — the pull request or either workflow — creates a git tag, a GitHub Release, or publishes
to the Marketplace by itself.

## Roles

- **`release-candidate.yml`** (automatic on a version bump merged to `main`, or manual
  `workflow_dispatch`; `contents: read`) — builds, tests, audits, and packages `main` at the
  triggering commit, and uploads a seven-day candidate artifact. Never tags, releases, or publishes.
- **A human** — downloads the candidate artifact, verifies its SHA-256, uploads the VSIX to the
  Marketplace manually, and waits for Marketplace validation.
- **`finalize-release.yml`** (`workflow_dispatch` only, gated behind the `production-release`
  environment) — re-verifies the candidate artifact against the exact commit and hash the human
  confirmed, then creates the git tag and GitHub Release. Never uploads to the Marketplace.

## When the candidate builds itself (Task 14.2)

Since Task 14.2 the candidate stage starts on its own. Producing a candidate is a read-only build:
it creates no ref, no release, and no Marketplace upload, so there is nothing to gate behind a human
decision. The decision that _does_ matter — turning a candidate into a public release — is still
manual and approval-gated, and nothing about that changed.

**The candidate starts automatically when** a push lands on `main` that touches `package.json` or
`package-lock.json`, **and** the version in `package.json` is different from the version at the
previous `main` tip, **and** both manifests carry that same new version, **and** the new version is
strict `major.minor.patch`.

**It skips — successfully, building nothing — when** any of those is not true: the manifest changed
without a version change (a new script, a dependency bump), the previous commit is unavailable
(a first push, or an event payload without a usable `before` SHA), or the previous `package.json`
cannot be read. A skipped run is a green run with a job summary saying so; no package, checksum,
SBOM, manifest, or attestation is produced, and no artifact is uploaded.

**It fails** — rather than skipping — when the repository is in a state a human must fix: the two
manifests disagree about the version, the changelog section or release-notes file for the new
version is missing, or the `v<version>` ref already exists.

**To retry manually** (after a skip, or to rebuild an expired candidate), dispatch
`release-candidate.yml` from `main` with the exact version as input. The manual path runs the same
preflight, the same privacy gates, and produces the same artifact; it exists so a release is never
blocked on re-triggering a push. Both paths are promotable by `finalize-release.yml`.

### The privacy gate

Before packaging, the candidate runs `npm run audit:privacy` over the tracked source tree and
`npm run audit:privacy -- --history` over all reachable git history. After the VSIX is built — and
before the artifact upload, SBOM, release manifest, or provenance attestation — it runs
`npm run audit:privacy -- --vsix <file>`. A failure at any of the three stops the job there, so a
package carrying personal data can never become a signed, attested, downloadable artifact. The
audit never prints a matched value; see `docs/PRIVACY-AUDIT.md`.

## Step by step

1. **Merge the pull request** that adds/updates this release system into `main` through the normal
   branch-protection checks (CI, CodeQL, Secret Scan, Dependency Review).
2. **Confirm `main` is green.** After merge, confirm the merge commit's required checks all
   succeeded and `main`/`origin/main` agree.
3. **Let the candidate build, or dispatch it.** If the merge in step 1 bumped the version, the
   Release Candidate run starts by itself — find it in the Actions tab and skip to step 4.
   Otherwise (or to rebuild an expired candidate) dispatch `release-candidate.yml` from the Actions
   tab (or `gh workflow run release-candidate.yml -f version=0.7.0`) with `version` set to the exact
   release version. The workflow refuses to run for any ref other than `main`, and the dispatch
   input must match `package.json` exactly.
4. **Download the artifact** named `ai-limit-ledger-0.7.0-rc-<short-sha>` from the completed run.
   It contains `ai-limit-ledger-0.7.0.vsix`, `SHA256SUMS.txt`, `release-manifest.json`,
   `sbom.cdx.json`, and `RELEASE_NOTES.md`.
5. **Verify the SHA-256** of the downloaded VSIX against `SHA256SUMS.txt` and
   `release-manifest.json`'s `package.sha256` field before uploading anything, anywhere:

   ```powershell
   Get-FileHash ai-limit-ledger-0.7.0.vsix -Algorithm SHA256
   ```

6. **Upload the VSIX to the Marketplace manually** at
   <https://marketplace.visualstudio.com/manage/publishers/fatihdumlupinar-dev> — no `vsce
publish`, no PAT, no CLI. This is the officially supported manual VSIX upload path.
7. **Wait for Marketplace validation** (virus scan and content validation) to complete and the new
   version to show as published.
8. **Verify the live listing**: <https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger>
   shows version `0.7.0`, the correct publisher, and renders the README as expected.
9. **Install-test in a clean profile**: `code --profile release-check --install-extension
fatihdumlupinar-dev.ai-limit-ledger`, confirm the Dashboard, status bar, and EN/TR switching work,
   then remove the temporary profile.
10. **Plan the default-profile migration separately** — see
    `docs/INSTALLATION-MIGRATION-0.7.0.md`. It is not part of finalizing the release and is not
    automated by either workflow.
11. **Approve the `production-release` environment request.** Dispatching `finalize-release.yml`
    creates a pending deployment against the `production-release` environment; a required reviewer
    (configured by the repository owner in GitHub Settings → Environments, not by this workflow)
    must approve it before the job runs.
12. **Dispatch `finalize-release.yml`** with:
    - `version`: `0.7.0`
    - `candidate_run_id`: the run ID from step 3
    - `commit_sha`: the full 40-character commit SHA the candidate was built from (from
      `release-manifest.json`'s `gitCommit` field)
    - `marketplace_url`: exactly
      `https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger`
    - `marketplace_confirmation`: exactly `I_HAVE_VERIFIED_MARKETPLACE_0.7.0`

    The workflow re-downloads the candidate artifact, recomputes its SHA-256, re-runs the VSIX
    release audit, confirms the commit is part of `main`'s history, and only then creates the
    `v0.7.0` tag and the `AI Limit Ledger v0.7.0 (Preview)` GitHub Release (marked pre-release),
    attaching the VSIX, `SHA256SUMS.txt`, `release-manifest.json`, `sbom.cdx.json`, and
    `RELEASE_NOTES.md`.

13. **Confirm the tag and Release** exist, point at the expected commit, and carry the expected
    assets.
14. **Post-release smoke test**: re-download the VSIX from the GitHub Release (not the earlier
    Actions artifact) and confirm its SHA-256 still matches `SHA256SUMS.txt`.
15. **If anything goes wrong at any step, stop and follow `docs/ROLLBACK.md`** for the specific
    failure — do not force-push a tag, overwrite a release asset, or attempt to make the workflow
    "just work" by relaxing a check.

## Why no PAT

This project deliberately does not create an Azure DevOps PAT, a `VSCE_PAT` secret, or any other
Marketplace publishing credential for this task. The first Marketplace upload is done manually by
the project owner through the officially supported VSIX upload path. `vsce login`, `vsce publish`,
and any Marketplace API publish call are out of scope for both workflows — `scripts/verify-workflows.mjs`
enforces this structurally (see the "Secure release system" section of `SECURITY.md`). If full
automation is wanted later, Microsoft's current Entra workload-identity /
federated-credential approach for Marketplace publishing is a separate, deliberately-scoped future
task — not something this task adds as a fallback.

## Why finalize stays manual even though the candidate does not

Automating the candidate and automating the release are different decisions, and Task 14.2 changed
only the first. A candidate build holds `contents: read`, creates nothing outside its own artifact,
and is trivially discarded — automating it removes a chore. Finalizing creates an immutable tag and
a public GitHub Release that people download; that is irreversible in practice and follows a
Marketplace upload only a human can perform and verify. So `finalize-release.yml` remains
`workflow_dispatch`-only, behind the `production-release` environment with a required reviewer, and
still demands the exact listing URL and a version-scoped confirmation phrase typed by hand.

There is deliberately no chain between the two: the candidate workflow declares no `workflow_run`,
`repository_dispatch`, or `workflow_call` trigger, and contains no code that dispatches another
workflow. A successful candidate cannot start a release — it can only tell a human, in its job
summary, what to do next.

## Related documents

- `docs/PRIVACY-AUDIT.md` — what the privacy audit scans, what it deliberately does not, and how
  its reports are redacted.
- `docs/FIRST-MARKETPLACE-RELEASE-0.7.0.md` — the 0.7.0-specific checklist and current status.
- `docs/MARKETPLACE-PREFLIGHT.md` — the manual pre-publish checklist.
- `docs/INSTALLATION-MIGRATION-0.7.0.md` — moving from `local.ai-limit-ledger` to the Marketplace
  identity.
- `docs/ROLLBACK.md` — what to do when a step fails.
- `PUBLISHING.md` — the publisher/extension identity reference.
