# CI and repository security design (Task 12)

Task 12 implements four GitHub Actions workflows and a dependency-free local policy verifier.
They are intentionally read-first checks: none publishes a release, uploads to the Marketplace,
opens a pull request, or writes repository content.

## Workflow responsibilities

| Workflow            | Trigger                           | Responsibility                                                                                                 |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CI`                | PR/push to `main`, manual         | Node 24 quality matrix on Ubuntu and Windows; Ubuntu npm audits; package and audit a VSIX after quality passes |
| `CodeQL`            | PR/push to `main`, weekly, manual | JavaScript/TypeScript analysis with CodeQL `build-mode: none`                                                  |
| `Secret Scan`       | PR/push to `main`, manual         | Full Git-history scan with the official Gitleaks CLI and redacted SARIF output                                 |
| `Dependency Review` | PR to `main` only                 | Reject changed dependencies at `moderate` severity or higher                                                   |

The quality jobs use `node-version-file: .nvmrc`, npm caching keyed by `package-lock.json`, and
only `npm ci`. They run `compile`, `lint`, `format:check`, `audit:release`, and `test` on both
operating systems. Ubuntu additionally runs `npm audit --audit-level=moderate` and
`npm audit --omit=dev --audit-level=moderate`. The package job has `needs: quality`, starts from a
fresh checkout and `npm ci`, runs `npm run package`, audits the generated VSIX, and uploads it as a
non-release artifact with seven-day retention.

## Action supply-chain policy

Every external Action is from its official repository, uses a full 40-character release commit
SHA, and has a same-line release-version comment. The SHAs below were resolved from the official
release tags (annotated tags were dereferenced):

| Action                             | Release tag | Pinned commit                              | Official release                                                                   |
| ---------------------------------- | ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `actions/checkout`                 | `v7.0.1`    | `3d3c42e5aac5ba805825da76410c181273ba90b1` | [release](https://github.com/actions/checkout/releases/tag/v7.0.1)                 |
| `actions/setup-node`               | `v7.0.0`    | `820762786026740c76f36085b0efc47a31fe5020` | [release](https://github.com/actions/setup-node/releases/tag/v7.0.0)               |
| `actions/upload-artifact`          | `v7.0.1`    | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | [release](https://github.com/actions/upload-artifact/releases/tag/v7.0.1)          |
| `github/codeql-action`             | `v4.37.9`   | `cdf488f595d80d6e07e03d4674febd5ab45fa938` | [release](https://github.com/github/codeql-action/releases/tag/v4.37.9)            |
| `actions/dependency-review-action` | `v5.0.0`    | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | [release](https://github.com/actions/dependency-review-action/releases/tag/v5.0.0) |

Dependabot is configured to propose future SHA updates for GitHub Actions. A tag comment keeps
the human-reviewable release identity next to the immutable reference; it does not make the
reference mutable.

## Permissions and fork model

`CI`, `Secret Scan`, and `Dependency Review` declare only `contents: read`. CodeQL declares
`contents: read` and `security-events: write`, which is required to upload CodeQL results. No
other write permission is granted. All workflows use `pull_request` for pull requests, so fork
code is not executed with a target-branch trust boundary or repository secrets. No workflow uses
`pull_request_target`, because combining that trigger with checkout of PR-controlled code could
expose a write-capable token or a secret to untrusted code.

No workflow interpolates `github.event`, branch, actor, ref, or workflow-dispatch input directly
inside a shell command. The only context expressions are used in workflow metadata, conditions,
artifact paths, and concurrency keys. Every job has a timeout and every workflow has
branch/ref-based concurrency; an updated PR cancels its older run where appropriate.

## CodeQL

The analysis language is `javascript-typescript`. JavaScript/TypeScript uses CodeQL's
`build-mode: none`; no unnecessary custom build, provider login, credential, or model call is
added. The scheduled run is weekly and is explicitly guarded to the default `main` branch. If
CodeQL is unavailable because of a repository plan or setting, the workflow remains present and
the failed check must be reported and remediated in GitHub settings; it is not silently removed.

## Independent secret scanning

GitHub-native Secret Scanning and Push Protection were recorded as unavailable in the original
Task 12 starting brief. The current GitHub API metadata check reports both features as enabled,
but Task 12 neither changed nor relies exclusively on those settings. The independent scan stays
in the repository because native availability can vary by repository plan and account.

`Secret Scan` checks out `fetch-depth: 0`, downloads the official
[`gitleaks v8.30.1` release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) Linux x64
asset, downloads the release's official `gitleaks_8.30.1_checksums.txt`, confirms the archive line
matches the recorded SHA-256
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, and runs `sha256sum --check`
before extraction. A failed download or checksum stops the job. Gitleaks runs `git` against the
complete checkout with `--redact`, emits SARIF, and exits non-zero on findings. The report upload
is explicitly bounded and is configured to ignore a missing report after an earlier failure; it
does not turn a scan failure into a success and does not contain raw secret values by design.

The repository's existing `npm run audit:release` remains a complementary offline source and VSIX
audit. It is not GitHub-native secret scanning and it does not replace Gitleaks history scanning.
Fixture values in tests use generic markers or runtime-built pieces. One historical synthetic AWS
fixture from the starting history cannot be removed without rewriting shared history, so the
repository-local `.gitleaks.toml` allowlist matches only that exact test path and exact synthetic
pattern. It is tested by the local full-history scan and is not a broad source/test/docs exclusion.
No workflow excludes `src/**`, scripts, configuration, or documentation directories.

## Dependency Review versus npm audit

Dependency Review evaluates dependency changes introduced by a pull request and fails at
`moderate` or higher severity. It does not use a speculative license denylist and does not omit
development dependencies. `npm audit` evaluates the resolved lockfile tree against the npm
registry and is run for all dependencies and production-only dependencies in CI. The offline
`audit:release` script checks local manifest/lockfile consistency, credential-shaped patterns,
and packaged VSIX contents. These three checks answer different questions.

Dependency graph availability was confirmed through the repository API. If it is disabled later,
the Dependency Review check must be enabled in GitHub settings; the workflow must not be deleted
or weakened.

## Dependabot

Dependabot checks npm and GitHub Actions weekly, targets `main`, and permits at most five open PRs
per ecosystem. Development npm minor/patch updates and GitHub Actions minor/patch updates are
grouped. The npm ecosystem ignores `version-update:semver-major` for the wildcard dependency in
normal version-update PRs, so major dependency migrations are manual, planned tasks. This is the
official Dependabot `update-types` behavior: the constraint limits version updates and does not
disable security updates. No `security-updates: false`, automatic merge configuration, or custom
label that is absent from the repository is used.

The Node development engine and the extension-host type contract are intentionally separate. The
repository uses Node 24 for development (Node `>=22.12.0` is the supported engine floor), while
`@types/node` remains on the compatible 20.x line and `@types/vscode`/`engines.vscode` describe
the VS Code extension host. A major update to any of these contracts requires a separate
migration task with changelog, peer-dependency, and CI compatibility review.

## Scope boundary

The CI package artifact is validation-only and expires after seven days. It is not a GitHub
Release, Marketplace publication, or release credential flow. A future publish workflow would be
a separate manually reviewed change with a narrowly scoped credential and a tag-only trigger.
Task 12 also does not create the ruleset; the exact required checks and GitHub UI steps are in
[BRANCH-RULESET.md](BRANCH-RULESET.md).
