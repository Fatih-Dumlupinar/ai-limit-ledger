# Task 14.3 UI/UX review runbook

This runbook is for the manual review of the status bar, tooltips, Rich Dashboard, and Safe Native
Dashboard. Use synthetic snapshots only. Do not sign in to a provider, copy a credential, or make a
provider request from the development host.

## Prepare an isolated host

1. Use Node 22.12 or Node 24 (`.nvmrc` is the preferred version), then run `npm ci` and
   `npm run compile`.
2. Start **Run Extension — Clean Development Host** from `.vscode/launch.json`. It uses the
   repository-local `.tmp/vscode-dev/` settings, extensions, and user data directories.
3. Keep the normal VS Code profile closed or untouched. Use the existing test fixtures and
   synthetic snapshots to exercise provider states.

## Fixture matrix

| Fixture                                             | Expected presentation                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Healthy Codex with one five-hour window             | One primary percentage, one reset, one short freshness line.                                          |
| Healthy Claude with five-hour and seven-day windows | Five-hour first; account-limit labels stay separate and both resets are visible once.                 |
| Claude with `experimental-oauth` metadata           | Experimental provenance is explicit and does not overwrite the official-source case.                  |
| Copilot with `used: 0` and no allowance             | `0` credits is retained; no fabricated percentage or progress bar.                                    |
| Copilot with finite used and allowance              | Monthly AI credits is the only derived quota window; denominator is visible through the shared model. |
| Official Grok with no numeric usage                 | Official provenance remains official; no fake percentage or bar.                                      |
| Stale or rate-limited snapshot with last-known data | Stale/last-known-good state is prominent; freshness expands to useful timestamp details.              |
| Error snapshot with an actionable message           | The message is preserved and status/action context remains visible.                                   |

## Surface checks

Review each fixture in English and Turkish, and in both light and dark themes where available.
Repeat the narrow-window review with a compact tooltip and a narrow dashboard width.

- Status bar: the provider name, current percentage/state, and reset hierarchy are readable without
  dashboard-only detail.
- Compact tooltip: at most two windows; no Markdown table, usage-insight section, refresh mechanics,
  duplicate percentage, or duplicate relative/absolute reset.
- Detailed tooltip: quota blocks precede insights; at most three insight rows are shown; plan,
  reset, freshness, and provenance are not repeated; refresh mechanics remain secondary.
- Rich Dashboard: each quota window has one accessible progressbar, one visible percentage, one reset,
  localized severity, and no repeated primary percentage above the same bar.
- Safe Native Dashboard: its text hierarchy matches Rich Dashboard semantics, including Claude
  session/account grouping and one source-provenance summary.
- Accessibility/CSP: progressbars have `role`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`,
  and `aria-valuetext`; action state and correlation attributes remain present; there are no inline
  event handlers or raw provider payload fields.

## Automated evidence

Run the repository checks from the task branch:

```powershell
npm run compile
npm run lint
npm run format:check
npm run verify:workflows
npm run audit:privacy
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
npm test
```

The Task 14.3 regression suite is `test/Task14_3TooltipDashboardUx.test.ts`; it covers the shared
presentation model, all four providers, EN/TR output, density, reset/freshness deduplication,
accessibility, CSP, privacy, and action state. Do not use live provider payloads as fixtures.
