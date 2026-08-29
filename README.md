# AI Limit Ledger

_[Türkçe](README.tr.md)_

AI Limit Ledger is a privacy-first VS Code extension for monitoring AI coding usage limits, quotas, reset windows, and provider activity for Codex, Claude Code, GitHub Copilot, and Grok. Copilot uses the official GitHub Billing REST API only after GitHub authentication or an explicitly supplied Plan-read fine-grained PAT. Grok usage is off until explicitly enabled and uses the official Grok Build CLI's experimental `x.ai/billing` ACP extension.

AI Limit Ledger is an independent community project and is not affiliated with or endorsed by OpenAI, Anthropic, Google, or xAI.

**Unofficial community extension. Not affiliated with or endorsed by OpenAI.**

AI Limit Ledger shows Codex, Claude Code, GitHub Copilot, and Grok provider states in one Dashboard and the VS Code status bar. Provider failures are isolated and a missing CLI never removes a provider card.

Hover for a Markdown usage table; click for a theme-aware provider dashboard with reset times, plan, CLI/App Server status, and available token activity.

## Supported providers

| Provider       | Status                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------- |
| Codex          | Official, local App Server only                                                             |
| Claude Code    | Official status-line integration; an OAuth usage check is **experimental**, off by default  |
| GitHub Copilot | Official GitHub Billing REST API                                                            |
| Grok           | Official ACP `x.ai/billing` first; a CLI-proxy fallback is **experimental**, off by default |

See the full [provider capability matrix](docs/PROVIDER_CAPABILITY_MATRIX.md) for exact sources, account/session insight coverage, and experimental boundaries.

## Rich and Safe Dashboard

The default **Rich Dashboard** is a themed Webview panel with reset times, plan, CLI/App Server status, and available token activity. The **Safe Dashboard** (`AI Limit Ledger: Select Dashboard Mode` → `Safe Native`) renders the same information as a read-only text editor document with no Webview or Service Worker APIs, for restricted or Webview-disabled environments. Both read from the same typed provider snapshots and stay in parity for supported fields.

## Data and privacy

Codex remains local-only and read-only. Copilot calls `GET /user` and the official user AI-credit billing endpoint with an auth session from VS Code's GitHub Authentication API or a user-entered Plan-read PAT stored only in VS Code SecretStorage; tokens are never logged or written to global/workspace state, and no repository/admin/write permission is requested. Grok starts `grok agent stdio` only after its provider is explicitly enabled; AI Limit Ledger does not read Grok auth files, prompt/transcript/code data, or run `grok login` automatically. There is no telemetry.

## Installation status

This extension is **not yet published to the Visual Studio Code Marketplace**. There is no Marketplace listing and no GitHub Release install path yet — that install path is planned for after the Marketplace publisher is set up (see [Roadmap](#roadmap)). For now, install from source:

1. Clone this repository and follow [Development setup](#development-setup) to build a `.vsix` package.
2. Install and sign in to Codex CLI (or whichever providers you use).
3. Install the built package:

   ```powershell
   code --install-extension ai-limit-ledger-<version>.vsix
   ```

For a Webview-free details view, run `AI Limit Ledger: Select Dashboard Mode`, choose `Safe Native`, and then run `AI Limit Ledger: Open Dashboard`. The Safe Dashboard opens as a read-only text editor document and does not use Webview or Service Worker APIs.

## Settings

- `aiLimitLedger.compactStatusBar` — show only percentages.
- `aiLimitLedger.presentationMode` — remaining (default) or used.
- `aiLimitLedger.refreshIntervalSeconds` — 30 minutes by default.
- `aiLimitLedger.codexExecutablePath` — machine-scoped absolute path or `auto`; workspace settings cannot control it.
- `aiLimitLedger.providers` — Codex, Claude Code, GitHub Copilot, and Grok (all four are shown by default).
- `aiLimitLedger.copilot.plan` — `auto`, `pro`, `proPlus`, `max`, or `custom`; `auto` never invents a remaining percentage.
- `aiLimitLedger.copilot.customMonthlyCredits` — user allowance for `custom` plan.
- `aiLimitLedger.copilot.refreshSeconds` and `aiLimitLedger.grok.refreshSeconds` — 120–3600 seconds, 300 by default.
- `aiLimitLedger.grok.executablePath` — optional absolute machine-scoped Grok Build CLI path; workspace-relative paths are rejected.

### Central settings (0.6.0)

`aiLimitLedger.dashboard.insightsMode` is window-scoped and accepts `summary` (default), `detailed`, or `hidden`. It is shared by the Rich and Safe Native Dashboards and changes presentation only; it does not refresh providers, read credentials, make network calls, or reset actions.

The typed settings service normalizes provider aliases, removes duplicates, ignores unknown IDs, validates threshold ordering and numeric bounds, and reports only safe diagnostics. Dashboard and status-bar provider order/visibility are independent. `display.percentageMode` supports `remaining`, `used`, and `both`; language supports `auto`, `en`, and `tr`; time format supports `locale`, `relative`, `absolute`, and `both`. Tooltip density, notification/logging levels, and bounded last-known-good cache policy are also configurable.

Use **Select Status Bar Mode**, **Select Percentage Display**, **Reset Display Settings**, and **Copy Redacted Effective Settings** from the Command Palette. Provider selection changes reconcile immediately; executable changes rerun detection only. Refresh changes retain the existing minimum-interval, single-flight, lease, and backoff protections. Machine-scoped paths and experimental settings ignore workspace values; experimental Copilot/Grok transports additionally require separate consent metadata.

## Development requirements

Building and testing from source requires a **supported Node.js LTS line and npm 10+**. Node 20 reached its end-of-life and is no longer recommended; **Node 24 (current LTS) is the preferred development version**, and **Node 22 (LTS) is the minimum supported development runtime** — see `.nvmrc`/`.node-version` and `package.json`'s `engines.node`. The extension itself has **zero production dependencies** and targets VS Code `^1.95.0` at runtime; the Node version used to build it is unrelated to the Node APIs available inside the VS Code extension host, and end users installing the packaged `.vsix` never need Node installed at all.

`npm audit` requires network access to the configured npm registry — it sends your resolved dependency tree to check it against known advisories and needs connectivity to return a current result. It is **not** the same tool as `npm run audit:release` (`scripts/release-audit.mjs`), which is this project's own dependency-free, fully offline local/VSIX content check; the two commands are complementary, not interchangeable, and neither replaces the other.

The older `compactStatusBar`, `presentationMode`, used-percentage thresholds, `showErrorNotifications`, and `refreshIntervalSeconds` settings remain registered as deprecated compatibility settings and are migrated idempotently without deletion.

### Runtime language behavior

`aiLimitLedger.display.language` controls the runtime Dashboard, Safe Native Dashboard, status bar, tooltip, notifications, pickers, and action feedback. `auto` follows the VS Code locale (`tr`, `tr-TR`, and `tr_TR` select Turkish; unsupported locales fall back to English), while `en` and `tr` are explicit overrides. These surfaces re-render without a window reload and use the existing cached provider snapshots; changing language does not refresh a provider, read credentials, start a process, or make a network request.

Command Palette and Settings contribution titles/descriptions are provided through VS Code's `package.nls.json` / `package.nls.tr.json` mechanism. Their language follows the VS Code display language and is selected when the extension contribution is loaded; changing `display.language` cannot change those platform-owned strings live and may require Reload Window.

The experimental CLI-free Claude usage check is an account usage `GET` request to `api.anthropic.com/api/oauth/usage`, with no model-generation or messages request and no request body. It remains subject to its shared minimum 120-second interval and 429 backoff policy.

### Provider usage insights

The common typed insights model keeps account metrics, latest-session metrics, daily trends, and source provenance separate. Summary shows at most five safe fields; detailed mode exposes the remaining allowlisted fields in an expandable section; hidden mode leaves the primary quota cards and reset information unchanged. Invalid, negative, non-finite, stale, or unavailable values are omitted or labeled rather than converted into fake percentages.

- Codex uses only official App Server `account/read`, `account/rateLimits/read` (including its update notification), and `account/usage/read`. Daily usage is sorted, duplicate dates are merged, and at most 30 days are retained internally; the default display is the latest 14 days. Reset credits and observed expiration dates are display-only.
- Claude’s official status-line snapshot keeps account 5-hour/7-day limits separate from the latest observed CLI session. Model, context, input/output/cache tokens, estimated cost, durations, line counts, fast/effort/thinking/output-style fields are explicit allowlist fields. Experimental OAuth account limits never overwrite official session metrics.
- GitHub Copilot makes AI credits the primary metric. An allowance is shown only when authoritative or explicitly user-configured and marked calculated. Premium interactions, chat, and completions remain separate; organization management is not a monthly denominator.
- Grok tries official ACP `x.ai/billing` first. Its CLI-proxy billing fallback is experimental and opt-in. Missing product breakdowns remain not exposed rather than an empty product array, and `/usage` is a copy-only action for the official Grok Build account view.

See `docs/PROVIDER_CAPABILITY_MATRIX.md` for the source and limitation matrix.

## Claude Code setup

1. In VS Code, press `Ctrl+Shift+P`.
2. Run **AI Limit Ledger: Enable Claude Code Integration**.
3. Confirm the requested change.
4. If Claude Code already has a `statusLine` command, choose how to proceed.
5. Complete a Claude Code response.
6. Run **AI Limit Ledger: Open Dashboard**.

`AI Limit Ledger: Enable Claude Code Integration` is a VS Code Command Palette entry, not a PowerShell command — you run it from `Ctrl+Shift+P`, not a terminal. The extension never reads Claude credentials and never changes `statusLine` without your explicit confirmation.

### Integration modes

- **Standalone** — used when Claude Code has no existing `statusLine`. AI Limit Ledger installs its own bridge command.
- **Preserve and integrate** (recommended, offered when a `statusLine` already exists) — chains a small wrapper behind your existing status-line command. The wrapper reads Claude Code's status-line JSON once, writes an allowlisted local snapshot, forwards the same JSON to your existing command unchanged, and returns its output to Claude Code byte-for-byte. Fully supported on Windows; best-effort on macOS/Linux, with an explicit "not available on this platform" fallback if reliable chaining can't be set up.
- **Replace after backup** — the previous behavior: your existing `statusLine` is backed up (and can be restored on disable), then replaced by the AI Limit Ledger bridge.

Enabling is transactional: if any step fails (writing the wrapper, updating settings, verifying ownership), AI Limit Ledger restores your previous `statusLine` and leaves no partial files behind. `AI Limit Ledger: Disable Claude Code Integration` restores whatever `statusLine` existed before AI Limit Ledger was enabled, and refuses to overwrite it if something else has changed it since.

## Experimental: CLI-free Claude usage

If you only use the Claude Code VS Code sidebar and never run the CLI, the official status-line integration has nothing to read from and Claude shows as `manual-only` — a fully supported mode, not an error. To get automatic 5h/7d numbers without running the CLI, you can opt into the experimental transport:

1. Run **AI Limit Ledger: Enable CLI-free Claude Usage** (separate from, and not implied by, `Enable Claude Code Integration`).
2. Read the consent dialog — it explains exactly what will and will not happen to your token — and choose **Enable Experimental Usage**, or **Learn More** to open the full write-up first.
3. The Claude Dashboard card now shows `Account limits source: Experimental OAuth usage`, clearly labeled `Experimental — undocumented Anthropic usage endpoint`.
4. Run **AI Limit Ledger: Disable CLI-free Claude Usage** at any time to turn it back off; the official status-line integration is never affected.

This is off by default, may be rate-limited, and may stop working if Anthropic changes the endpoint — it calls `api.anthropic.com/api/oauth/usage`, the same undocumented endpoint Claude Code's own `/usage` command uses, not a public API. Full details: `docs/EXPERIMENTAL_CLAUDE_USAGE.md` (bundled with the extension).

## Official provider links

Dashboard, Safe Dashboard, and Command Palette actions use the read-only `ProviderLinkRegistry`. External links open only after an explicit user action and are handed to the default browser by `ProviderLinkService`.

- Codex: `https://chatgpt.com/codex/cloud/settings/analytics#usage`
- Claude: `https://claude.ai/settings/usage`

The Dashboard also offers **Open GitHub Copilot Billing** (`https://github.com/settings/billing`) and **Open Grok Billing** (`https://grok.com/?_s=billing`). **Open Grok** remains a separate action for the official home page; it is not a numeric usage page. AI Limit Ledger does not read browser sessions, cookies, page content, or redirects. These pages are fallback/detail views, not scraped data sources.

The current labels are **Open GitHub Copilot Billing** and **Open Grok Billing**. Grok billing is separate from **Open Grok**; the Grok home page is not a numeric usage page. Use `/usage` inside Grok Build for the official account view.

## GitHub Copilot connection

Run **AI Limit Ledger: Connect GitHub Copilot Usage**. VS Code GitHub Authentication is tried first. If it cannot satisfy the billing endpoint, choose **Use fine-grained PAT** and grant only **Plan: read**. Run **Disconnect GitHub Copilot Usage** to remove only AI Limit Ledger's own PAT secret. GitHub billing can lag behind individual Copilot requests, so the Dashboard says so explicitly.

## Grok Build usage

Grok is experimental and disabled until you run **Enable Grok Usage**. Install the official CLI from the xAI/Grok Build guide, sign in with `grok login` in the launched VS Code terminal, then run **Recheck Grok Installation**. The community `pawelhuryn.grok-vscode-phuryn` extension is detected as community-only and is never treated as the official billing source. Use `/usage` inside Grok Build for the official account view.

After a successful Repair, the Claude card shows **Restart Claude CLI session**. Close existing Claude CLI sessions, start a completely new one, and complete one response. A valid snapshot removes the restart/waiting message automatically.

## Troubleshooting

On Windows, ensure Codex is installed and signed in. Open **AI Limit Ledger: Show Logs** when App Server cannot start. The App Server protocol can evolve; missing fields display as `Not available` rather than breaking the UI.

### Claude usage limits not appearing

If the Dashboard shows **Repair required**, or Claude usage limits still aren't appearing after Enable:

1. Run **AI Limit Ledger: Diagnose Claude Code Integration** (`Ctrl+Shift+P`). Check that:
   - `Effective statusLine` is `present`
   - `Wrapper file` is `present` and `Wrapper hash match` is `yes`
   - `Wrapper self-check` is `passed`
   - `Integration state` is `ready` (not `repair-required`)
2. If `Integration state` is `repair-required`, run **AI Limit Ledger: Repair Claude Code Integration**. This is the same safe, idempotent transaction as Enable — it re-verifies ownership, regenerates a missing or stale wrapper, and reinstalls the statusLine if something external removed it, without disturbing an already-healthy integration.
3. Run Diagnose again and confirm `Integration state: ready` before continuing.
4. **Close every existing Claude Code CLI session** — a session already running has not reloaded the repaired configuration.
5. Open a completely new `claude` session and **complete one real response**. The status-line hook that writes usage data only fires with real data after a response finishes; a snapshot captured before that point will correctly show "Waiting for the first completed Claude CLI response containing rate-limit data," not an error.
6. Reopen (or wait a moment for) **AI Limit Ledger: Open Dashboard** — it updates live once a valid snapshot arrives, with no need to reopen the panel.

If usage still doesn't appear after a real completed response with a `ready` diagnostic state beforehand, use **Copy redacted diagnostics** and report the issue — the copied text never includes commands, raw JSON, credentials, or your full home directory path.

## Development setup

Requires a supported Node.js LTS line and npm 10+ (Node 24 preferred, Node 22 minimum — see `.nvmrc`/`.node-version` and `package.json`'s `engines.node`). Node 20 is end-of-life and unsupported for development.

```powershell
npm ci
npm run compile
```

Then launch the extension host with `F5` (or VS Code's "Run Extension" launch configuration) to try it in a development window.

## Test / build commands

```powershell
npm run compile        # TypeScript build
npm run lint            # ESLint
npm run format:check    # Prettier check
npm test                # Vitest test suite
npm run audit:release   # Offline manifest/lockfile/credential-pattern/VSIX audit
npm run package          # Builds out/ and packages a .vsix with vsce
```

The extension has **zero production dependencies**; all `devDependencies` are build/test/lint/package tooling only.

## Contribution

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, test expectations, localization (English/Turkish) requirements, and privacy/logging constraints that apply to this project. Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security reporting

Do not open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md) for how to report one privately.

## Known limitations

- Not published on the Visual Studio Code Marketplace yet; install from source only.
- Claude's CLI-free OAuth usage check and Grok's CLI-proxy billing fallback are both **experimental**, off by default, and depend on undocumented provider endpoints that may change or stop working without notice.
- GitHub Copilot billing can lag behind individual Copilot requests; the Dashboard states this explicitly rather than estimating.
- Some `npm audit` findings may appear in the future in dev-only tooling (`vitest`/`vite` chain); production dependencies are and will remain zero.
- Windows is the primary development and test target for the Claude status-line wrapper; macOS/Linux chaining has an explicit best-effort fallback rather than full parity.

## Roadmap

The items below are **planned, not committed**, and may change:

- GitHub Actions CI (compile/lint/format/test/audit on every PR and push to `main`).
- Branch protection and required status checks once CI exists.
- A Visual Studio Code Marketplace publisher and listing, with a GitHub Release-based install path.
- Additional provider support may be considered in the future; nothing beyond Codex, Claude Code, GitHub Copilot, and Grok is currently planned or implemented.

## License

[MIT](LICENSE)
