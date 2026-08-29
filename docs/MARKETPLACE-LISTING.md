# Marketplace listing reference

This document is the single source of truth for the intended Visual Studio Marketplace listing
metadata. It does not itself publish anything — see `docs/MARKETPLACE-PREFLIGHT.md` for the manual
checklist to run before any future `vsce publish` (Task 14 or later).

## Identity

| Field                  | Value                                 |
| ---------------------- | ------------------------------------- |
| Publisher ID           | `fatihdumlupinar-dev`                 |
| Publisher display name | Fatih Dumlupınar Dev                  |
| Extension package name | `ai-limit-ledger`                     |
| Permanent extension ID | `fatihdumlupinar-dev.ai-limit-ledger` |
| Display name           | AI Limit Ledger                       |
| Version                | 0.6.2                                 |
| Preview                | `true` (first Marketplace release)    |

The permanent extension ID (`fatihdumlupinar-dev.ai-limit-ledger`) cannot be changed after first
publish — the publisher segment is fixed once a publisher account is created, and the package
`name` segment is fixed once the first version is published under it.

## Short description

> Monitor Codex, Claude Code, GitHub Copilot, and Grok usage, quotas, and reset times from the VS
> Code status bar and dashboard — privacy-first, no telemetry.

(Matches `package.json`'s `%extension.description%` NLS string; kept under the ~200-character
Marketplace short-description guidance.)

## Long description structure

The English `README.md` is the Marketplace long-description source (Marketplace renders a
package's README as its main page). Section order, as restructured for Task 13:

1. Title, Turkish-README link, CI/CodeQL badges
2. One-sentence value proposition
3. Preview-status callout
4. Screenshot placeholders — pending, see `docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md`
5. "Why AI Limit Ledger?"
6. Supported provider matrix
7. Core features
8. Quick start
9. Dashboard and status bar
10. Provider requirements
11. Official / experimental / derived provenance explanation
12. Privacy and security
13. What this extension reads
14. What this extension does not read or store
15. Settings
16. Commands
17. Known limitations
18. Troubleshooting
19. Support
20. Non-affiliation notice
21. Turkish README link
22. License

## Categories

`Other`, `Visualization` — both on the current VS Code Marketplace category allowlist. The
extension is explicitly **not** categorized as `Machine Learning`: it reads provider-reported usage
metadata (quota percentages, reset timestamps, session/account fields) and never performs model
inference, prompt/completion handling, or any ML task itself.

## Keywords (16 of a 30 max)

`ai usage`, `usage monitor`, `quota`, `rate limit`, `rate limits`, `reset time`, `token usage`,
`codex`, `chatgpt`, `claude code`, `github copilot`, `grok`, `privacy`, `developer tools`,
`status bar`, `usage dashboard`.

No duplicates; provider names (`codex`, `chatgpt`, `claude code`, `github copilot`, `grok`) are
included only for legitimate interoperability/discovery — the listing text carries an explicit
non-affiliation notice so this is not read as an endorsement claim.

## Q&A

`qna` is left unset in `package.json`, which defaults to the Marketplace's own built-in Q&A tab.
This project does not use GitHub Discussions (not enabled on the repository), so `qna` is
intentionally not pointed at a GitHub Discussions URL. Support routes to GitHub Issues and
`SUPPORT.md` instead (see Support below).

## Links

| Field      | Value                                                                            |
| ---------- | -------------------------------------------------------------------------------- |
| Repository | `https://github.com/Fatih-Dumlupinar/ai-limit-ledger`                            |
| Homepage   | `https://github.com/Fatih-Dumlupinar/ai-limit-ledger#readme`                     |
| Issues     | `https://github.com/Fatih-Dumlupinar/ai-limit-ledger/issues`                     |
| Support    | `SUPPORT.md` (bundled) + GitHub Issues                                           |
| Privacy    | `PRIVACY.md` (bundled)                                                           |
| Security   | `SECURITY.md` (bundled) — private reporting, no public issue for vulnerabilities |
| License    | MIT — `LICENSE` (bundled)                                                        |

## Non-affiliation

Both `README.md` and `README.tr.md` carry an explicit non-affiliation notice:

> AI Limit Ledger is an independent project and is not affiliated with, endorsed by, or sponsored
> by Microsoft, GitHub, OpenAI, Anthropic, or xAI.

No provider logos are used anywhere in the listing, icon, or screenshots — only text references to
provider/product names for interoperability and discovery.

## Screenshots

See `docs/MARKETPLACE-ASSET-INVENTORY.md` for the authoritative per-file table. Summary:

| File                                          | Alt text                                                                                                                     | Status                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `assets/marketplace/dashboard-dark-en.png`    | "AI Limit Ledger Rich Dashboard, dark theme, showing Codex, Claude Code, GitHub Copilot, and Grok provider cards in English" | Pending — see runbook |
| `assets/marketplace/dashboard-light-en.png`   | "AI Limit Ledger Rich Dashboard, light theme, English"                                                                       | Pending — see runbook |
| `assets/marketplace/dashboard-tr.png`         | "AI Limit Ledger Rich Dashboard in Turkish"                                                                                  | Pending — see runbook |
| `assets/marketplace/safe-dashboard-en.png`    | "AI Limit Ledger Safe Dashboard read-only text view, English"                                                                | Pending — see runbook |
| `assets/marketplace/statusbar-tooltip-en.png` | "AI Limit Ledger status bar item with hover tooltip showing per-provider usage, English"                                     | Pending — see runbook |

## Provider capability summary (for listing copy)

| Provider       | Source                                                                    | Notes                                              |
| -------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Codex          | Official, local App Server only                                           | No network calls beyond the local App Server       |
| Claude Code    | Official status-line integration                                          | OAuth usage check is experimental, off by default  |
| GitHub Copilot | Official GitHub Billing REST API                                          | Requires VS Code GitHub auth or a Plan-read PAT    |
| Grok           | Official Grok Build ACP transport, experimental `x.ai/billing` capability | CLI-proxy fallback is also experimental and opt-in |

Full detail: `docs/PROVIDER_CAPABILITY_MATRIX.md`.

## Fields to re-check directly in the Marketplace publisher portal (not verifiable offline)

This document and `scripts/release-audit.mjs` verify everything checkable from the source tree.
The following can only be confirmed by someone with access to
`https://marketplace.visualstudio.com/manage/publishers/fatihdumlupinar-dev` at actual publish time
(Task 14), and are explicitly out of scope for Task 13:

- Final Marketplace-side rendering of the README (image URLs, table formatting, badge rendering).
- Whether the publisher display name ("Fatih Dumlupınar Dev") renders as intended.
- Marketplace's own live uniqueness check for `fatihdumlupinar-dev.ai-limit-ledger` at publish time
  (offline search found no existing `ai-limit-ledger` package name or "AI Limit Ledger" display name
  on the public Marketplace as of this task, but that is a point-in-time result, not a guarantee).
- Any Marketplace content-policy review outcome (manual human review after first publish).
