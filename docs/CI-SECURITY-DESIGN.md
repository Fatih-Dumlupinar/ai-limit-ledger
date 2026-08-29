# CI security design (for Task 12 — not implemented in this release)

This document is a **design only**. No `.github/` directory or workflow file is created by
Task 10; this is the plan Task 12 should implement once the repository is public (Task 11).

## Goals

- Every pull request and push to `main` compiles, lints, format-checks, runs the full test
  suite, and runs `npm run audit:release` before it can merge.
- A compromised or malicious PR from a fork cannot exfiltrate secrets, modify protected
  branches, or publish a release.
- The workflow itself has the smallest possible permission footprint and the smallest possible
  set of third-party actions, each pinned to a full commit SHA.

## Proposed workflow shape

A single `ci.yml` workflow, triggered on `pull_request` (from forks and same-repo branches) and
`push` to `main`:

```text
permissions:
  contents: read        # default; nothing in CI needs to write to the repo

jobs:
  verify:
    runs-on: windows-latest   # Claude wrapper tests (ClaudeWrapperRunner) spawn real
                               # powershell.exe and are Windows-specific; a second
                               # ubuntu-latest job can run the OS-agnostic subset if the
                               # POSIX wrapper path is ever exercised in CI.
    steps:
      - uses: actions/checkout@<pinned-sha>       # no submodules, no credentials persisted
        with:
          persist-credentials: false
      - uses: actions/setup-node@<pinned-sha>
        with:
          node-version-file: '.nvmrc'               # Node 24 LTS — matches engines.node (>=22.12.0 minimum)
      - run: npm ci
      - run: npm run compile
      - run: npm run lint
      - run: npm run format:check
      - run: npm run audit:release
      - run: npm test
      - run: npm run package
      - run: npm run audit:release -- ai-limit-ledger-*.vsix
```

### Why `permissions: contents: read`

The workflow never needs to write to the repository, open PRs, or publish releases — those are
separate, explicitly-gated jobs (see below). Read-only `GITHUB_TOKEN` scope means a compromised
dependency (e.g. through a malicious transitive `devDependency` update) cannot use the ambient
token to push code, create releases, or modify repository settings.

### Why every action is pinned to a commit SHA, not a floating tag

A floating tag (`actions/checkout@v4`) can be repointed by the action's maintainer (or an
attacker who compromises that maintainer's account) to a different commit without any change
visible in this repository's history. Pinning `uses: owner/repo@<40-char-sha>` makes the exact
code that runs auditable and reviewable, and Dependabot (see below) can still propose SHA
bumps.

### Why forks never see secrets

`pull_request` (not `pull_request_target`) is used for the verify job, so workflows triggered
by a fork's PR run with a read-only token and **no repository secrets** are exposed to them by
default. Nothing in this project's CI needs a secret to compile/lint/test/package/audit, so no
secret is declared for this job at all.

## Branch protection (Task 12 configuration, not a file in this repo)

- Require the `verify` status check to pass before merging to `main`.
- Require branches to be up to date before merging.
- Disallow force-push and branch deletion on `main`.
- Require at least one review before merging (once there are collaborators beyond the sole
  maintainer; a solo-maintainer repo may instead require the check alone).

## A separate, manually-triggered publish workflow (out of scope for Task 12, noted for later)

Publishing to the Marketplace should **not** be automatic on every push to `main`. A future,
separate `publish.yml` triggered only on a manually-created Git tag (e.g. `v0.7.0`) would:

- run the exact same `verify` steps first,
- use a dedicated `secrets.VSCE_PAT` with only **Marketplace: Manage** scope, stored as a
  repository (not organization-wide) secret,
- run `vsce publish` only after `npm run audit:release -- <vsix>` reports zero `fail` findings,
  and
- never run on a `pull_request` trigger, so a fork can never cause a publish.

This publish workflow is explicitly **not** part of Task 12's scope per the Task 10 brief and is
recorded here only so the design is not lost before Task 12 begins.

## Dependency update automation (Task 12 configuration)

A `dependabot.yml` limited to the `npm` ecosystem, weekly cadence, grouped minor/patch updates,
targeting `package.json`'s 9 direct devDependencies. Given the project has zero production
dependencies, Dependabot's blast radius is inherently limited to build/test tooling; any PR it
opens still has to pass the same `verify` workflow, including `npm run audit:release`, before
merge.

## Current GitHub availability

At Task 11 completion, GitHub-native secret scanning and push protection were not offered in
the repository settings available to the owner. Task 12 must therefore add an independent CI
secret scan and evaluate a local/pre-commit safeguard without claiming that GitHub-native push
protection is enabled. Native features should be re-evaluated if they become available later.

## Secret scanning (Task 12 configuration)

Task 12 must select and add an independent CI secret scan, then evaluate a local/pre-commit
safeguard. The tool choice is intentionally not fixed by this design. The existing
`scripts/release-audit.mjs` local credential-pattern scan remains a complementary offline check
for contributors; it does not represent GitHub-native secret scanning or push protection.
