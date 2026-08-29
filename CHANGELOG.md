# Changelog

## [Unreleased]

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
