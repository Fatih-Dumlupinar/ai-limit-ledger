# AI Limit Ledger Security

## Automatic release candidates and the privacy audit (Task 14.2)

**Automatic candidates.** `.github/workflows/release-candidate.yml` now also runs on a push to
`main` that touches `package.json` or `package-lock.json`, alongside the existing manual dispatch.
Its trigger set is exactly those two events and is asserted as a closed list by
`scripts/verify-workflows.mjs` — no `pull_request`, no `schedule`, and no `workflow_run` /
`repository_dispatch` / `workflow_call` chaining. Automating this stage costs no privilege: a
candidate build holds `contents: read`, creates no ref and no release, and performs no Marketplace
upload. The stage that _can_ publish, `finalize-release.yml`, remains manual and environment-gated
and was not automated.

A separate `resolve` job owns the decision, and the `build` job runs only when it reports
`should_build == 'true'`. That separation is structural on purpose: gating twenty steps on an `if:`
inside a single job would leave packaging one editing slip away from running on a non-bump push. The
resolve job reads the previous version from `git show ${BEFORE_SHA}:package.json`, where
`BEFORE_SHA` arrives from `github.event.before` through an `env:` mapping and must match
`^[0-9a-f]{40}$` before it is used — it is only ever a validated Git object reference, never free
shell text. A push that changes a manifest without changing the version, or whose previous commit is
the zero SHA or otherwise unavailable, produces a **successful, explicitly skipped run that builds
nothing**; a repository in a state a human must fix (manifests disagreeing, a missing changelog
section or release-notes file, an existing `v<version>` ref) fails instead.

`finalize-release.yml` now accepts a candidate built by either `push` or `workflow_dispatch` — an
explicit two-value allowlist, with every other event still refused — and additionally requires the
candidate run's head branch to be `main`, a check that did not exist before. All of its other
security properties are unchanged: `workflow_dispatch`-only trigger, `production-release`
environment with a required reviewer, exact Marketplace URL, version-scoped confirmation phrase, run
id and commit SHA verification, artifact and checksum re-verification, and idempotent tag/release
creation that never force-moves a tag or overwrites an asset.

**Artifact retention is now a flat seven days for every workflow.** Task 14 gave the release
candidate a 14-30 day band on the assumption that a candidate might sit unpromoted for weeks. Now
that a bump on `main` produces one automatically, that reason is gone: the manual Marketplace upload
plus Finalize Release is a same-week activity, and an expired candidate is not lost — dispatching
the workflow rebuilds it deterministically from the same commit. Holding an unpromoted, downloadable
build artifact for a month is retained risk with no matching benefit.

**`fetch-depth: 0` is now allowed in `release-candidate.yml`,** joining `secret-scan.yml` and
`finalize-release.yml`. Both of its uses structurally require full history: the privacy audit's
`--history` gate walks every reachable commit exactly as the secret scanner does, and the version
comparison must read `package.json` as it stood at the previous `main` tip. A shallow clone would
make both silently vacuous, which is worse than not running them.

**The privacy audit** (`scripts/privacy-audit.mjs`, `npm run audit:privacy`) is a permanent,
dependency-free, offline, read-only tool that scans the tracked source tree, all reachable git
history, and a packaged VSIX for personal and machine-identifying data — user-profile paths,
hostnames, UNC shares, private IP and MAC addresses, source maps carrying absolute build paths, VS
Code profile paths, PNG metadata — as well as a backstop set of credential shapes. It complements
rather than replaces GitHub secret scanning and the Gitleaks job, which answer the narrower question
of whether a _revocable credential_ is present.

It runs as a fail-closed gate in the candidate workflow at three points: over the source tree and
over history before packaging, and over the built VSIX before the artifact upload, SBOM, release
manifest, and provenance attestation. A failure stops the job there, so a package carrying personal
data can never become a signed, attested, downloadable artifact.

The tool never prints a matched value — not to stdout, stderr, a JSON report, or a job summary. A
match is fingerprinted (first 12 hex characters of its SHA-256), masked to its structural shape, and
classified, and the raw value is then discarded; a finding object has no field that could carry it.
It refuses to read credential stores, `.env` contents, or raw provider payloads, refuses to scan
outside the repository, refuses to follow a symlink escaping the repository root, rejects a VSIX
entry name that would escape the extraction root, handles binary/invalid-UTF-8/oversized input as
documented and _reported_ skips, and treats a crash, timeout, or subprocess error as a non-zero exit
rather than a silent pass. Suppressions live in `scripts/privacy-allowlist.json` and must name one
known pattern id, one exact non-wildcard path, and a written reason — an allowlist entry can never
contain the value it excuses. See `docs/PRIVACY-AUDIT.md`.

## Secure release system and first Marketplace release (Task 14)

> Superseded in part by Task 14.2 above: `release-candidate.yml` is no longer `workflow_dispatch`-only
> (it also runs automatically on a version bump merged to `main`), the version is no longer fixed to
> the release this workflow was written for, and the candidate artifact's retention band is now a
> flat seven days rather than 14-30. Everything else described below still holds.

Two new `workflow_dispatch`-only GitHub Actions workflows implement a manual-approval release
process for the 0.7.0 first Marketplace release; see `docs/RELEASE-PROCESS.md` for the full
procedure.

`.github/workflows/release-candidate.yml` runs with workflow-level `permissions: contents: read`
and refuses to run for any ref other than `main` or any version other than the one this workflow
was written for. It verifies the checked-out commit matches `origin/main`, runs the full
compile/lint/format/`verify:workflows`/`npm audit`/`audit:release`/test chain, packages the VSIX,
audits it, and generates a SHA-256 checksum, a CycloneDX-shaped SBOM
(`scripts/generate-sbom.mjs`), and a release manifest (`scripts/generate-release-manifest.mjs`)
containing only safe fields (version, publisher, extension ID, commit, toolchain versions, package
hash/size/file-count, test counts, audit summary, build timestamp, workflow run ID, repository) —
never a user path, token, or runner-temp path. Its one job additionally requests `id-token: write`
and `attestations: write` (scoped to that job only) to produce a build-provenance attestation via
the official `actions/attest-build-provenance` action, available because this repository is public.
The resulting artifact is retained 14-30 days and uploaded with a name that embeds the short commit
SHA. This workflow never tags, releases, or publishes anything.

`.github/workflows/finalize-release.yml` runs its one job under the `production-release` GitHub
Environment — a required-reviewer approval gate the repository owner configures in GitHub Settings,
never created or modified by workflow code — with `permissions: contents: write` and
`permissions: actions: read` (the minimum needed to create a tag/Release and to download a
candidate artifact from another run), scoped to that job only. Every input (`version`,
`candidate_run_id`, `commit_sha`, `marketplace_url`, `marketplace_confirmation`) is validated
against a strict allowlist — an exact version match, a `^[0-9a-f]{40}$` commit SHA, an exact
Marketplace listing URL, and a literal `I_HAVE_VERIFIED_MARKETPLACE_0.7.0` confirmation phrase —
before anything else runs, and every value reaches a shell command only through an `env:` mapping,
never interpolated directly into a `run:` step (the same untrusted-input rule
`scripts/verify-workflows.mjs` already enforces for every workflow). The workflow re-downloads the
candidate artifact, recomputes its SHA-256 against both the release manifest and `SHA256SUMS.txt`,
confirms the candidate commit is an ancestor of `main` via `git merge-base --is-ancestor`, and
re-runs the VSIX release audit before creating anything. Tag and Release creation are idempotent
and never force-move a tag or overwrite an existing release asset — an existing tag/release that
doesn't match the expected commit fails the run instead of being altered.

Neither workflow creates, stores, requests, or echoes a Marketplace PAT, `VSCE_PAT`, or any other
publishing credential, calls a Marketplace publish API, or runs `vsce publish`/`npm publish`. The
first Marketplace upload is a manual VSIX upload performed by the project owner outside CI — see
"Why no PAT" in `docs/RELEASE-PROCESS.md`.

`scripts/verify-workflows.mjs` was extended to check both new workflows structurally: an exclusive
`workflow_dispatch` trigger (no `pull_request`/`push`/`schedule`), a per-file write-permission
allowlist now checked at every `permissions:` block in the document (previously only the
workflow-level block was checked, since no existing workflow had a job-level override before this
task), a 14-30 day retention band specific to `release-candidate.yml` (every other workflow stays
at 1-7 days), `fetch-depth: 0` allowed only for the full-history secret scan and
`finalize-release.yml`'s ancestry check, and a narrowed release/publish-operation ban so only
`finalize-release.yml` may reference `gh release` or the Marketplace listing URL string — `vsce
publish`/`npm publish` remain forbidden in every workflow file with no exception. All actions used
by both workflows, including `actions/attest-build-provenance`, are pinned to a full 40-character
release commit SHA in `scripts/verify-workflows.mjs`'s approved-release table, the same mechanism
that already pins `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
`github/codeql-action`, and `actions/dependency-review-action`.

`@vscode/vsce` remains a `devDependency` only, on its existing stable pinned version, installed
deterministically via `npm ci`/`package-lock.json`; no workflow uses `npm install -g` or an
uncontrolled `npx` download, and `npm run package` (the only place `vsce package` runs) never
publishes.

## Repository CI security (Task 12)

The repository has four checks: `CI`, `CodeQL`, `Secret Scan`, and `Dependency Review`. CI runs
the locked install and quality commands on Ubuntu and Windows, then packages and audits a VSIX.
CodeQL analyzes JavaScript/TypeScript on pull requests, pushes to `main`, and a weekly default-
branch schedule. Dependency Review fails moderate-or-higher vulnerabilities without excluding
development dependencies. Secret Scan checks the complete Git history with the official Gitleaks
CLI, verifies its release archive against the official SHA-256 checksum, runs with `--redact`, and
fails on findings. Its report artifact is retention-limited and contains no raw secret by design.

All external Actions are pinned to full commit SHAs and use least-privilege permissions. Fork PRs
use `pull_request`, never `pull_request_target`; no repository secret or provider session is
available to these checks. The current repository API metadata reports GitHub-native secret
scanning and push protection enabled, but the independent scan remains part of this repository's
policy and Task 12 did not alter GitHub settings. Native availability may differ by account or
repository plan, so it must not be treated as the only control.

`npm audit` checks the resolved dependency tree against the npm registry and needs network access.
`npm run audit:release` is a separate dependency-free offline manifest, credential-pattern, and
VSIX-content audit. Dependency Review evaluates dependency changes in a pull request; neither
tool replaces the other.

The workflow verifier (`npm run verify:workflows`) rejects floating or short Action references,
unsafe permissions, untrusted shell interpolation, broad secret-scan exclusions, unverified
Gitleaks downloads, publish steps, and VSIX packaging regressions. See
[docs/CI-SECURITY-DESIGN.md](docs/CI-SECURITY-DESIGN.md) and
[docs/BRANCH-RULESET.md](docs/BRANCH-RULESET.md) for the repository policy.

## Marketplace listing preparation (Task 13)

Task 13 changes `package.json`'s `publisher` from `local` to the real Marketplace publisher ID
`fatihdumlupinar-dev` and adds Marketplace listing/asset documentation. It does not publish to the
Marketplace, does not create or store a publishing token/PAT, and does not touch SecretStorage,
provider credentials, or any user's existing extension installation. `scripts/release-audit.mjs`
was extended with Marketplace-specific checks (publisher identity, extension ID, keyword/category
policy, HTTPS-only image links, no local/absolute paths, no publish-workflow files, no `vsce
publish` invocation anywhere in the source tree) so a future accidental regression is caught before
packaging, not discovered at publish time. See `docs/MARKETPLACE-PREFLIGHT.md` for the full manual
checklist and `PUBLISHING.md` for the installation-identity-change note.

## Supported Node LTS and dependency remediation (0.6.2)

No user-facing feature change. Development-only: the project now targets a supported Node LTS
(Node 24 preferred, Node 22 minimum; EOL Node 20 is no longer recommended — see
`engines.node`, `.nvmrc`, `.node-version`), and `vitest` was upgraded from the vulnerable `2.1.9`
to the latest stable `4.1.11`, which transitively brought `vite`/`@vitest/mocker` to
non-vulnerable versions and removed `vite-node` entirely (replaced upstream by Vite's Module
Runner). All 5 findings open in the 0.6.1 `npm audit` report are resolved:
`npm audit --json` and `npm audit --omit=dev --json` both report zero vulnerabilities. See
`docs/DEPENDENCY-RISK-REGISTER.md` for the full before/after table.

This release also corrects an imprecise claim in the 0.6.1 documentation that could be read as
"`npm audit` is offline" — it is not: `npm audit` queries the npm registry for known advisories
against your resolved dependency tree and requires network access to return a current result.
`npm run audit:release` (`scripts/release-audit.mjs`) is the separate tool that is genuinely
offline and dependency-free. See the errata notes in `docs/DEPENDENCY-RISK-REGISTER.md` and
`docs/SECURITY-AUDIT-0.6.1.md`.

`scripts/release-audit.mjs` itself was already excluded from the packaged VSIX in 0.6.1 via
`.vscodeignore`'s `scripts/**` rule (development/build tooling, not needed by the running
extension); this is now covered by explicit regression tests
(`test/ReleaseAuditNotPackaged.test.ts`) rather than only by the ignore-file rule.

## Release hardening (0.6.1)

This is a security/release-readiness maintenance release with no user-facing feature change. `npm audit` reports 5 findings, all transitive dev/test-only (`vitest`, `vite`, `esbuild`, `vite-node`, `@vitest/mocker`); the extension has zero production dependencies, and none of these packages are packaged into the VSIX or reachable from the extension host at runtime. The only available fix is a semver-major `vitest` 2→4 upgrade, deferred and tracked in `docs/DEPENDENCY-RISK-REGISTER.md` rather than applied automatically.

Fixed a real Windows-only race in `SharedSnapshotStore`: concurrent same-process writes could generate colliding temp filenames within the same millisecond, and the atomic rename could then intermittently fail with `EPERM`/`ENOTEMPTY` under transient Windows file-locking contention. Temp filenames now include a random suffix, and the rename retries a bounded number of times with backoff for the two known-transient error codes only.

Compiled `**/*.map` source maps (which point at `../../src/*.ts` paths never shipped in the package) and local audit/dependency-tree scratch files are now excluded from the VSIX via `.vscodeignore`. `npm run audit:release` is a new, dependency-free, offline, local script that checks manifest/lockfile version consistency, scans for absolute-user-path and credential-shaped patterns (with fixture/placeholder triage), inspects `package-lock.json` for non-registry or lifecycle-script supply-chain risk, and — given a built `.vsix` — audits its content against a required-file/denylist policy and size budget using a small pure-Node ZIP reader. It never prints a matched secret value, only file/line/category.

## Central settings and refresh safety (0.6.0)

The `dashboard.insightsMode` setting is also render-only and window-scoped. Provider insights use an explicit allowlist and typed provenance/freshness fields; unknown payload fields, negative/non-finite metrics, raw payloads, credentials, tokens, paths, and account identifiers are excluded before rendering or persistence. No insight is aggregated across providers or account/session scopes.

User-facing configuration is normalized through one typed effective-settings service. Invalid values, provider aliases/duplicates, threshold ordering, and ignored workspace overrides produce bounded diagnostics without retaining raw values. Machine-scoped executable paths are never accepted from workspace settings and are represented only as `auto`/`configured` in support output. Provider selection changes reconcile live; executable changes rerun detection only; cadence changes retain single-flight, minimum-interval, lease, and backoff gates.

Experimental Copilot entitlement and Grok CLI-proxy usage have separate consent metadata in VS Code global state. Enabling their boolean setting directly cannot activate a transport. `Copy Redacted Effective Settings` excludes executable paths, tokens, credentials, raw commands, and workspace paths. Legacy settings are migrated idempotently and are never deleted.

The Claude status-line bridge (the default, primary integration) is local-only, has no network behavior, limits stdin size, allowlists fields, and uses atomic snapshot replacement. Copilot and Grok are separate providers with independent consent, credentials, leases, backoff, and failure isolation.

The runtime localization path is render-only: a `display.language` change recomputes typed settings and re-renders cached Dashboard/Safe Dashboard/status-bar/tooltip/interaction text. It does not invoke provider refresh, network, credential, CLI, App Server, cache, consent, or action-replay code. Manifest contribution language is selected by VS Code from `package.nls.json` and `package.nls.tr.json`, so it follows the VS Code UI language rather than this runtime setting.

## GitHub Copilot (0.4.0)

Copilot usage uses the official GitHub Billing REST API (`GET /users/{username}/settings/billing/ai_credit/usage`) with API version `2026-03-10`. Authentication uses VS Code's public `github` Authentication API first. The fallback is an explicitly pasted fine-grained PAT with only **Plan: read**, stored only in VS Code SecretStorage under AI Limit Ledger's own key. The extension never reads Copilot private cache/token files, Copilot CLI credentials, `gh auth token`, repository data, or admin/write scopes. Response parsing copies only the documented billing allowlist and never stores the raw response.

Copilot refreshes are single-flighted, machine-leased, rate-limit aware, and preserve last-known-good data. A 403/insufficient permission is not retried indefinitely. Plan allowance calculations are labeled as calculated and never presented as GitHub-provided allowance.

## Grok Build (0.4.0)

Grok is disabled until explicit user action. When enabled, the only process entry point is the official Grok Build ACP transport (`grok agent stdio`). The experimental `x.ai/billing` capability is capability-probed and `-32601` is cached per CLI version; it is not treated as an official usage endpoint. The CLI-proxy fallback is separate, experimental, and opt-in. `/usage` is only the official account view run by the user inside Grok Build; AI Limit Ledger does not run it automatically. AI Limit Ledger never reads Grok auth files, tokens, prompts, transcripts, code, or runs `grok login` without a click. Stdio responses are size-limited, stderr is redacted, unknown notifications are ignored, and the process is disposed on deactivation.

## Chained status-line wrapper (0.3.2+)

When "Preserve and integrate" is chosen, AI Limit Ledger generates a small wrapper script and only ever runs your existing, previously-configured status-line command through it after your explicit confirmation of the change — it never invokes any command that wasn't already present in your Claude Code settings. The wrapper:

- reads Claude Code's status-line JSON from stdin exactly once, and never logs the command, stdin, or stdout;
- writes only an allowlisted local snapshot via temp-file-then-atomic-rename, never the raw JSON;
- forwards the same JSON to your existing status-line command over stdin only — never by building a shell string from the JSON, so the JSON payload cannot inject additional commands;
- enforces a maximum input size, maximum output size, and a timeout, and mirrors your existing command's stdout and exit code back to Claude Code unchanged;
- keeps working even if the snapshot write fails, and never calls a remote or OAuth usage endpoint.

Enabling, disabling, and repairing the integration are transactional: on any failure the previous `statusLine` value is restored and partial wrapper files are removed. Diagnostics (`AI Limit Ledger: Diagnose Claude Code Integration`) never display the original command text, credentials, tokens, raw Claude JSON, or full session/workspace paths.

## Webview safety

The details panel uses a nonce-based CSP, escapes untrusted text, and accepts only a fixed allowlist of command messages. Usage-page navigation is limited to fixed provider URLs for Codex, Claude, Copilot, and Grok; URL messages, arbitrary href values, `javascript:` links, and untrusted command IDs are rejected. It never enables trusted Markdown command URIs.

## Experimental CLI-free Claude usage (0.3.9+)

Off by default, and gated behind its own explicit consent dialog, separate from the status-line integration's consent. When enabled, AI Limit Ledger reads the OAuth access token Claude Code already stores in `~/.claude/.credentials.json`, in memory only, to call Anthropic's undocumented `api.anthropic.com/api/oauth/usage` endpoint. The token is never written to disk, `globalState`, `workspaceState`, or Secret Storage, never refreshed, and never appears in logs, error messages, or diagnostics — only the resulting allowlisted percentages do. Requests are capped to a shared 120-second-or-longer interval across all VS Code windows, single-flighted, and back off on 429 responses (`Retry-After` honored exactly; otherwise 2/4/8 minutes, then at least 15 minutes after three consecutive 429s, capped at 60 minutes). See `docs/EXPERIMENTAL_CLAUDE_USAGE.md` (bundled with the extension) for the full threat model. Disabling it immediately stops all credential reads and network requests from this transport.

## Official provider-link navigation

The read-only `ProviderLinkRegistry` is the only runtime source for provider product, usage, settings, billing, installation, and documentation URLs. `ProviderLinkService` revalidates every fixed URL for HTTPS, exact host, empty userinfo, empty/443 port, bounded length, fixed query/fragment values, and non-IP/non-shortener hosts before calling `vscode.env.openExternal`. Webviews send action IDs only; they cannot supply URLs or command URIs. Navigation is never automatic, and the extension does not read browser cookies, sessions, redirects, or page content. A failed browser open produces only a safe notification and link ID/correlation metadata in redacted logs.

This usage request is not model generation and does not consume a prompt/token budget: it is a bodyless `GET` to the allowlisted account-usage path, with no `/v1/messages` or model endpoint call.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.** Report it privately using [GitHub's private vulnerability reporting](https://github.com/Fatih-Dumlupinar/ai-limit-ledger/security/advisories/new) for this repository.

Do not include credentials, tokens, or raw provider responses in your report; redact any screenshot before attaching it. The Codex provider does not read Codex authentication files or accept user-supplied tokens. It uses only the configured Codex executable or the `codex` command resolved from the system PATH.

This is a solo-maintained project without a dedicated security team; there is no guaranteed response-time SLA, but reports are read and triaged as they arrive. Supported version: the latest published release only — older versions do not receive security fixes.
