# Marketplace screenshot runbook

## Why this document exists

Task 13 prepares the Marketplace listing but does not fabricate product screenshots. This
non-interactive environment has no attached display, no VS Code Extension Development Host that
can be driven end-to-end, and no browser/GUI automation tool available to the agent that performed
this preparation — so no `assets/marketplace/*.png` files were generated or committed as part of
this task. Fabricating a "screenshot" by hand-drawing a UI mockup was explicitly out of scope,
since it would misrepresent the actual product.

This runbook lets a human with a normal desktop VS Code install produce the real screenshots
safely, using synthetic fixture data only — no real provider account, credential, or usage data.

## What is still missing

The following files are referenced by `docs/MARKETPLACE-LISTING.md` and
`docs/MARKETPLACE-ASSET-INVENTORY.md` as **pending** until this runbook is completed:

- `assets/marketplace/dashboard-dark-en.png`
- `assets/marketplace/dashboard-light-en.png`
- `assets/marketplace/dashboard-tr.png`
- `assets/marketplace/safe-dashboard-en.png`
- `assets/marketplace/statusbar-tooltip-en.png`

Treat this as an open blocker before any real Marketplace publish (Task 14) — see the PR
description for this task and `docs/MARKETPLACE-PREFLIGHT.md`.

## Ground rules (do not violate)

- Use only **synthetic, deterministic** fixture data — no real Codex/Claude/Copilot/Grok account,
  token, quota, dollar, or reset-time value.
- Use a **fixed, fake date/time** in the capture (do not show today's real date if the UI displays
  one anywhere reachable from a fixture).
- Do not show your real Windows username, email, organization name, session ID, or any file path
  containing your home directory. Use a clean VS Code profile with a neutral workspace name (e.g.
  `demo-workspace`) and a generic OS username if one appears anywhere in the captured area.
- Do not add any new setting, command, hidden "demo mode", or code path to the extension to make
  this easier. If the current UI cannot be driven into a representative state without a production
  code change, stop and note that as a blocker instead of adding one.
- Do not call any real provider API or CLI. Do not sign in to Codex/Claude/Copilot/Grok during the
  capture session.
- Never commit a placeholder, lorem-ipsum, or "coming soon" image. Either the screenshot is real
  (synthetic-data, real renderer) or the file stays absent.

## One-time setup

1. Use a **separate, disposable VS Code profile** so nothing here touches your real settings,
   installed extensions, or SecretStorage:
   ```powershell
   code --profile "AiLimitLedgerScreenshots" --new-window
   ```
2. In that profile, install the extension **from a locally built VSIX** (built by this task's own
   `npm run package`, not the Marketplace):
   ```powershell
   code --profile "AiLimitLedgerScreenshots" --install-extension ai-limit-ledger-0.6.2.vsix
   ```
3. Open a throwaway empty folder as the workspace (e.g. `demo-workspace`), not a real project.

## Producing deterministic synthetic provider data

The extension reads live provider state at runtime; it has no built-in "demo data" mode (and this
task intentionally does not add one — see Ground rules). To get a representative, safe dashboard
render without a real account, use the extension's own **Safe Dashboard** and status-bar tooltip
against providers left in their natural "not connected" / "not installed" state, or against a
provider you control with a disposable/test account you are comfortable showing (e.g. a personal
Codex/Claude account you don't mind partially exposing plan-tier and reset-time text for) — never
your primary work account.

If you want cards that show populated numeric values without using a real personal account, the
safest option is to only screenshot **not-connected / unavailable state** cards (which already
render safe placeholder text like "Not available", "Manual-only", "Connect GitHub Copilot Usage")
plus one populated card from a disposable test account whose plan/usage numbers you are fine
publishing publicly and permanently (Marketplace images are effectively public forever).

Do not edit numbers into a screenshot after capture (that would be a fabricated image, not a real
render) — if you need specific-looking numbers, get them from a disposable account's real state
and disclose in the alt text / asset inventory that the account is a disposable test account.

## Capturing each file

For every capture:

- Set VS Code's window zoom/DPI so the resulting PNG is close to **1440×900 or 1600×900**; crop
  tightly to the relevant panel (Dashboard webview, status bar segment, or tooltip popup) without
  including unrelated desktop, taskbar, terminal, or browser chrome.
- Use VS Code's built-in **"Developer: Screenshot"** command where possible for a clean capture of
  just the editor window, or your OS snipping tool cropped to the VS Code window only.
- Save as PNG (not JPEG) directly — do not re-export through an image editor that could add
  metadata; if you do use an editor, strip metadata before saving (see "Stripping metadata" below).

1. **`dashboard-dark-en.png`** — Command Palette → `AI Limit Ledger: Open Rich Dashboard`, with a
   dark VS Code theme (e.g. Dark+) and `aiLimitLedger.display.language` set to `en`. Capture the
   full Dashboard webview panel.
2. **`dashboard-light-en.png`** — same as above with a light VS Code theme (e.g. Light+).
3. **`dashboard-tr.png`** — same Rich Dashboard, `aiLimitLedger.display.language` set to `tr` (any
   theme; dark is consistent with the other two).
4. **`safe-dashboard-en.png`** — `AI Limit Ledger: Select Dashboard Mode` → `Safe Native`, then
   `AI Limit Ledger: Open Dashboard`; capture the resulting read-only text editor document.
5. **`statusbar-tooltip-en.png`** — hover over the AI Limit Ledger status bar item until the
   Markdown tooltip renders, and capture the status bar segment plus the tooltip popup together.

## Stripping metadata and doing a final safety pass

After capturing, before committing:

1. Strip PNG metadata (Windows has no PNG text chunks by default from most snipping tools, but
   verify with a metadata check, e.g. `exiftool -all= image.png` if available, or re-save through
   `node`'s built-in tools are not sufficient for this — use a metadata-aware tool and confirm no
   `tEXt`/`iTXt` chunk contains a username or path).
2. Visually re-check every pixel for: your real username, real email, real file paths, real
   account/org name, real token/session id fragments, and today's real date/time.
3. Re-run this repository's own audit over the new files once they exist:
   ```powershell
   npm run audit:release
   ```
   (extend `scripts/release-audit.mjs`'s asset checks to cover the new files if it does not already
   — see `docs/MARKETPLACE-ASSET-INVENTORY.md` for the expected per-file fields: format, dimensions,
   file size, SHA-256, synthetic-data confirmation, personal-data check, alt text.)
4. Update `docs/MARKETPLACE-ASSET-INVENTORY.md` with the real SHA-256, dimensions, and file size for
   each new file, and remove the "pending" note in `docs/MARKETPLACE-LISTING.md`.
5. Confirm each PNG is under ~1 MB; re-export at a lower DPI/crop if not.

## What NOT to do

- Do not hand-draw or mock up a fake UI in an image editor and call it a screenshot.
- Do not use a competitor's or another extension's screenshot as a placeholder.
- Do not commit an image before completing the safety pass above.
- Do not add a "screenshot mode" flag, environment variable, or hidden command to the production
  extension to make capture easier — do it through the same UI a real user would use.
