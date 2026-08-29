# AI Limit Ledger 0.7.0 — first Marketplace release (Preview)

This is the first version of AI Limit Ledger published on the Visual Studio Marketplace. The
manifest keeps `"preview": true` for this release — it is published through the standard
Marketplace channel (not `vsce --pre-release`), and this GitHub Release is marked pre-release only
to reflect that same preview status.

## What it does

- Monitors usage/quota/reset information for Codex, Claude Code, GitHub Copilot, and Grok from the
  VS Code status bar and a Dashboard, in either a Rich (Webview) or a Safe Native presentation.
- Live EN/TR display-language switching, without reopening the Dashboard.
- Provider-scoped usage insights, built from an explicit allowlist of safe fields — never raw
  provider payloads, credentials, tokens, prompts, or transcripts.
- Every provider integration is explicitly labeled as official or experimental, and the extension
  states its source/provenance for each value shown.

## Please read before relying on a number

- Claude session metrics reflect the most recently observed CLI session, not an account-wide
  total.
- GitHub Copilot's allowance may not be available on an organization-managed account — usage-only
  data is shown in that case.
- Grok Free accounts may not expose a numeric usage percentage from the official source.
- Experimental provider endpoints (marked as such in the Dashboard) may change or stop working
  without notice from the provider.
- AI Limit Ledger never calls a model/inference endpoint to read usage — only documented
  account/usage endpoints or local files the provider's own CLI already writes.
- Units are never combined or compared across providers.

## Privacy and security

No credentials are read beyond what each provider's own official integration requires (see
`PRIVACY.md` and `SECURITY.md`, both bundled with the extension). This release adds no new data
collection — it adds a secure, manual-approval release pipeline (see `docs/RELEASE-PROCESS.md`)
with no Marketplace publishing token stored or used by any GitHub Actions workflow.

## Screenshots

Marketplace screenshots are optional and are not included in this release — the VS Code
Marketplace has no manifest field for them and no publishing requirement that they exist. This is
a fully supported, publishable state (see `docs/MARKETPLACE-PREFLIGHT.md`).

## Installing

Install from the Visual Studio Marketplace listing for `fatihdumlupinar-dev.ai-limit-ledger`. If
you previously installed a development build under the `local.ai-limit-ledger` identity, read
`docs/INSTALLATION-MIGRATION-0.7.0.md` first — VS Code treats the two as separate extensions.
