# Changelog

## [Unreleased]

- **Task 14.2 — Automatic release candidates and a permanent privacy audit.** No provider, runtime,
  status bar, or dashboard behavior change, and no version bump: this task changes the release
  machinery and adds a repository audit tool. The Marketplace upload and the GitHub Release both
  stay manual and owner-approved.
  - `.github/workflows/release-candidate.yml` now also runs automatically on a push to `main` that
    touches `package.json` or `package-lock.json`, alongside the existing manual dispatch. Its
    trigger set is exactly those two events, asserted as a closed list — no `pull_request`, no
    `schedule`, and no `workflow_run`/`repository_dispatch`/`workflow_call` chaining. A candidate
    build holds `contents: read`, creates no ref and no release, and publishes nothing, so
    automating it costs no privilege.
  - A separate `resolve` job decides whether a candidate is due and the `build` job runs only when
    it says so, which makes packaging structurally unreachable on a non-bump push. The previous
    version is read with `git show ${BEFORE_SHA}:package.json`, where `BEFORE_SHA` arrives from
    `github.event.before` through `env:` and must match `^[0-9a-f]{40}$` before it is used as a Git
    object reference. A manifest change that does not change the version, a zero or unavailable
    previous commit, or an unreadable previous `package.json` produces a **successful, explicitly
    skipped run that builds nothing**; disagreeing manifests, a missing changelog section or
    release-notes file, or an existing `v<version>` ref fail the run instead.
  - Added `scripts/privacy-audit.mjs` and `npm run audit:privacy` — a permanent, dependency-free,
    offline, read-only audit for personal and machine-identifying data across the tracked source
    tree, all reachable git history (`--history`), and a packaged VSIX (`--vsix`), with an optional
    redacted JSON report (`--json`). It complements rather than replaces GitHub secret scanning and
    the Gitleaks job, which answer the narrower question of whether a revocable credential exists.
  - The audit runs as a fail-closed gate in the candidate workflow at three points: source tree and
    history before packaging, and the built VSIX before the artifact upload, SBOM, release manifest,
    and provenance attestation — so a package carrying personal data can never become a signed,
    attested, downloadable artifact.
  - The audit never prints a matched value anywhere. A match is fingerprinted, masked to its
    structural shape, and classified, and the raw value is discarded; findings carry no field that
    could hold it. It refuses credential stores, `.env` contents, and raw provider payloads, refuses
    to scan outside the repository or follow a symlink escaping its root, rejects a VSIX entry name
    that would escape the extraction root, handles binary/invalid-UTF-8/oversized input as
    documented and reported skips, reads PNG metadata chunks structurally instead of scanning pixel
    data as text, and exits non-zero on its own failure rather than passing silently.
  - Findings are separated into intentional public identity (the owner handle, the Marketplace
    publisher id, the GitHub-issued noreply commit address, the canonical project URLs), safe
    fixtures, and things a human must review — so a clean report distinguishes a genuinely examined
    repository from an unexamined one. Suppressions live in `scripts/privacy-allowlist.json` and
    must name one known pattern id, one exact non-wildcard path, and a written reason; an entry can
    never contain the value it excuses.
  - Extracted the dependency-free ZIP reader into `scripts/lib/zip-reader.mjs` and the pattern,
    masking, fingerprint, and classification primitives into `scripts/lib/privacy-patterns.mjs`, so
    the release audit and the privacy audit share one implementation instead of two that drift.
    `scripts/release-audit.mjs` re-exports the reader unchanged for existing importers.
  - `scripts/release-audit.mjs` now also rejects, in a packaged VSIX: an entry name that would
    escape the extraction root, and personal/machine data in entry names or text content
    (user-profile paths, UNC shares, MAC addresses, source maps carrying absolute build paths, VS
    Code profile paths). Its denylist additionally covers privacy-audit reports, log files, local
    VS Code profile state, `.env`/`.npmrc`/`.netrc`, and private key material.
  - `.github/workflows/finalize-release.yml` accepts a candidate built by either `push` or
    `workflow_dispatch` — an explicit two-value allowlist, every other event still refused — and now
    additionally requires the candidate run's head branch to be `main`, a check that did not exist
    before. It remains `workflow_dispatch`-only, `production-release`-gated, with the exact
    Marketplace URL, the version-scoped confirmation phrase, run-id/commit-SHA verification,
    artifact and checksum re-verification, and idempotent tag/release creation that never
    force-moves a tag or overwrites an asset.
  - Artifact retention is now a flat seven days for every workflow, replacing the 14-30 day band
    Task 14 reserved for the release candidate. Candidates are now produced automatically, the
    manual upload plus finalize is a same-week activity, and an expired candidate is rebuilt
    deterministically from the same commit — so a month-long downloadable build artifact was
    retained risk with no matching benefit.
  - `fetch-depth: 0` is now permitted in `release-candidate.yml`, joining `secret-scan.yml` and
    `finalize-release.yml`. Both of its uses structurally require full history: the `--history`
    privacy gate walks every reachable commit, and the version comparison reads `package.json` at
    the previous `main` tip. A shallow clone would make both silently vacuous.
  - Extended `scripts/verify-workflows.mjs` to enforce all of the above structurally: the exact
    trigger set, `main`-only branch scope, a path filter that may not widen beyond the two version
    manifests, the resolve/build separation and its gate, validated `github.event.before` handling,
    the genuine version-change check, the three privacy gates and their ordering relative to
    packaging and to the artifact/SBOM/manifest/attestation steps, the seven-day retention band, a
    concurrency group that is commit-scoped and never cancels in progress, and the absence of any
    chaining trigger or workflow-dispatch call.
  - Added `docs/PRIVACY-AUDIT.md` and extended `docs/RELEASE-PROCESS.md`, `docs/DEVELOPMENT.md`,
    `PUBLISHING.md`, `SECURITY.md`, and `PRIVACY.md` to cover when a candidate starts, when it
    skips, how to retry manually, why the Marketplace upload and Finalize Release stay manual, what
    the privacy audit scans and deliberately does not, how reports are redacted, how it differs from
    secret scanning, the difference between public identity and leaked personal data, and why a
    history finding does not trigger an automatic rewrite.

## 0.7.1

- **Task 14.1 — Reusable release process and complete development environment.** No provider,
  runtime, status bar, or dashboard behavior change. The Marketplace upload stays manual and
  owner-performed; GitHub Actions automates only build, audit, and the post-verification GitHub
  Release.
  - Generalized `.github/workflows/release-candidate.yml` and
    `.github/workflows/finalize-release.yml` off their hardcoded `0.7.0` constants so they are
    reusable for every future version. Both keep every existing hardening property:
    `workflow_dispatch`-only, `main`-only, exact `origin/main` commit verification, minimum
    permissions, SHA-pinned actions, `persist-credentials: false`, `npm ci`, the full
    compile/lint/format/workflow-verify/audit/test chain, VSIX packaging with a packaged-VSIX
    audit, checksum, SBOM, release manifest, provenance attestation, and bounded artifact
    retention.
  - The `version` dispatch input is validated against a single anchored grammar,
    `^[0-9]+\.[0-9]+\.[0-9]+$`, in the first step that touches it, and only re-exported once it
    passes. A `v` prefix, a two-part `0.7`, a prerelease (`-beta`) or build-metadata (`+build`)
    suffix, `latest`/`main`, an empty value, or a shell metacharacter fails the run before the
    value can reach a file path, a jq filter, an artifact name, or a ref name. Every dispatch
    input arrives through `env:` and is never interpolated into a `run:` body.
  - The Marketplace confirmation phrase is now derived from the validated version
    (`I_HAVE_VERIFIED_MARKETPLACE_<version>`) rather than frozen to one release, so a previous
    release's confirmation can never finalize the next version.
  - `Release Candidate` now refuses to build for a version whose release ref already exists, and
    requires the `CHANGELOG.md` section for the version, a non-empty
    `docs/RELEASE-NOTES-<version>.md`, and a preserved `[Unreleased]` section before packaging.
    It still creates no ref, no release, and no publish of any kind.
  - `Finalize Release` now additionally verifies that the candidate artifact contains exactly the
    five expected files and nothing else, alongside the existing candidate-run, hash, manifest,
    publisher, extension-ID, and `main`-ancestry verification. Tag/release handling remains
    idempotent and fail-closed: an existing ref on the right commit is untouched, an existing ref
    on any other commit aborts the run, and no asset is ever overwritten.
  - Extended `scripts/verify-workflows.mjs`: the exact strict-SemVer pattern must be present in
    both release workflows, a literal version constant in a release workflow is now an error, the
    confirmation phrase must be derived rather than hardcoded, `contents: write` / `actions: read`
    are pinned to the finalize job and `id-token: write` / `attestations: write` to the candidate
    build job, every checkout must set `persist-credentials: false`, and `VSCE_PAT`, Azure DevOps /
    Marketplace / OpenVSX tokens, `vsce login`, `--oidc`, and Azure federated-login references are
    forbidden in every workflow.
  - Added a complete VS Code development environment: `.vscode/launch.json` gains
    **Run Extension — Clean Development Host** (isolated `--user-data-dir` and `--extensions-dir`
    under the gitignored `.tmp/vscode-dev/`, resolved through `${workspaceFolder}`), plus a
    current-workspace profile and a vitest debug profile; `.vscode/tasks.json` adds twelve
    npm-script-backed tasks including `Full Local Check` and no publish/release task;
    `.vscode/extensions.json` recommends only ESLint, Prettier, and the official GitHub Actions
    extension; `.vscode/settings.json` adds workspace-scoped settings only.
  - Added the `test:watch`, `audit:release:packaged`, and `check:local` npm scripts, and extended
    `scripts/release-audit.mjs` with development-environment policy checks: launch/tasks/settings/
    recommendation validation, no absolute user path or credential-shaped content in any editor
    configuration, `.tmp/` gitignored, and `.vscode/**` plus `.tmp/**` excluded from the VSIX.
  - Added `docs/DEVELOPMENT.md` and linked it from `README.md`, `README.tr.md`, and
    `CONTRIBUTING.md`.
  - Corrected the now-stale "not yet published to the Marketplace / install from source" guidance
    in `README.md` and `README.tr.md`, which became wrong when 0.7.0 went live. Both READMEs now
    lead with the Marketplace UI (`@id:fatihdumlupinar-dev.ai-limit-ledger`) and CLI
    (`code --install-extension "fatihdumlupinar-dev.ai-limit-ledger"`) install paths, keep
    build-from-source as a contributor path, and preserve every non-affiliation, privacy, provider
    limitation, and preview disclaimer.

## 0.7.0

- **Task 14 — Secure release system and first Marketplace release preparation.** First Marketplace
  version. No provider/runtime behavior change; this task adds a manual-approval release pipeline
  and finalizes the listing prepared in Task 13/13.1.
  - Multi-provider usage monitoring for Codex, Claude Code, GitHub Copilot, and Grok, presented
    through a Rich (Webview) or Safe Native dashboard with live EN/TR localization and
    privacy-first, provider-scoped usage insights. Claude session metrics reflect the most recently
    observed CLI session, not an account-wide total; GitHub Copilot allowance may be unavailable on
    an organization-managed account; Grok Free accounts may not expose a numeric usage percentage;
    experimental provider endpoints may change without notice; and the extension never makes a
    model/inference call to read usage — only documented account/usage endpoints or local files.
    Units are never combined across providers.
  - Added `.github/workflows/release-candidate.yml`: a `workflow_dispatch`-only, read-only-permissions
    workflow that rebuilds and audits the exact `main` commit, packages the VSIX, generates a
    SHA-256 checksum, a CycloneDX-shaped SBOM (`scripts/generate-sbom.mjs`), a release manifest
    (`scripts/generate-release-manifest.mjs`), and (on this public repository) a build-provenance
    attestation, then uploads a short-retention candidate artifact. It never tags, releases, or
    publishes anything.
  - Added `.github/workflows/finalize-release.yml`: a `workflow_dispatch`-only workflow gated behind
    the `production-release` GitHub Environment (manual approval, configured by the repository
    owner — not created by this task) and a strict input allowlist, including an exact Marketplace
    URL and a literal `I_HAVE_VERIFIED_MARKETPLACE_0.7.0` confirmation phrase. It re-verifies the
    candidate artifact's hash and identity, confirms the candidate commit is part of `main`'s
    history, then creates an immutable `v0.7.0` tag and a preview GitHub Release — idempotently, and
    without force-moving a tag or overwriting an existing release asset. It never uploads to the
    Marketplace and never runs `vsce publish`.
  - Neither workflow creates, stores, or references a Marketplace PAT, `VSCE_PAT`, or any other
    publishing credential — the first Marketplace upload is a manual VSIX upload performed by the
    project owner, exactly as documented in `docs/RELEASE-PROCESS.md`.
  - Extended `scripts/verify-workflows.mjs` for both new workflows: exclusive `workflow_dispatch`
    trigger, per-job write-permission allowlists (previously only checked at the workflow level),
    a 14–30 day retention band for the release-candidate artifact (versus 1–7 days elsewhere),
    `fetch-depth: 0` allowed only for the secret scanner and the finalize workflow's ancestry check,
    and a narrowed publish/release-operation ban so only `finalize-release.yml` may reference
    `gh release` or the Marketplace listing URL (`vsce publish`/`npm publish` remain forbidden
    everywhere, with no exception).
  - Added `docs/RELEASE-PROCESS.md`, `docs/FIRST-MARKETPLACE-RELEASE-0.7.0.md`,
    `docs/INSTALLATION-MIGRATION-0.7.0.md`, `docs/ROLLBACK.md`, and `docs/RELEASE-NOTES-0.7.0.md`;
    updated `PUBLISHING.md`, `docs/MARKETPLACE-PREFLIGHT.md`, `docs/MARKETPLACE-LISTING.md`, and
    `SECURITY.md` for the 0.7.0 identity/version and the new release system.
  - Confirms the Task 13.1 decision that Marketplace screenshots remain optional and are not a
    release blocker, and that the manifest keeps `"preview": true` for this first release (the
    Standard Marketplace channel is used; `vsce --pre-release` is not).
- **Task 13.1 — Marketplace screenshots are optional.** Documentation-only change; no runtime,
  version, or publish-state change. Confirmed against the current official VS Code
  publishing/extension-manifest documentation that screenshots have no manifest field and are not
  a Marketplace publishing requirement. Removed "pending"/"required"/"open blocker before Task 14"
  language for the five planned screenshot files from `README.md`, `README.tr.md`,
  `docs/MARKETPLACE-LISTING.md`, `docs/MARKETPLACE-ASSET-INVENTORY.md`,
  `docs/MARKETPLACE-PREFLIGHT.md`, and `docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md`; the listing is
  publishable from README content alone with no screenshots. `scripts/release-audit.mjs`'s
  `marketplace-screenshots` check now reports `pass` (not `warn`) when no screenshots are present,
  and a new `marketplace-readme-screenshot-links` check guards against a README referencing a
  screenshot file that does not exist. Marketplace screenshots are optional and may be added in a
  later documentation-only update, using only the real extension UI and synthetic fixture data.
- **Task 13 — VS Code Marketplace listing and package preparation.** No provider/runtime behavior
  change. `package.json`'s `publisher` changed from `local` to the real Marketplace publisher ID
  `fatihdumlupinar-dev` (permanent extension ID: `fatihdumlupinar-dev.ai-limit-ledger`), and
  `preview: true` was added for the first Marketplace release. Keywords were expanded to 16
  (within the 30 max) covering usage/quota/provider-discovery terms; `categories` remains
  `Other`/`Visualization`.
- Restructured `README.md`/`README.tr.md` with a Marketplace-oriented layout: preview-status
  callout, a "Why AI Limit Ledger?" section, explicit "what this extension reads" / "does not read
  or store" sections, a Commands reference, a Support section, and a dedicated non-affiliation
  notice (Microsoft, GitHub, OpenAI, Anthropic, xAI). English and Turkish carry the same semantics.
- Added `docs/MARKETPLACE-LISTING.md`, `docs/MARKETPLACE-ASSET-INVENTORY.md`,
  `docs/MARKETPLACE-PREFLIGHT.md`, and `docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md`. Marketplace
  screenshots are not yet produced — this non-interactive environment has no display/GUI automation
  available to capture them, so no mockup or placeholder image was committed; the runbook documents
  the manual, synthetic-data-only capture procedure for a person with a desktop VS Code install.
- Extended `scripts/release-audit.mjs` with Marketplace-specific checks: exact publisher/extension
  ID/version match, placeholder-publisher rejection, category allowlist, keyword count/duplicate
  checks, README section/non-affiliation presence, HTTPS-only image links, no local/absolute
  paths, no publish-workflow files, and no `vsce publish` invocation in the source tree.
- Added `.vscodeignore` entries excluding the new Marketplace-preparation docs and
  `assets/marketplace/**` from the packaged VSIX (screenshots are a repository/listing asset, not a
  runtime asset; `vsce`'s relative-image-to-GitHub-URL rewrite means the Marketplace page can still
  render them without shipping them in the package).
- Added 4 new test files / 131 new tests (publisher/extension identity, category/keyword policy,
  README section/parity/non-affiliation/overstated-claim/image-link checks, icon and screenshot
  asset policy, VSIX denylist and packaged-identity regressions) — the suite now contains 98 files
  / 990 tests, verified stable across three consecutive full runs on the same final tree under
  Node 24.20.0.
- Added secure GitHub Actions CI for Ubuntu/Windows quality checks, CodeQL, independent full-history
  Gitleaks scanning with checksum verification, moderate-threshold Dependency Review, and weekly
  Dependabot npm/Actions updates.
- Pinned every external Action to a full release commit SHA and added the dependency-free
  `verify:workflows` policy verifier plus regression tests. Release and Marketplace publishing are
  intentionally outside Task 12.
- Clarified the Claude credential boundary between the official status-line integration and the separate, explicit-consent experimental OAuth transport.
- Corrected Grok ACP transport and `x.ai/billing` method provenance, including the experimental, opt-in CLI-proxy fallback.
- Scoped the Codex token statement to the Codex provider and removed the repeated affiliation warning.
- Recorded the current GitHub-native secret-scanning and push-protection availability for Task 12 planning.
- Restored `@types/node` to the Node 20.x extension-host compatibility range after the incorrectly merged
  Dependabot PR #5. PR #5 did not cause a runtime/provider error, but it introduced unnecessary extension-host
  type compatibility risk; `@types/node` describes the type contract and does not automatically follow the
  Node version used on a development machine. The PR #2 `@typescript-eslint` updates remain unchanged.
- Configured Dependabot to ignore npm semver-major version updates in normal version-update PRs while keeping
  minor/patch grouping and security updates available. Major dependency migrations are manual, planned tasks
  evaluated against changelog impact, peer dependencies, and CI compatibility.

## 0.6.2

- **Task 10.1 — Supported Node LTS & Vitest Security Debt Remediation.** No user-facing feature changes; runtime provider behavior is unchanged. This closes out Task 10.
- Removed the end-of-life Node 20 development recommendation. `package.json` now declares `engines.node: ">=22.12.0"`; `.nvmrc`/`.node-version` pin the preferred development line to Node 24 (current LTS). Node is a development/test/audit/package-time requirement only — the packaged extension still targets VS Code `^1.95.0` at runtime and requires no particular Node version (or Node at all) for end users.
- Upgraded `vitest` from the vulnerable `2.1.9` to the latest stable `4.1.11` (no beta/RC/prerelease), which transitively resolved `vite` and `@vitest/mocker` to non-vulnerable versions and removed `vite-node` entirely (replaced upstream by Vite's own Module Runner). All 5 previously-deferred `npm audit` findings (`vitest`, `vite`, `esbuild`, `vite-node`, `@vitest/mocker`) are now closed: `npm audit --json` and `npm audit --omit=dev --json` both report zero vulnerabilities. `npm audit fix --force` was not used; the upgrade was applied explicitly and verified with three consecutive full test runs.
- This project's config and tests never used any of the Vitest-4-removed/renamed options (`poolOptions`, `singleThread`/`singleFork`, `workspace`, `coverage.all`/`coverage.extensions`/`coverage.ignoreEmptyLines`). Renamed `vitest.config.ts` to `vitest.config.mts` to resolve a new Vite 8 config-loader ESM/CommonJS ambiguity warning; behavior is unchanged. **One real migration fix was needed:** Vitest 4's more aggressive default cross-file parallelism intermittently ran the real-`powershell.exe`-spawning `ClaudeWrapperRunner` suite concurrently with the real-filesystem `ClaudeDiagnostics`/`ClaudeDisable` suites, occasionally starving CPU/disk I/O enough to flip an otherwise fully-deterministic (fixed fake-clock) assertion — a race that did not reproduce under Vitest 2's scheduling. Root-caused (not skipped, not timeout-inflated, not assertion-relaxed) and fixed by setting `test.fileParallelism: false`, verified flake-free across 6+ repeated full runs after the change.
- Corrected an imprecise claim in the 0.6.1 documentation that could be read as "`npm audit` is offline": it is not — it queries the npm registry for known advisories and requires network access for a current result. `npm run audit:release` (`scripts/release-audit.mjs`) remains the separate, genuinely offline, dependency-free local/VSIX check. The 0.6.1 documents are left as originally published with explicit errata notes added, not silently rewritten; README/SECURITY/PUBLISHING now state the distinction directly.
- `scripts/release-audit.mjs` was already excluded from the packaged VSIX in 0.6.1 (via `.vscodeignore`'s `scripts/**`); this is now also enforced by an explicit VSIX-denylist pattern (so a future accidental removal of that ignore rule is caught by the post-package audit) and covered by dedicated regression tests, rather than relying only on the ignore-file rule.
- Added 33 new tests (Node development-policy checks, Vitest 2→4 migration/lockfile verification, npm-audit-documentation accuracy, and release-audit-script packaging regressions) — the suite now contains 89 files / 812 tests, verified stable across three consecutive full runs on the same final tree under Node 24.20.0.

## 0.6.1

- **Task 10 — Security, Dependency and Release Readiness Audit.** No user-facing feature changes; this release hardens the 0.6.0 codebase and its packaging/release process.
- **Fixed a real Windows temp-file race in `SharedSnapshotStore`.** Concurrent writes from the same process (e.g. two providers refreshing close together) could generate colliding temp filenames when `Date.now()` landed in the same millisecond, and the subsequent atomic rename could then intermittently fail with `EPERM`/`ENOTEMPTY` under Windows file-locking contention. Temp filenames now include a random suffix, and the atomic rename uses a small bounded retry with backoff for the two known-transient Windows error codes only — never a broad retry, and never silently swallowed.
- Excluded compiled `**/*.map` source maps (107 files, ~46% of the previous package) and local audit/dependency-tree scratch artifacts from the packaged VSIX via `.vscodeignore`; they carried no runtime debugging value once installed (their `sources` point at `../../src/*.ts`, which is never shipped) and only added bytes and surface area.
- Added `scripts/release-audit.mjs` (`npm run audit:release`) — a dependency-free, offline, cross-platform local audit covering manifest/lockfile version consistency, absolute-user-path and credential-shaped pattern scanning (with fixture/placeholder triage so test fixtures don't false-positive), supply-chain source/lifecycle-script inspection, and — when pointed at a built `.vsix` — a pure-Node ZIP reader that checks required files, a denylist, VSIX size budget, and the packaged manifest version, without ever printing a matched secret value.
- Reviewed `npm audit`: all 5 findings (`vitest`, `vite`, `esbuild`, `vite-node`, `@vitest/mocker`) are transitive, dev/test-only dependencies with zero production dependencies and are never packaged into the VSIX or reachable from the extension host at runtime; no safe non-major fix exists, so the major `vitest` 2→4 upgrade is deferred and tracked in `docs/DEPENDENCY-RISK-REGISTER.md` rather than applied automatically.
- Added `docs/SECURITY-AUDIT-0.6.1.md`, `docs/DEPENDENCY-RISK-REGISTER.md`, `docs/RELEASE-READINESS-0.6.1.md`, and `docs/CI-SECURITY-DESIGN.md` (a design document only — no GitHub Actions workflow is added in this release).
- Added 67 new tests (release-audit ZIP reader and pattern triage, version/lockfile consistency, supply-chain lockfile hygiene, and filesystem/temp-isolation regressions including the race above) — the suite now contains 779 passing tests across 85 files, verified stable across three consecutive full runs on the same final tree.

## 0.6.0

- Added a shared typed Provider Usage Insights model with explicit source provenance, freshness, safe numeric/date validation, provider-scoped account/session metrics, and bounded daily trends.
- Added official Codex account and usage insights with 30-day normalization, latest-14-day display, duplicate-date merging, reset-credit expiration dates, and no extra App Server methods.
- Expanded Claude’s allowlisted status-line snapshot to explicit context/cache/cost/duration/line/effort/thinking/output-style fields, bumped generated wrapper schema to 2, and kept official session data separate from experimental OAuth account limits.
- Added Copilot AI-credit, allowance, reset, model, organization, endpoint-plan, and separate legacy quota insights with no fabricated denominator; added official ACP-first Grok provenance and safe null product-breakdown handling.
- Added `aiLimitLedger.dashboard.insightsMode` (`summary`, `detailed`, `hidden`) with live Rich/Safe rendering, localized English/Turkish labels, source provenance, and a three-line detailed status-bar tooltip cap.
- Added 53 focused safety/provider/settings/UI tests; the suite now contains 712 passing tests across 81 files.

## 0.5.8

- Completed typed English/Turkish localization across Rich and Safe Native dashboard presentation, provider links, settings enum labels, semantic statuses, guidance, source badges, and provider-count pluralization.
- Added direction-aware past/future/deadline/snapshot timestamp roles, generic unknown-window labels, typed badge deduplication, and CSP-safe static SVG icon slots that survive action state transitions.
- Added 30 regression tests covering localization parity, raw-message redaction, time semantics, badge ordering/deduplication, and SVG visibility.

## 0.5.7

- Added a typed English/Turkish runtime localization service with `auto` locale resolution, safe fallback/interpolation, and deterministic date/relative-time formatting.
- Connected Rich/Safe Dashboards, status bar, tooltips, notifications, pickers, and action feedback to live language changes rendered from cached snapshots without provider refreshes or network calls.
- Added VS Code manifest localization catalogs, expanded regression coverage, and documented the platform boundary between runtime UI language and Command Palette/Settings contribution language.

## 0.5.6

- Added a typed, versioned central settings registry/service with safe normalization, provider alias/deduplication diagnostics, machine-scope enforcement, live reconciliation, and idempotent legacy migration.
- Added Dashboard/status-bar visibility and order controls, remaining/used/both display modes, English/Turkish language selection, time formatting, tooltip density, thresholds, notification/logging levels, bounded cache policy, and related Command Palette actions.
- Separated experimental Copilot/Grok consent metadata from enablement, added redacted effective-settings support output, updated refresh floors, and kept all existing backoff/single-flight protections.

## 0.5.5

- Centralized official provider usage, billing, settings, installation, and documentation links in a read-only exact-host registry.
- Added runtime link validation, structured link-open results, correlation-safe logging, Safe Dashboard link output, and source coverage tests.
- Updated Claude, Copilot, and Grok labels/routes; Copilot CLI is optional and Grok usage is documented as `/usage` inside Grok Build.

## 0.5.4

- Added a native Safe Dashboard backed by a read-only `TextDocumentContentProvider` at `ai-limit-ledger:/dashboard.md`; it uses the normal VS Code text editor and never creates a Webview or Service Worker.
- Added Auto / Rich Webview / Safe Native dashboard modes and explicit Open Safe Dashboard, Open Rich Dashboard, and Select Dashboard Mode commands with machine-scoped configuration read-back verification.
- Added a safe fallback action to the Rich Dashboard ready-timeout notification, coalesced native document updates, local countdown refreshes, and redacted safe diagnostics.
- Stabilized the Windows wrapper environment-variable fixture with a unique test-local temp directory and inherited child environment override.

## 0.5.3

- Resilience hotfix for the Dashboard webview: this does not fix the VS Code/Chromium Service Worker registration error itself (a known upstream host bug — see microsoft/vscode#125993, #330595), but hardens everything in AI Limit Ledger's own panel lifecycle around it.
- Added a per-panel generation model so a disposed/stale Dashboard panel is never reused and its late `dispose` callback can never clear a newer panel's reference.
- Open Dashboard now reveals a healthy or not-yet-ready existing panel instead of creating a duplicate, and never races a second panel into existence while a recovery is in flight.
- Added a `dashboard.ready` handshake between the webview script and the extension host, a bounded pre-ready model buffer (flushed once, not replayed), and a one-shot 6s ready-timeout notification offering Recreate Dashboard / Reload Webviews / Show Logs — never auto-recreated.
- Added the `AI Limit Ledger: Recover Dashboard` command: disposes the current panel session, creates exactly one new panel, and is single-flight (a concurrent call returns the same in-flight result). Never touches provider APIs, credentials, settings, or any cache.
- `webview.html` is now deduplicated against the last-rendered input and debounced, reducing rapid re-assignment; this is a bounded/coalesced mitigation, not the full DOM-diffing `postMessage`-based render this hotfix deliberately did not attempt, to avoid risking the Task 3/4/5.1/5.2 dashboard behavior.
- Added safe, redacted Dashboard panel lifecycle fields (generation, ready state, timestamps, html assignment count, recovery status — never a panel id, webview origin, or path) to Copy Redacted Diagnostics and the support bundle.

## 0.5.2

- Changed Dashboard progress semantics to remaining capacity: bar fill, primary text, and progress ARIA values now all represent remaining percentage.
- Centralized finite/clamped remaining-capacity calculations for Dashboard, provider tooltip, and status-bar presentation.
- Added remaining-capacity warning/critical text for low or exhausted limits while preserving Task 5.1 SVG actions and provider-specific behavior.

## 0.5.1

- Replaced dashboard text placeholders and the More Actions glyph with a safe, repo-local inline SVG icon registry.
- Added consistent action-to-icon mapping and state icons for working, success, error, cancelled, and throttled actions without changing the Task 3 action protocol.
- Preserved button labels, native keyboard behavior, accessibility attributes, CSP restrictions, and the header logo asset.

## 0.5.0

- Redesigned the Dashboard with semantic Active Providers and Available Integrations sections, responsive VS Code theme-token styling, accessible action hierarchy, and local product branding.
- Added validated used-percentage progress bars with stale/backoff/LKG messaging, duplicate-window protection, and no-fake-progress handling for Copilot and Grok Free.
- Added fixture coverage for Task 3–5 interactions and packaged the first installable 0.5.0 VSIX with the repository-relative logo asset.

## 0.4.5

- **Fixed the Grok experimental fallback misreading the official Grok Build auth file.** The CLI's `auth.json` is a structural `AuthStore` map (`BTreeMap<String, GrokAuth>`): a top-level auth-scope key (e.g. `https://auth.x.ai::<UUID>`) mapping to a `GrokAuth` entry with `key` (bearer token), `user_id`, `auth_mode`, `create_time`, `expires_at`, and `oidc_issuer`. The reader previously scanned the whole document for any plausible-looking token field name, which never matched this shape and produced a misleading `auth-file-invalid` result even for a perfectly valid, logged-in session. It now parses the AuthStore structurally, selects a credential deterministically (first-party `https://auth.x.ai` OIDC preferred, then not-expired, then newest `create_time`), and rejects unsupported `auth_mode` values and expired sessions instead of guessing. `refresh_token`, email, name, profile image, and team/organization fields are never read.
- Added the required `user_id` metadata to the experimental Grok CLI-proxy billing request (`x-userid` header), alongside `X-XAI-Token-Auth: xai-grok-cli` and `x-grok-client-version` (the detected Grok CLI version). Host allowlist, HTTPS-only, disabled redirects, timeout, response-size cap, content-type validation, and 429 backoff are all unchanged.
- The experimental Grok billing response is now classified into distinct, non-error states instead of collapsing everything into a generic failure: `authentication-required` (401), `billing-not-available` (403), `billing-endpoint-unavailable` (404), `rate-limited` (429), `billing-not-exposed` (valid auth, no billing config), `incompatible-response` (unparseable schema), and a dedicated `free-plan` state that is shown as "Free plan — automatic billing details are not exposed by this experimental endpoint." instead of being reported as an error.
- **Removed the auth-scope identifier (URL + UUID) from "Diagnose Grok Integration" and the Dashboard.** The experimental fallback status now only ever shows a fixed, safe category name (e.g. `no-compatible-session`, `session-expired`, `unsupported-auth-mode`, `invalid-auth-store-structure`, `billing-not-exposed`, `proxy-authentication-required`) — never a URL, UUID, scope key, user id, or any other value read out of the auth file or the proxy response.
- **Clarified Copilot zero-credit usage semantics.** `credits_used: 0` from the experimental entitlement endpoint is real data and is now shown as "AI credits reported by endpoint: 0", never as "No usage data yet." Added an explicit note that the metric is AI credits reported by the entitlement endpoint, not total chat messages, and that usage data may lag behind recent activity.
- **Separated three previously conflated Copilot concepts** on the experimental Dashboard card: account management (organization-managed/personal/unknown), the endpoint's own reported plan, and the user-configured billing scope (`aiLimitLedger.copilot.plan`) — a user-configured value like `pro` is no longer presented as if it were the value returned by GitHub's entitlement endpoint.
- The `premium_interactions`, `chat`, and `completions` quota buckets are now surfaced independently in the Dashboard and diagnostics instead of only ever showing whichever bucket happened to be checked first, and are never summed together (the same usage can appear in more than one bucket).

## 0.4.4

- The Grok experimental CLI-proxy fallback no longer fails silently when "Enable Experimental Grok Usage" doesn't produce data. A safe (never-sensitive) reason is now recorded and shown on the Grok Dashboard card and in "Diagnose Grok Integration": not opted in, the auth file is missing, the auth file has no recognized token field (with its top-level key **names** only — never values — listed for diagnosis), the proxy rejected the token, the proxy rate-limited the request, or a specific network failure category.
- `readGrokAuthToken` now also recognizes a token nested one level down (e.g. under a `credentials` object) and checks a wider set of common field-name spellings, still never reading or returning any other field.

## 0.4.3

- Registered missing Copilot and Grok experimental configuration properties that prevented opt-in commands from persisting consent.
- `Enable/Disable Experimental Copilot Usage` and `Enable/Disable Experimental Grok Usage` now read back every configuration write to confirm VS Code actually accepted it, show a specific error (instead of a generic failure) and leave the setting untouched if a write is ever rejected, and are safe to run more than once.
- Added `src/configuration/SettingsKeys.ts` as the single source of truth for these keys, and a `test/ManifestConfigurationCoverage.test.ts` regression suite that fails the build if a configuration key is ever written from source without a matching `package.json` manifest entry again.
- Changing `aiLimitLedger.copilot.executablePath` now re-resolves the Copilot CLI and refreshes immediately, without a window reload.

## 0.4.0

- Added isolated GitHub Copilot and Grok providers to the Dashboard, status bar, provider selection, commands, and shared snapshot model.
- Added official GitHub Billing REST API Copilot usage parsing with VS Code GitHub Authentication first, explicit Plan-read PAT fallback, SecretStorage-only PAT storage, allowlisted fields, monthly reset calculation, configurable plan allowances, and last-known-good/backoff behavior.
- Added experimental Grok Build ACP billing transport (`grok agent stdio`, `x.ai/billing`) behind explicit enablement. CLI detection is machine-safe, workspace executables are rejected, community extensions are labeled as community-only, and missing/unsupported/auth states remain visible.
- Added four-provider privacy, lifecycle, command-manifest, URL-allowlist, and UI regressions without changing Codex/Claude data sources.

## 0.3.9

- **Fixed the "Enable Claude Code Integration" command being hard to find in the Command Palette.** Its title is restored to `AI Limit Ledger: Enable Claude Code Integration` (the command id, `aiLimitLedger.enableClaudeCode`, is unchanged — it was never actually missing from the manifest, only renamed to "Try Automatic Claude Usage Tracking" in 0.3.6). Added a manifest/registration consistency test so a future rename can't silently drift the two apart again.
- **Added an experimental CLI-free Claude usage transport** (`AI Limit Ledger: Enable/Disable CLI-free Claude Usage`), for the case where you use only the Claude Code VS Code sidebar and the CLI process never runs the official status-line contract. Off by default, gated behind its own separate, explicit consent dialog (distinct from the status-line integration's consent), and clearly labeled everywhere as "Experimental — undocumented Anthropic usage endpoint." Reads Claude Code's own OAuth access token read-only, in memory only — never logged, copied, stored, or refreshed — to call Anthropic's undocumented `api.anthropic.com/api/oauth/usage` endpoint (the same one Claude Code's own `/usage` command uses). See `docs/EXPERIMENTAL_CLAUDE_USAGE.md` (bundled with the extension) for the full data-flow diagram and threat model.
- The experimental transport is single-flighted and shares one 120-second-minimum, cross-window request cadence, with an escalating 429 backoff (`Retry-After` honored exactly; otherwise 2/4/8 minutes; at least 15 minutes after three consecutive 429s; capped at 60 minutes) and a token-free last-known-good cache that survives a rate-limit pause.
- The official Claude Code status-line integration remains the primary, always-on-by-default source: when it has real account-limit data, it always wins for context/model/session-cost, and for 5h/7d limits unless the experimental transport observed a strictly fresher value. The experimental transport is only ever allowed to fill in for a genuinely absent official source (e.g. `manual-only`/`upstream-statusline-not-invoked`) — never to mask a real repair-required/external-change/configuration-shadowed problem.
- Added a small, additive Stop/StopFailure/SessionStart Claude Code hook (installed only alongside the experimental transport) that writes a single allowlisted activity line — event type, timestamp, coarse category — used purely to decide _when_ a refresh is worth attempting. It never supplies a percentage or a rate-limit decision itself, and disabling the feature removes only AI Limit Ledger's own hook entries.
- New Claude Dashboard states (`ready-experimental`, `stale-experimental`, `rate-limited-experimental`, `authentication-required`, `consent-required`) with dedicated buttons, and new machine-scope settings `aiLimitLedger.claude.experimentalOAuthUsage.enabled` (default off) and `aiLimitLedger.claude.experimentalOAuthUsage.refreshSeconds` (default/minimum 120s).

## 0.3.8

- **Added Claude Integration Auto-Heal.** Once you've enabled Claude Code integration and granted automatic-repair consent, safe classes of breakage — a missing or outdated wrapper, a wrapper that fails its self-check, an AI Limit Ledger-owned statusLine that was dropped entirely, or a drifted `refreshInterval` — are now repaired automatically, without running "Repair Claude Code Integration" by hand. Auto-heal reuses the exact same staged/validated/self-checked/rollback-capable transaction the manual commands use; it never invents a second write path.
- Auto-heal **never** writes automatically when the current statusLine belongs to another tool, a project-level setting shadows the user-level one, a concurrent external change is detected, recovery metadata is required but missing, or consent/automatic-repair has not been granted — these always surface as a single, clear action instead.
- Added a one-time consent dialog on the first "Enable Claude Code Integration," and a new machine-scope `aiLimitLedger.claude.autoRepair` setting (default on) that can be changed any time with the new **AI Limit Ledger: Enable/Disable Claude Automatic Repair** commands. Disabling automatic repair never disables the Claude Code integration itself.
- Added **AI Limit Ledger: Recheck Claude Integration Health**, plus a debounced (1s), single-flight, exponential-backoff (max 3 attempts per issue) auto-heal pass triggered on activation, extension updates, and Claude settings/wrapper file-watcher events — never on a tight loop, and re-verified back to `healthy` after every successful repair.
- The Claude Dashboard card now shows Integration health, Automatic repair status, last health check/repair time and reason, and installed vs. expected wrapper version; a successful automatic repair surfaces as a single low-priority notice (once per session), never a modal.
- **Fixed Codex incorrectly showing `stale` immediately after a fresh, successful update.** A routine internal refresh throttle (two refresh triggers landing close together, e.g. the periodic fallback timer and a debounced watcher refresh) was being treated identically to a real fetch failure, flipping an already-healthy, just-updated snapshot to `stale`. A throttled call is now a no-op that leaves the existing snapshot untouched; a genuine failure after a good snapshot still correctly reports `stale`.

## 0.3.7

- **Refresh accuracy hotfix.** Codex now applies the documented `account/rateLimits/updated` App Server push directly to the snapshot (no redundant `rateLimits/read` round trip), with payload validation, single-flight, a configurable fallback poll (`aiLimitLedger.refresh.codexFallbackSeconds`, default 60s), and the fallback timer resetting — not stacking — on every real push.
- Codex now shows every reported limit window (`primary`, `secondary`, and every entry in `rateLimitsByLimitId`), deduplicated by limit id + window duration + reset time, instead of only one bucket.
- Claude Code's status-line `refreshInterval` is now set explicitly (`aiLimitLedger.refresh.claudeStatusLineSeconds`, default 15s) when Enable/Repair installs AI Limit Ledger's own wrapper — never touched when chaining behind an existing third-party status line, and never written outside an explicit Enable/Repair.
- The Claude snapshot now separately tracks `sourceUpdatedAt` (the wrapper's own embedded write time) from AI Limit Ledger's own check/parse time, and always advances `checkedAt` on every wrapper invocation, even when the data is unchanged.
- **Fixed a countdown-formatting bug** where a multi-day reset could render as `5d 1116m` instead of `5d 18h 36m`; a reset time already in the past now renders `Reset time passed`/`Reset pending` instead of a negative or nonsensical duration.
- **Fixed silent precision loss** in displayed percentages: values are no longer rounded before display (a `0.4%` used no longer disappears into `0%`), a shared formatter now caps display to one decimal under 10% and drops unnecessary `.0` at or above 10%, and a non-finite (`NaN`) upstream percentage is now rejected instead of silently clamped into a fake value.
- Added explicit "Account limit — 5-hour window" / "Account limit — 7-day window" / "Current session context window" labels and an explanatory note (English and Turkish) on the Claude Dashboard card, making clear that session context usage and account rate-limit usage are independent metrics that can show different percentages.
- Added "Last provider event", "Next fallback refresh", and "Snapshot age" to each Dashboard provider card, alongside the existing "Last check"/"Last successful data update" — so a preserved-but-aging snapshot is never presented without its age.
- Added `aiLimitLedger.refresh.manualCooldownSeconds` (default 10s) to the manual Refresh command, plus a minimal cross-window lease (backed by `globalState`) so two open windows don't both trigger a real provider read for the same manual refresh within a few seconds of each other.
- Added safe Codex App Server lifecycle diagnostics, per-read partial snapshots, stale-data recovery, and independent provider error handling.
- Added Codex Diagnose, Refresh/Restart/Diagnose dashboard actions, and explicit official Codex/Claude usage links.
- Hardened Claude enable/repair state transitions and isolated wrapper-watcher registration failures from extension activation.
- Added explicit `integration-disabled` state, restart-session guidance after Repair, exact `*UsagePage` commands with HTTPS/hostname validation, safe browser-open feedback, and expanded watcher/security regression coverage.

## 0.3.6

Hotfix for a confirmed regression: after "Enable Claude Code Integration," the effective Claude
`statusLine` could end up missing entirely (or pointing at a stale wrapper from an older extension
version) while diagnostics still reported "Settings ownership: ok" — so 5-hour/7-day usage never
appeared, silently.

- **Fixed the misleading diagnostic combination** where `settingsOwnershipOk` could read "ok" while the wrapper file was missing or the effective statusLine was absent. Diagnostics now compute a real `wrapperHashMatches` (comparing the on-disk wrapper's content hash against what the current generator would produce) instead of assuming any present file matches, and never report "ok" when there is no effective statusLine at all.
- Added `integrationHealth` (`ready` / `repair-required` / `disabled`) and `repairReasons` (`statusline-missing`, `wrapper-missing`, `wrapper-outdated`, `configuration-removed`, `post-commit-verification-failed`, `external-change`) to the Diagnose report, each derived from current disk state — never from cached ownership/recovery metadata alone.
- Added a `repair-required` Dashboard/status-bar state, distinct from `manual-only`: shown whenever Claude CLI is installed but the statusLine connection is missing or stale, with a single **Repair integration** action (no duplicate setup buttons once repaired).
- Added the **AI Limit Ledger: Repair Claude Code Integration** command — the same idempotent Enable transaction, now independently discoverable as a repair action.
- **Enable now actually repairs a stale wrapper**, not just a missing one: a wrapper generated by an older extension version is regenerated (staged, structurally validated, self-checked against a throwaway fixture path, then atomically installed) even though a file was already present.
- **Enable's settings commit is now verified after writing**: it re-reads the file it just wrote and confirms the statusLine actually took effect before reporting success. A wrapper installed as part of a repair is rolled back to its previous content if the settings commit that follows fails.
- **Concurrent-write handling**: an unrelated setting changed by another process during the transaction is preserved automatically (the writer always re-reads immediately before writing); a genuinely concurrent change to the statusLine field itself is detected and left alone — AI Limit Ledger reports the conflict and never enters a rewrite fight with an external settings manager.
- A snapshot with `rate_limits` fields explicitly `null` (e.g. captured before any response completed) is no longer conflated with a real, empty response — the Dashboard/status bar show "Waiting for the first completed Claude CLI response containing rate-limit data."
- Added a wrapper-file watcher (alongside the existing settings/snapshot watchers) so a wrapper deleted out from under AI Limit Ledger is detected without waiting for the periodic refresh.

## 0.3.5

- Added a first-class "extension-only" Claude mode: using Claude Code through the official `anthropic.claude-code` VS Code extension without the standalone CLI is now a fully supported experience, not an incomplete or broken one.
- Introduced `manual-only` as the default Claude state when automatic status-line tracking hasn't been (or can't be) established: "Claude Code extension connected — usage is available manually in Claude Code on this host." No more indefinite `waiting-for-first-response`, no more `integration-required` gate before the card shows anything useful, and CLI absence is framed as optional, never as an error.
- Added `ClaudeAccessMode` (`vscode-extension` / `standalone-cli` / `hybrid` / `unavailable`) and `ClaudeUsageCapability` (`automatic-live` / `automatic-checking` / `manual-only` / `not-available`) as explicit, separate concepts — a valid, connected Claude integration and automatic usage-data collection are no longer conflated.
- Extension-only mode gets its own short grace period (2 minutes) instead of the CLI-track's 15-minute wait; if no snapshot appears, it settles into `manual-only` instead of escalating to a diagnostic-looking state. A later real snapshot still promotes it straight to `ready`/automatic-live.
- Added Dashboard actions for manual-only mode: **Open Claude Code** (via the extension's own verified public `claude-vscode.sidebar.open` command, with a documented fallback), **Copy /usage**, **Recheck automatic tracking**, **Diagnose integration**, and a neutral **Learn about enhanced CLI mode** link — none of them install or invoke anything.
- Renamed the enable command's user-facing title to "Try Automatic Claude Usage Tracking" (the command ID `aiLimitLedger.enableClaudeCode` is unchanged, preserving compatibility).
- Added a status-bar/tooltip treatment for manual-only mode ("Claude manual") with no warning/error styling — it's a supported mode, not a problem.
- Added a capability-comparison table to the Claude Dashboard card contrasting VS Code-extension mode with the (not-yet-implemented) CLI-enhanced mode.

## 0.3.4

- Gave `waiting-for-first-response` a bounded lifetime instead of showing it indefinitely: a short grace period after enable/restart, then a longer wait window, then an explicit diagnostic state if no real snapshot has appeared.
- Added `upstream-statusline-not-invoked`: reached only once the effective statusLine, wrapper existence, and (in Diagnose) a live self-check are all confirmed healthy and the wait timeout has elapsed with no real snapshot — never as a guess, and never used as a reason to keep rewriting the wrapper.
- Added `unsupported-surface` for the rarer case where neither the standalone CLI nor the `anthropic.claude-code` VS Code extension can be detected at all, so AI Limit Ledger can't reason about whether the host should be invoking the status line.
- Added Claude Code host-surface detection (standalone terminal CLI vs. the VS Code extension vs. both vs. unknown), surfaced in the Dashboard, status bar, and Diagnose.
- Added Dashboard actions for the diagnostic states: **Open Claude Code installation guide** (opens Anthropic's docs in the browser), **Launch Claude Code in VS Code Terminal** (runs the already-installed CLI in an integrated terminal — shown only when the CLI is found), and **Copy redacted diagnostics**. None of these install Claude Code or run a remote script.
- Replaced the misleading single "Updated" timestamp with **Last check** (every refresh attempt) and **Last successful data update** (shown only once a real snapshot has been parsed).
- Expanded Diagnose with host-surface, minutes-since-enabled, and an explicit `upstreamStatusLineNotInvoked` verdict plus matching guidance — still fully redacted.

## 0.3.3

- Fixed the Codex/Claude Dashboard rendering a reset timestamp as a 1970 date: added a provider-neutral timestamp normalizer with explicit input kinds (unix seconds/millis, ISO, duration-until-reset), and fixed a Dashboard card that treated a unix-seconds value as milliseconds. Implausible values now render "Not provided" instead of a garbage date.
- Stopped depending on the undocumented `_aiLimitLedger` statusLine property for ownership detection — Claude Code's statusLine schema silently strips unrecognized properties on any settings rewrite, which was breaking ownership tracking after the CLI/extension resaved settings.json. Ownership is now recognized structurally (wrapper command/path matching) plus our own extension-side metadata, and the marker is no longer written.
- Added explicit Claude integration states — `restart-required`, `configuration-shadowed`, `wrapper-not-invoked`, `incompatible-cli`, `external-change` — so the Dashboard and status bar stop silently sitting in "waiting for first response" when the real cause is a different, more specific and more actionable problem.
- Added detection of Claude Code's project-level `.claude/settings.json` / `.claude/settings.local.json` shadowing the user-level statusLine AI Limit Ledger configured.
- `restart-required` now shows immediately after enable instead of assuming a running Claude session has reloaded the new configuration; a "Recheck integration" Dashboard action and file-system watchers (debounced) on the settings and snapshot files reconcile state automatically once a real session picks up the change.
- Extended the Claude Dashboard card with separate 5-hour/7-day rate-limit rows (used/remaining/reset with local time), context-window usage, session cost, model, and CLI version, plus an explanation when rate limits are absent because the account isn't Claude.ai Pro/Max.
- Expanded **AI Limit Ledger: Diagnose Claude Code Integration** with resolved config directory, winning statusLine scope, shadowing detection, a live wrapper self-check, five-hour/seven-day field presence, an error category, and a recommended next action — still fully redacted.

## 0.3.2

- Added non-destructive Claude Code status-line chaining: an existing `statusLine.command` can now be preserved and wrapped instead of replaced (Windows fully supported; POSIX best-effort).
- Preserved the existing status-line's output byte-for-byte behind the AI Limit Ledger wrapper.
- Made Claude Code enable a transactional operation with automatic rollback on any failure — the previous `statusLine` is restored and no partial state is left behind.
- The Dashboard and status bar now refresh live after enabling, disabling, or repairing the integration, without reopening the Dashboard.
- Replaced the "Keep existing setting" dead end with "Preserve and integrate", "Replace after backup", and "Cancel"; simplified the initial disclosure to a single dialog.
- Added safer disable/restore with external-change conflict detection, and ownership detection that recognizes and migrates the 0.3.1 marker format.
- Improved **AI Limit Ledger: Diagnose Claude Code Integration** with redacted, structured status (mode, wrapper/ownership/recovery/snapshot health) and no sensitive command or path content.

## 0.3.1

- Kept Claude visible with setup, unavailable, and waiting states.
- Isolated provider startup failures and registered commands before settings migration.
- Added the provider Dashboard, Claude enable action, and status-bar state labels.
- Removed active legacy command identifiers.

## 0.3.0

- Renamed to AI Limit Ledger and added provider-based Codex and opt-in Claude Code support.
- Added local Claude status-line bridge, safe parsing, refresh governance, and settings migration.

## 0.2.0

- Added compact, newline-free status-bar presentation and a Markdown usage tooltip.
- Added a theme-aware detailed usage panel with read-only token activity data.
- Added Marketplace metadata, original icon, support and publishing guidance.

## 0.1.0

- Initial release with read-only Codex App Server rate-limit display.
