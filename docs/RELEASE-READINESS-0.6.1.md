# Release readiness — 0.6.1 (Task 10)

## Version consistency

| Location                                                              | Value                         |
| --------------------------------------------------------------------- | ----------------------------- |
| `package.json` `version`                                              | `0.6.1`                       |
| `package-lock.json` root `version`                                    | `0.6.1`                       |
| `package-lock.json` `packages[""].version`                            | `0.6.1`                       |
| `package-lock.json` `lockfileVersion` (format, not project version)   | `3` (unchanged)               |
| VSIX manifest (`extension/package.json` inside the `.vsix`) `version` | `0.6.1`                       |
| Installed extension                                                   | `local.ai-limit-ledger@0.6.1` |
| CHANGELOG.md top entry                                                | `## 0.6.1`                    |

All verified equal by `test/VersionManifestConsistency.test.ts` and
`scripts/release-audit.mjs`'s `version-consistency` / `vsix-manifest-version` checks.

## Test suite

- Baseline (before any Task 10 change, same 0.6.0 code): **81 files / 712 tests**, 3 consecutive
  `vitest run` passes, 0 failures, no `ENOTEMPTY`.
- After Task 10 changes (67 new tests across 4 new files): **85 files / 779 tests**, 3
  consecutive `vitest run` passes on the identical final tree, 0 failures, no `ENOTEMPTY`, no
  test-count drift between runs.
- New test files: `test/ReleaseAudit.test.ts` (41), `test/VersionManifestConsistency.test.ts`
  (9), `test/SupplyChainLockfile.test.ts` (7), `test/FilesystemTempIsolation.test.ts` (10).

## Build / lint / format / audit chain (in order, on the final tree)

| Step                                                  | Result                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm ci`                                              | Clean install from lockfile, 5 known dev-only audit findings (unchanged) |
| `npm run compile`                                     | Clean, 0 errors                                                          |
| `npm run lint`                                        | Clean, 0 errors, 0 warnings                                              |
| `npm run format:check`                                | Clean, all files match Prettier style                                    |
| `npm run audit:release` (source tree)                 | 8 checks: 6 pass, 2 warn (both fixture-marked, reviewed), 0 fail         |
| `npm test` × 3                                        | 85/779 all three times, stable                                           |
| `npm run package`                                     | `ai-limit-ledger-0.6.1.vsix`, 125 files, 1,066,009 bytes                 |
| `npm run audit:release -- ai-limit-ledger-0.6.1.vsix` | 14 checks: 12 pass, 2 warn (fixture-marked), 0 fail                      |

## VSIX artifact

- Path: `ai-limit-ledger-0.6.1.vsix` (repository root)
- Size: 1,066,009 bytes (~1.02 MB), within the 5 MB budget in `scripts/release-audit.mjs`
- SHA-256: `9f44c2007c94ac5f386d76d070841e8619d6191065a612cbe3aa3d7c9e3ba3b5`
- File count: 125 (down from 233 before excluding `.map`/scratch files — see
  `docs/SECURITY-AUDIT-0.6.1.md`)
- All required entries present (`package.json`, `readme.md`, `changelog.md`, `LICENSE.txt`,
  `SECURITY.md`, `PRIVACY.md`, `SUPPORT.md`, both NLS catalogs, `out/extension.js`)
- No denylisted entries (`.git`, `node_modules`, `.map`, `.env`, logs, scratch JSON, old VSIX)
- No absolute user paths in any entry name or scanned text entry
- No credential-shaped pattern in any scanned text entry
- Packaged manifest version matches `package.json` (`0.6.1`)

## Fixed vs. accepted/deferred risk

**Fixed:**

- `SharedSnapshotStore` Windows temp-file race (`ENOENT`/`EPERM` under concurrent same-process
  writes) — see `docs/SECURITY-AUDIT-0.6.1.md` §1.
- VSIX source-map and local-scratch-file bloat — see `docs/SECURITY-AUDIT-0.6.1.md` §2–3.

**Accepted / deferred** (see `docs/DEPENDENCY-RISK-REGISTER.md` for full detail):

- `npm audit`: 5 dev-only findings in the `vitest`/`vite`/`esbuild` chain. Not runtime-reachable,
  not packaged. Fix requires a semver-major `vitest` upgrade — deferred, re-evaluate before the
  next release or if a non-major fix ships.
- `EBADENGINE` warnings from 3 transitive `@vscode/vsce` build-tool dependencies wanting Node
  ≥20.18.1/≥22 while local dev used 20.10.0 — cosmetic warning only, `npm ci`/`npm run package`
  both succeed; documented in `README.md`'s new "Development requirements" section.

**False positives triaged, not code changes:** `scripts/release-audit.mjs`'s
`absolute-user-paths` and `credential-patterns` checks each report a small number of
fixture/placeholder matches inside test files and this audit's own documentation (e.g.
`C:\Users\fixture\...`, `ghp_abcdefgh...` fixture literals) — all correctly categorized as
`likely-fixture` and do not fail the build.

## Task 11 (public GitHub) blockers

- `package.json` has no `repository`, `bugs`, or `homepage` field yet — required before a public
  repo push so the Marketplace listing links back correctly. Not added in this task (would be
  guessing a URL that doesn't exist yet); flagged for Task 11.
- No `.git` history exists in this checkout (confirmed via `git log` returning "does not have
  any commits yet"), so Task 11 will be an initial commit/push, not a history migration.
- `publisher` in `package.json` is `local` — `PUBLISHING.md` already documents this must change
  only once a real Marketplace publisher ID exists (unchanged by this task, correctly deferred).

## Task 12 (CI/CD) blockers

- No `.github/` directory exists. `docs/CI-SECURITY-DESIGN.md` is the design Task 12 should
  implement; no workflow file was created in this task per the Task 10 brief.
- Branch protection, required-status-check enforcement, and Dependabot config are all Task 12
  configuration, not files in this repository.

## Task 13 (Marketplace) blockers

- `PUBLISHING.md` step 4 ("add Marketplace screenshots for normal, compact, warning, critical,
  unavailable, tooltip, and details-panel states") is still open — unrelated to security/release
  auditing, carried over unchanged from before this task.
- Marketplace publisher creation and `vsce login`/`vsce publish` are explicitly out of scope for
  Task 10 (see "Uygulama sınırları") and were not performed.

## What this task deliberately did not touch

- No `.git` commit, tag, or push was made (verified below).
- No user settings, provider credentials, or provider sessions were read, written, or changed.
- No real provider API/model call, login flow, or `/usage`-consuming command was run.
- No production dependency was added.
- No major dependency version was upgraded; `npm audit fix --force` was not run.
