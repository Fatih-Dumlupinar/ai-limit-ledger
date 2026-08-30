# Rollback

None of the scenarios below are automated by `release-candidate.yml` or `finalize-release.yml` on
purpose — a tag, a GitHub Release, and a published Marketplace version are each meant to be
difficult to undo by accident, and neither workflow ever force-moves a tag, overwrites a release
asset, or unpublishes/removes a Marketplace version. Work through the matching scenario manually.

## Two facts that shape every scenario below

- **A git tag, once pushed, and a GitHub Release asset, once uploaded, are treated as immutable by
  this project's own tooling.** `finalize-release.yml` refuses to move an existing `v0.7.0` tag to
  a different commit and refuses to overwrite an existing release asset — by design, not as a
  current limitation. A genuine mistake is fixed with a new patch version, not by rewriting
  history.
- **The Marketplace does not allow re-publishing the same version number.** Once `0.7.0` is
  uploaded, a bad `0.7.0` cannot be replaced with a corrected `0.7.0` — the fix ships as `0.7.1`.

## Scenario: the release candidate build/test/audit failed

Nothing was published. Fix the underlying issue on `main` through the normal PR process and
dispatch `release-candidate.yml` again. No cleanup needed — the failed run's artifact (if any
partial one exists) simply expires after its retention window.

## Scenario: Marketplace upload validation failed

Nothing beyond the failed upload attempt happened — no tag, no Release, no live listing change.
Fix the underlying issue (README rendering, icon, manifest field, etc.), rebuild via
`release-candidate.yml` if the fix touched `main`, and retry the manual upload. Do not dispatch
`finalize-release.yml` until the Marketplace listing is actually live and verified.

## Scenario: Marketplace published, but `finalize-release.yml` failed before creating the tag/Release

The Marketplace listing is live but there is no corresponding git tag or GitHub Release yet — an
inconsistent-but-recoverable state. Diagnose the failure from the workflow run's logs (input
validation, artifact/hash mismatch, ancestry check, environment approval), fix it, and re-dispatch
`finalize-release.yml` with the same inputs. The workflow's tag/release steps are idempotent: if
the tag doesn't exist yet, it is created; if the release doesn't exist yet, it is created; existing
assets are never re-uploaded or overwritten.

## Scenario: the tag was created but the GitHub Release step failed

Re-dispatch `finalize-release.yml` with the same inputs. The tag-creation step detects the existing
`v0.7.0` tag, confirms it already points at the expected commit, and leaves it untouched; the
release-creation step then proceeds normally. The workflow never force-moves a tag it finds
already pointing at the right commit, and fails loudly (without touching anything) if an existing
tag points at the _wrong_ commit — that is not something to work around, it means the inputs are
wrong.

## Scenario: the published Marketplace version has a critical runtime bug

The Marketplace does not support un-publishing a specific version's content and does not allow
re-using its version number:

1. Fix the bug on `main` through the normal PR process.
2. Bump to the next patch version (`0.7.1`) — never re-use `0.7.0`.
3. Run the same `release-candidate.yml` → manual verify → manual Marketplace upload →
   `finalize-release.yml` process for `0.7.1`.
4. If the bug is severe enough that `0.7.0` should not be installed by new users while `0.7.1` is
   prepared, use the Marketplace publisher portal's own "unpublish"/deprecate control for `0.7.0`
   manually — this is a human, publisher-portal action, deliberately not something either workflow
   automates, and it does not delete `0.7.0`'s GitHub Release or tag (GitHub history is a separate,
   permanent record of what shipped).
5. Document the incident (what broke, who is affected, the fix version) in the next release's
   `CHANGELOG.md` entry.

## Scenario: decide between unpublishing and shipping a new patch

Default to a new patch version — it is reversible, keeps the version history honest, and does not
strand users who already installed `0.7.0` without an upgrade path. Reserve
unpublishing/deprecating a version on the Marketplace for cases with a genuine safety or compliance
reason to actively discourage new installs of that exact version while the patch is prepared.

## What is explicitly never automated here

- Deleting or force-moving a git tag.
- Deleting or overwriting a GitHub Release asset.
- Marketplace unpublish/remove/deprecate for any version.
- Any destructive rollback step in general — every scenario above is a manual, deliberate action
  taken by a human with the appropriate access, not a workflow `run:` step.
