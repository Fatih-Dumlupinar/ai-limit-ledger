# AI Limit Ledger Privacy

## Release hardening (0.6.1)

No change to what data the extension reads, stores, or transmits. This release is a source/release-process audit: local temp-file naming in `SharedSnapshotStore` was hardened against a same-process filename collision (no user data was ever at risk — the collision only affected which of two identical writes' temp file survived to be renamed), and the packaged VSIX now excludes compiled source maps and local audit scratch files that were never user data but added unnecessary package weight. See `docs/SECURITY-AUDIT-0.6.1.md` for the full audit.

## Settings and cached snapshots (0.6.0)

Provider Usage Insights are stored only as typed, provider-scoped allowlisted values: account metrics, the latest observed Claude CLI session when available, bounded Codex daily rows, and explicit source provenance/freshness. They never combine providers, plans, account limits, session activity, or product categories. Invalid/negative/non-finite values and missing denominators are omitted; no raw payloads, credentials, tokens, paths, emails, account IDs, prompts, transcripts, or code are retained.

Settings use one typed effective snapshot. Diagnostics retain only safe keys/categories; executable values become `auto` or `configured` in copied support data. Workspace attempts to override machine-scoped paths are ignored. Last-known-good usage caches contain allowlisted percentages/reset times only and are hidden after the configured age unless expired-cache display is explicitly enabled. No credentials are stored by settings migration or refresh scheduling.

Claude Code status-line support is opt-in. The official status-line integration does not read Claude credential files, browser sessions, organization IDs, Keychain/Credential Manager data, `auth.json`, repository details, or paths. Its status-line bridge allowlists documented fields and writes only a local sanitized snapshot. Copilot and Grok are independent providers and do not share credentials or provider state.

Runtime language changes are presentation-only. Rich/Safe dashboards, status bar text, tooltips, notifications, and pickers are rebuilt from cached snapshots; changing `display.language` does not refresh a provider, read credentials, start a CLI/App Server process, or make a network request. Command Palette and Settings contribution localization is owned by VS Code's extension manifest loading and follows the VS Code display language.

## GitHub Copilot (0.4.0)

Copilot does not access data until a usable VS Code GitHub auth session or explicitly entered PAT exists. The VS Code auth session is preferred. A PAT fallback requires the user's explicit choice, asks for only **Plan: read**, and is stored only in VS Code SecretStorage. AI Limit Ledger never reads Copilot private token/cache files, CLI credential files, `gh auth token`, repository content, or Copilot prompts/transcripts. The billing response is reduced to time period, documented usage quantities/amounts, and model/product fields needed for the Dashboard; the raw response is not stored.

If no allowance is returned by GitHub, `auto` mode shows used credits only and does not manufacture a remaining percentage. A configured Pro/Pro+/Max/custom allowance is clearly labeled as calculated from usage plus the user's configured plan.

## Grok Build (0.4.0)

Grok usage is disabled by default and requires **Enable Grok Usage**. After the user installs and logs into the official Grok Build CLI, AI Limit Ledger can start its own `grok agent stdio` process through the official Grok Build ACP transport to request the experimental `x.ai/billing` capability. The CLI-proxy fallback is separate, experimental, and opt-in. `/usage` is only the official account view that the user runs inside Grok Build; AI Limit Ledger does not run `/usage` automatically. It does not read `~/.grok/auth.json`, tokens, prompts, transcripts, code, or run login automatically. The community VS Code extension, when present, is reported as community-only and is not used as an official source.

The one exception is the separate, off-by-default, explicitly-consented "CLI-free Claude Usage" experimental transport described below — while it is enabled, it reads the OAuth access token (and only the access token) from Claude Code's own credential file. It is disabled unless you turn it on, and disabling it stops all credential access from this transport immediately.

## Experimental CLI-free Claude usage (0.3.9+)

Enabling `AI Limit Ledger: Enable CLI-free Claude Usage` requires its own separate, explicit consent dialog — accepting the status-line integration's consent does not enable this. Once enabled:

- The OAuth access token is read from `~/.claude/.credentials.json`, in memory only, never written to disk, `globalState`, `workspaceState`, or Secret Storage, and never refreshed or rotated.
- The token never appears in logs, error messages, or the `Copy Claude Code Diagnostics` output.
- The refresh token, account id, email, and subscription-plan fields are never read, even though they are present in the same file.
- Consent bookkeeping stored in `globalState` is limited to a consent version, an acceptance timestamp, and a transport version — never a token, a token hash, or any account identity.
- A last-known-good cache of the 5h/7d percentages and reset times (never the token, never the raw response) is kept so the dashboard can keep showing a value during a rate-limit pause.
- A small, additive Stop/StopFailure/SessionStart hook is installed to know _when_ to check for fresh usage; it writes only an event type, a timestamp, and a coarse category to a local file — never a prompt, response, transcript path, working directory, tool input/output, or account identity.
- Turning the feature off removes only AI Limit Ledger's own hook entries and immediately stops all reads and requests from this transport.

Full data-flow diagram and threat model: `docs/EXPERIMENTAL_CLAUDE_USAGE.md` (bundled with the extension).

The experimental Claude usage transport is an account usage read, not model generation: it sends only a `GET` request without a body to the allowlisted Anthropic usage endpoint, never calls model/messages endpoints, and extracts only allowlisted percentages/reset times. It retains the shared 120-second-or-longer interval and 429 backoff protections.

## Preserve and integrate (0.3.2+)

When an existing Claude Code `statusLine` is preserved and chained, AI Limit Ledger keeps a copy of the original `statusLine` value so it can be restored later — that copy is stored in VS Code's user-scoped Secret Storage, never in the workspace, never committed to git, and never logged. Separate, non-sensitive ownership bookkeeping (schema version, wrapper path, wrapper version, a hash of the original value, and the time it was enabled) is kept in VS Code's global state; it never includes your username, email, session ID, transcript path, workspace path, OAuth token, or the raw Claude Code JSON payload. The chained wrapper runs your existing status-line command only after your explicit confirmation, and makes no network calls of its own — it does not call any remote or OAuth usage endpoint.

## 0.2.0 data scope

The optional usage panel reads only documented, local App Server token summaries and daily aggregate buckets. Email fields and all account identifiers are deliberately ignored.

Codex Limit Bar sends no data to third parties and contains no telemetry. It obtains display-only account-plan and rate-limit data from the locally installed Codex App Server. Logs redact token-like values, email addresses, and account identifiers.

## Official provider links

The Dashboard's provider-link buttons are explicit user-triggered external navigation only. The central registry stores fixed official HTTPS URLs and the service validates protocol, exact host, userinfo, port, query keys, and fragments before calling the default browser. The extension does not read browser sessions, cookies, redirects, or page content, does not ping links during activation or rendering, and does not append account/token data. Authenticated usage and billing pages require the user to sign in in the browser. Experimental usage transports are separate from documentation and product links.
