# Release readiness record (0.6.2, Task 12)

This is a point-in-time record for the Task 12 CI/security change. It does not create a release
or publish the Marketplace artifact. The extension version remains `0.6.2`.

## Repository baseline

- Starting commit: `64a4f626953f5e7b96d7b3154c955ab2308d2ea5`.
- Development policy: Node 24 preferred; Node `>=22.12.0` minimum; `.nvmrc` and `.node-version`
  both contain `24`.
- Production dependencies: zero.
- The independent release audit is offline and dependency-free; `npm audit` is a separate npm
  registry operation.
- Existing tests include real PowerShell wrapper processes and immediate filesystem read-backs;
  `vitest.config.mts` keeps `fileParallelism: false` to avoid the documented resource race.

## Task 12 controls

The `CI`, `CodeQL`, `Secret Scan`, and `Dependency Review` workflows are pinned to immutable
release commits and verified by `npm run verify:workflows`. Dependabot is configured for weekly npm
and GitHub Actions updates with no automatic merge. The CI package artifact has seven-day
retention and is not a release or Marketplace upload.

The current GitHub API metadata check reported a public repository, default branch `main`, an
available dependency graph, enabled native secret scanning/push protection, and no existing code
scanning alerts endpoint. Task 12 did not change repository settings; native availability was
recorded because the original brief said it was unavailable, and the independent scan remains
required regardless.

## Verification record

Latest local Task 12 verification used Node `v24.20.0` and the unchanged lockfile:

- `npm ci`, compile, lint, format check, workflow verifier, and offline audit: passed.
- Full test suite: `94` files / `856` tests passed three consecutive times with identical counts.
- `npm audit --audit-level=moderate`: `0 vulnerabilities`.
- `npm audit --omit=dev --audit-level=moderate`: `0 vulnerabilities`.
- Full-history Gitleaks scan: no leaks found with the narrow historical-fixture allowlist; source,
  test, docs, `.github`, and scripts working-tree scans were also clean.
- VSIX package: `ai-limit-ledger-0.6.2.vsix`, 127 entries, 1,083,038 bytes; package audit 13 pass,
  1 fixture-path warning, 0 fail. No CI/development files, credentials, or personal paths were
  included.

Complete the following on the same commit, Node version, and lockfile before merging:

```text
npm ci
npm run compile
npm run lint
npm run format:check
npm run verify:workflows
npm run audit:release
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
npm test
npm test
npm test
npm run package
npm run audit:release -- <generated-vsix>
```

Record the three identical test pass counts, both npm audit results, the verifier result, and the
VSIX audit result in the pull request. Confirm that the VSIX excludes workflows, tests, `.github`,
Dependabot configuration, Node version files, the verifier, credentials, personal paths, and CI
artifacts. Confirm runtime/provider source behavior is unchanged.

## Deferred work

After the PR is reviewed, configure the `main` ruleset using [BRANCH-RULESET.md](BRANCH-RULESET.md).
Release creation, Marketplace publishing, signing keys, and any future publish credentials remain
outside Task 12.
