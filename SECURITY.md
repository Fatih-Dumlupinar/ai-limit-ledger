# AI Limit Ledger Security

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
