# Release process

This is the secure, manual-approval release process introduced in Task 14, used for the 0.7.0
first Marketplace release and every release after it. It has two security gates: the pull request
that adds this process (reviewed and merged like any other change), and the manual Marketplace
upload plus `production-release` environment approval that happen after merge. No step in this
process — the pull request or either workflow — creates a git tag, a GitHub Release, or publishes
to the Marketplace by itself.

## Roles

- **`release-candidate.yml`** (`workflow_dispatch` only, `contents: read`) — builds, tests, audits,
  and packages `main` at its current tip, and uploads a short-retention candidate artifact. Never
  tags, releases, or publishes.
- **A human** — downloads the candidate artifact, verifies its SHA-256, uploads the VSIX to the
  Marketplace manually, and waits for Marketplace validation.
- **`finalize-release.yml`** (`workflow_dispatch` only, gated behind the `production-release`
  environment) — re-verifies the candidate artifact against the exact commit and hash the human
  confirmed, then creates the git tag and GitHub Release. Never uploads to the Marketplace.

## Step by step

1. **Merge the pull request** that adds/updates this release system into `main` through the normal
   branch-protection checks (CI, CodeQL, Secret Scan, Dependency Review).
2. **Confirm `main` is green.** After merge, confirm the merge commit's required checks all
   succeeded and `main`/`origin/main` agree.
3. **Dispatch `release-candidate.yml`** from the Actions tab (or `gh workflow run
release-candidate.yml -f version=0.7.0`) with `version` set to the exact release version
   (`0.7.0`). The workflow refuses to run for any other ref than `main` or any other version.
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

## Related documents

- `docs/FIRST-MARKETPLACE-RELEASE-0.7.0.md` — the 0.7.0-specific checklist and current status.
- `docs/MARKETPLACE-PREFLIGHT.md` — the manual pre-publish checklist.
- `docs/INSTALLATION-MIGRATION-0.7.0.md` — moving from `local.ai-limit-ledger` to the Marketplace
  identity.
- `docs/ROLLBACK.md` — what to do when a step fails.
- `PUBLISHING.md` — the publisher/extension identity reference.
