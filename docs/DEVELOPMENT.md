# Development environment

This guide covers everything needed to build, debug, test, and package AI Limit Ledger from
source. It is written for a contributor who **also uses the published extension day to day** — so
the first thing it establishes is how the two stay separated.

For the release procedure itself see [`RELEASE-PROCESS.md`](RELEASE-PROCESS.md); for reverting a
bad release see [`ROLLBACK.md`](ROLLBACK.md).

---

## 1. Normal profile vs. Development Host

These are two different VS Code worlds, and mixing them is the single most common way to corrupt
your own usage data or leak a real credential into a debugging session.

|                  | Normal VS Code profile                                       | Extension Development Host                                      |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| What runs        | The Marketplace build, `fatihdumlupinar-dev.ai-limit-ledger` | The working tree's `out/` build, launched with F5               |
| Installed how    | Marketplace UI or `code --install-extension`                 | Not installed at all — loaded from `--extensionDevelopmentPath` |
| Settings         | Your real user/workspace settings                            | A throwaway user-data area under `.tmp/vscode-dev/`             |
| SecretStorage    | Your real provider credentials                               | Empty; a fresh store created per development area               |
| Other extensions | All of yours                                                 | None (`--disable-extensions`), in a separate `--extensions-dir` |

The rules that follow from that:

- **Use the Marketplace build for real usage.** Do not "install" your working tree into your normal
  profile to try it out — press F5 instead.
- **The Development Host never copies your SecretStorage.** It starts empty on purpose. If a
  provider needs credentials to exercise a code path, that path should be covered by a test with a
  fixture, not by signing a real account into the debug window.
- **Never sign a real provider account into the Development Host** to test a change. Use the test
  suite; every provider transport in this repository is testable without a live provider call.
- **The Development Host changes no global VS Code setting** and writes nothing outside
  `.tmp/vscode-dev/`, which is gitignored and never packaged.

### Removing the old local install

Earlier development builds were installed under the ad-hoc identity `local.ai-limit-ledger`. That
identity is obsolete — it is a _different extension_ to VS Code, so leaving it installed means two
copies of AI Limit Ledger fighting over the same status bar. Clean it out of your **normal**
profile once (these commands act on your real profile — run them yourself, deliberately):

```powershell
code --list-extensions --show-versions | Select-String "ai-limit-ledger"
code --uninstall-extension "local.ai-limit-ledger"
code --install-extension "fatihdumlupinar-dev.ai-limit-ledger"
code --list-extensions --show-versions | Select-String "ai-limit-ledger"
```

The expected end state of the last command is a single line:

```
fatihdumlupinar-dev.ai-limit-ledger@<published-version>
```

If `local.ai-limit-ledger` is not listed, nothing needs removing — skip the uninstall.

---

## 2. Toolchain

- **Node 24** is the preferred development version — it is what `.nvmrc` and `.node-version` pin
  and what CI and the release workflows use.
- **Node 22.12.0 is the minimum supported development runtime** (`package.json`'s
  `engines.node`). Node 20 is end-of-life; the test runner will not start on it.
- **npm 10+**, and always `npm ci` (lockfile-exact), never `npm install`.

With `nvm-windows`:

```powershell
nvm install 24
nvm use 24
node --version
```

With `nvm`/`fnm` on macOS or Linux, `nvm use` / `fnm use` reads `.nvmrc` directly.

None of this affects end users: the extension has zero production dependencies, targets the VS
Code extension host (`^1.95.0`), and someone installing the published build never needs Node.

---

## 3. First run

```powershell
git clone https://github.com/Fatih-Dumlupinar/ai-limit-ledger.git
cd ai-limit-ledger
npm ci
```

Open the folder in VS Code. It will offer the workspace's recommended extensions
(`.vscode/extensions.json`): ESLint, Prettier, and the official GitHub Actions extension. Accept
them — they are the three the repository's lint/format/workflow tooling actually integrates with.
Nothing else is recommended, and the published AI Limit Ledger extension is deliberately _not_
recommended here (see §1).

`.vscode/settings.json` is workspace-scoped only: it points TypeScript at the workspace SDK, wires
up ESLint/Prettier, fixes newline and whitespace handling, and hides `out/`, `node_modules/`, and
`.tmp/` from search. It sets no personal editor preference, no absolute path, no terminal/PATH
override, and no AI Limit Ledger provider setting.

---

## 4. Debugging with F5

`.vscode/launch.json` provides three profiles.

**`Run Extension — Clean Development Host` (the default, and the one to use).** It compiles first
(`preLaunchTask: Compile`), then opens a second VS Code window running the working tree's build
with:

- `--extensionDevelopmentPath=${workspaceFolder}` — load this repository as the extension
- `--user-data-dir=${workspaceFolder}/.tmp/vscode-dev/user-data` — isolated settings/state/secrets
- `--extensions-dir=${workspaceFolder}/.tmp/vscode-dev/extensions` — isolated extension area
- `--disable-extensions` — nothing but the extension under development

Every path is resolved through `${workspaceFolder}`, so the configuration is identical on Windows,
macOS, and Linux and contains no developer's home directory. Delete `.tmp/vscode-dev/` any time to
reset the Development Host to a completely clean state.

**`Run Extension — Current Workspace`** loads the same build into a host that keeps your normal
extensions and user data. Use it only when reproducing an interaction with another extension, and
be aware it _does_ touch your real profile state.

**`Debug Tests (vitest)`** runs the suite under the Node debugger so you can break inside a test.

### Breakpoints

Breakpoints work directly in the TypeScript under `src/` — `outFiles` points at
`${workspaceFolder}/out/**/*.js` and the compiler emits source maps for debugging. If a breakpoint
shows as unverified, the build is stale: run the **Compile** task (or start **Watch**) and reload
the Development Host window.

### Logs and output

In the Development Host, run **AI Limit Ledger: Show Logs** to open the extension's Output
Channel, and raise `aiLimitLedger.logging.level` to `debug` _in the Development Host's own
settings_ for verbose tracing. Logs never contain credential values — that is a hard constraint,
enforced by tests; if you see one, it is a bug worth reporting privately (see `SECURITY.md`).

---

## 5. Tasks

Everything below is available from **Terminal → Run Task**, and every task is a thin wrapper
around a `package.json` script — no task re-implements a command.

| Task                          | Script                                        |
| ----------------------------- | --------------------------------------------- |
| Install Dependencies          | `npm ci`                                      |
| Compile                       | `npm run compile`                             |
| Watch                         | `npm run watch`                               |
| Test                          | `npm test`                                    |
| Test Watch                    | `npm run test:watch`                          |
| Lint                          | `npm run lint`                                |
| Format Check                  | `npm run format:check`                        |
| Verify Workflows              | `npm run verify:workflows`                    |
| npm Audit                     | `npm audit --audit-level=moderate`            |
| npm Audit (production only)   | `npm audit --omit=dev --audit-level=moderate` |
| Release Audit                 | `npm run audit:release`                       |
| Package VSIX                  | `npm run package`                             |
| Release Audit (packaged VSIX) | `npm run audit:release:packaged`              |
| Full Local Check              | `npm run check:local`                         |

**Watch** and **Test Watch** are background tasks limited to one instance each, so repeated F5
presses reuse the running compiler instead of stacking up processes that never exit.

There is deliberately **no publish task and no release task**. Creating a release is a dispatched
GitHub Actions workflow behind a required review — never something an editor task can trigger.

### Running one test

```powershell
npx vitest run test/ReleaseCandidateWorkflow.test.ts
npx vitest run -t "rejects a v-prefixed version"
```

### Watching tests

```powershell
npm run test:watch
```

### Full local check

```powershell
npm run check:local
```

That is the same chain CI and the Release Candidate workflow run, in the same order: compile,
lint, format check, workflow verification, `npm audit`, production-only `npm audit`, source-tree
release audit, the full test suite, VSIX packaging, and finally the packaged-VSIX audit. Run it
before opening a pull request.

---

## 6. Building and smoke-testing a VSIX

```powershell
npm run package
npm run audit:release:packaged
```

`npm run package` compiles and produces `ai-limit-ledger-<version>.vsix` in the repository root
(gitignored). `audit:release:packaged` re-runs the release audit against that exact file: required
entries present; no `.github/`, `.vscode/`, `test/`, `scripts/`, `.tmp/`, `node_modules/`, source
maps, logs, old VSIX files, absolute user paths, or credential-shaped content; and a size budget.

To smoke-test the packaged artifact **without disturbing your normal profile**, install it into a
throwaway profile area rather than your real one:

```powershell
code --user-data-dir .tmp/vsix-smoke/user-data --extensions-dir .tmp/vsix-smoke/extensions --install-extension ai-limit-ledger-<version>.vsix
code --user-data-dir .tmp/vsix-smoke/user-data --extensions-dir .tmp/vsix-smoke/extensions
```

Delete `.tmp/vsix-smoke/` when finished. Never `code --install-extension` a locally built VSIX into
your normal profile — that is exactly how the obsolete `local.ai-limit-ledger` identity from §1
came to exist.

---

## 7. Testing without a real provider

The suite runs fully offline and never contacts a provider. When adding coverage:

- Use the existing fixtures (`test/claude/fixtures.ts`, `test/task92Fixtures.ts`) and the `vscode`
  test double (`test/vscode.ts`) rather than a live CLI or account.
- A "sensitive-looking" value in a fixture must be obviously fake — `C:\Users\fixture\...`,
  `ghp_` plus placeholder letters, `account@example.com`. The release audit scans for real-looking
  paths and credential shapes and fails the build on one.
- Never commit a real token, a real absolute home path, or a real account identifier, in source,
  tests, fixtures, or documentation.

Run the suite three consecutive times before submitting anything that touches source, runtime
behavior, or test infrastructure — identical pass counts each time, no timing-dependent failures.

---

## 8. Branch and pull request flow

1. Branch from `main` (`git switch -c <type>/<short-description>`). Never commit to `main`.
2. Keep the change focused; follow Conventional Commit prefixes (`feat:`, `fix:`, `docs:`,
   `build:`, `chore:`).
3. Run `npm run check:local`.
4. Push and open a pull request against `main`, filling out the template completely.
5. CI (quality matrix on Ubuntu and Windows, CodeQL, Secret Scan, Dependency Review) must pass.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for localization, provider-provenance, privacy, and
dependency rules that apply to every change.

---

## 9. Release flow (summary)

The full procedure lives in [`RELEASE-PROCESS.md`](RELEASE-PROCESS.md). The shape of it:

1. **Version bump on a branch** — `npm version <x.y.z> --no-git-tag-version`, add the `CHANGELOG.md`
   section and `docs/RELEASE-NOTES-<x.y.z>.md`, open a PR, merge to `main`.
2. **Release Candidate** — starts **automatically** when step 1's merge lands a changed version on
   `main`. A push that touches `package.json`/`package-lock.json` without changing the version
   produces a green run that explicitly skips and builds nothing; to retry after a skip, or to
   rebuild an expired candidate, dispatch the workflow manually from `main` with the exact version.
   Either way it rebuilds and re-audits the triggering `main` commit, runs the privacy audit over
   the source tree, over git history, and over the built package, then produces the VSIX, a SHA-256
   checksum, an SBOM, a release manifest, and a build-provenance attestation as one seven-day
   artifact. It creates no ref, no release, and uploads nothing anywhere.
3. **Manual Marketplace upload** — the repository owner downloads the candidate artifact, verifies
   the SHA-256, and uploads the VSIX **by hand** through the publisher management page. No
   workflow, token, or PAT is involved: there is no `VSCE_PAT` in this repository and no workflow
   is capable of publishing.
4. **Verify the listing** — confirm the new version is live at the Marketplace listing.
5. **Finalize Release** — dispatch the `Finalize Release` workflow with the version, the candidate
   run ID, the commit SHA, the exact listing URL, and the confirmation phrase
   `I_HAVE_VERIFIED_MARKETPLACE_<version>`. It runs behind the `production-release` environment's
   required review, re-verifies the artifact's hash and identity, then creates the annotated
   `v<version>` ref and a pre-release GitHub Release with the candidate's assets — idempotently,
   never force-moving a ref and never overwriting an existing asset.

Rollback is covered in [`ROLLBACK.md`](ROLLBACK.md).

---

## 10. Rules about user data

Non-negotiable, and enforced by tests and the release audit:

- Development never reads, copies, or migrates a real user's SecretStorage, credentials, or
  provider cache into a debug session, a fixture, or a log.
- Nothing written by a development session escapes `.tmp/`, which is gitignored and excluded from
  the VSIX.
- No absolute user path, email address, account ID, or other personal identifier appears in
  source, tests, fixtures, documentation, or a packaged artifact. `npm run audit:privacy` checks
  this for you across the tracked tree, `-- --history` across every reachable commit, and
  `-- --vsix <file>` across a built package; all three gate the Release Candidate workflow. It
  reports a pattern id, a location, a mask, and a fingerprint — never the matched value. See
  [`PRIVACY-AUDIT.md`](PRIVACY-AUDIT.md).
- A fixture needing a sensitive-looking value must put the synthetic marker in the part that
  matters. For a path that is the **account segment**: `C:\Users\fixture\...` and `/home/test/...`
  are recognised as fixtures, but a realistic account name is a finding no matter what the rest of
  the path says. If a fixture genuinely cannot be made to look synthetic, add a narrow entry to
  `scripts/privacy-allowlist.json` naming one pattern id, one exact path, and a written reason —
  never the value itself.
- The extension makes no model/inference call to read usage, and adds no telemetry — see
  [`PRIVACY.md`](../PRIVACY.md).
