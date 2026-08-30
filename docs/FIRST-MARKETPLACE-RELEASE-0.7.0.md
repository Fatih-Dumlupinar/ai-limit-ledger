# First Marketplace release — 0.7.0 status

Tracks the specific 0.7.0 release, layered on top of the general `docs/RELEASE-PROCESS.md`. Update
the status table as each step actually happens — this document records what happened, it does not
predict it.

## Decision record

| Decision                   | Value                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Version                    | `0.7.0`                                                                                   |
| Channel                    | Standard Marketplace (not `vsce --pre-release`)                                           |
| `preview` manifest field   | `true` (kept)                                                                             |
| GitHub Release             | marked pre-release, to reflect the same preview status                                    |
| Marketplace screenshots    | not included — optional, not a release blocker (Task 13.1)                                |
| Marketplace authentication | none created for this task — manual VSIX upload only                                      |
| Publisher                  | `fatihdumlupinar-dev`                                                                     |
| Extension ID               | `fatihdumlupinar-dev.ai-limit-ledger`                                                     |
| Marketplace listing URL    | `https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger` |

## Status

| Step                                          | Status                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| 1. PR merged to `main`                        | Pending — this document ships as part of the PR that has not merged yet       |
| 2. `main` checks green                        | Pending                                                                       |
| 3. `release-candidate.yml` dispatched         | Not run                                                                       |
| 4. Candidate artifact downloaded              | Not run                                                                       |
| 5. SHA-256 verified                           | Not run                                                                       |
| 6. Manual Marketplace VSIX upload             | Not done                                                                      |
| 7. Marketplace validation passed              | Not done                                                                      |
| 8. Listing verified live at 0.7.0             | Not done                                                                      |
| 9. Clean-profile install test                 | Not done                                                                      |
| 10. Default-profile migration                 | Not done (separate, user-driven — see `docs/INSTALLATION-MIGRATION-0.7.0.md`) |
| 11. `production-release` environment approved | Not requested                                                                 |
| 12. `finalize-release.yml` dispatched         | Not run                                                                       |
| 13. `v0.7.0` tag created                      | Not created                                                                   |
| 14. GitHub Release created                    | Not created                                                                   |
| 15. Post-release smoke test                   | Not run                                                                       |

This task (the pull request that adds the release system) intentionally stops here: it does not
dispatch either workflow, does not create the tag or Release, and does not touch the Marketplace.
Update this table as each step is actually completed after merge.

## Prerequisites the repository owner must complete before dispatching `finalize-release.yml`

- Create the `production-release` GitHub Environment (Settings → Environments → New environment)
  with at least one required reviewer. Neither workflow creates or modifies this environment —
  see `docs/RELEASE-PROCESS.md`.
- Complete every item in `docs/MARKETPLACE-PREFLIGHT.md` against the actual commit being released.

## What this task verified before writing any release automation

- Manual VSIX upload is the officially supported Marketplace publishing path documented at
  <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>.
- Global Azure DevOps PATs (the classic mechanism `vsce login` has historically used) are subject
  to Microsoft's announced retirement of legacy PAT flows; this task avoids creating one entirely
  rather than depending on a mechanism with a known retirement path.
- A GitHub Environment with required reviewers pauses the referencing job until an authorized
  reviewer approves the run, which is the manual-approval gate `finalize-release.yml` relies on.
- GitHub Artifact Attestations (`actions/attest-build-provenance`) are available for this
  repository because it is public (`ai-limit-ledger` is `PUBLIC`, confirmed via the GitHub API
  during this task).
- `@vscode/vsce` remains a `devDependency` only, pinned to a stable release, installed
  deterministically via `package-lock.json`, and is never invoked with `publish`.
