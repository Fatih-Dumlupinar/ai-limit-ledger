# Support

For missing insights, check `aiLimitLedger.dashboard.insightsMode` and the provider’s source/provenance label. `summary`, `detailed`, and `hidden` change rendering only and do not trigger refreshes. A missing Copilot denominator, Grok product breakdown, or Claude account/session field is an upstream limitation and is shown as unavailable rather than estimated. Codex daily insights retain at most 30 normalized days and display the latest 14 by default.

For settings issues, run **AI Limit Ledger: Copy Redacted Effective Settings** and attach that output together with **Copy Redacted Diagnostics**. It includes normalized display/provider/refresh/cache state and safe validation codes, but never executable paths, tokens, credentials, account identifiers, raw commands, or workspace paths. **Reset Display Settings** changes only presentation preferences; it does not change provider selection, credentials, or experimental consent.

To verify live localization, change `aiLimitLedger.display.language` between `tr` and `en` while the Dashboard is open. Runtime surfaces should update without Reload Window, using the existing snapshot. This presentation-only change must not create a provider refresh or network request. Command Palette and Settings contribution titles follow the VS Code display language and may require Reload Window because VS Code owns their manifest localization lifecycle.

For bugs, include the extension version, VS Code version, operating system, and redacted **AI Limit Ledger** Output Channel text. Never include tokens, account identifiers, email addresses, browser cookies, or page content.

Provider documentation, installation, settings, billing, and usage links come from one fixed registry. They open only after an explicit user action in the default browser; the extension does not ping them during activation or dashboard rendering, append account data, or transmit credentials to them. Authenticated pages require browser sign-in.

For a Claude repair report, first run **Diagnose Claude Code Integration**, then close old Claude CLI sessions, start a new session, and complete one response. For Codex, run **Diagnose Codex Integration** and follow its safe recommended action. The official usage-page buttons only open the corresponding browser page; they are not scraped usage sources.

For GitHub Copilot, run **Diagnose GitHub Copilot Integration** and confirm the GitHub token has only Plan: read. Copilot CLI installation is optional and is not required for usage data. For Grok, run **Diagnose Grok Integration**, **Recheck Grok Installation**, and confirm the official CLI login in the VS Code terminal. Use `/usage` inside Grok Build for the official account view. The community Grok extension is not an official billing source. Never include tokens, PATs, auth-file contents, prompts, transcripts, or code in a report.

For the experimental **CLI-free Claude Usage** transport, see `docs/EXPERIMENTAL_CLAUDE_USAGE.md` (bundled with the extension). It is off by default; if it stops working after an Anthropic-side change, disabling it with **AI Limit Ledger: Disable CLI-free Claude Usage** never affects the official status-line integration. Never include your OAuth token in a bug report — AI Limit Ledger itself never logs or displays it, so it should not appear in any Output Channel text you copy.

The experimental usage check is a bodyless account-usage `GET`, not a model/messages request. It is limited to the allowlisted usage host/path, has a 120-second minimum interval, and uses the documented 429 backoff.
