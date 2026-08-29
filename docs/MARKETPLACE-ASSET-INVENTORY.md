# Marketplace asset inventory

Generated/verified as part of Task 13 (VS Code Marketplace listing preparation). Re-run the
hash/dimension checks any time an asset file changes; do not hand-edit the SHA-256 values.

## Icon

| Field               | Value                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| File                | `assets/icon.png`                                                                                                   |
| Purpose             | Extension icon (`package.json` `icon` field, and Marketplace listing icon)                                          |
| Format              | PNG (validated signature: `89 50 4E 47 0D 0A 1A 0A`)                                                                |
| Dimensions          | 1024×1024                                                                                                           |
| File size           | 743781 bytes (~727 KB)                                                                                              |
| SHA-256             | `0daa32e6ecec453d498d18a25317868ffab938eaa234ad6b04091f8b150721d2`                                                  |
| Included in VSIX    | Yes — required by `package.json`'s `icon` field and listed in `scripts/release-audit.mjs`'s `REQUIRED_SOURCE_FILES` |
| Data source         | Static design asset, not a rendered screenshot; contains no account/session/user data                               |
| Personal-data check | Pass — static artwork, no embedded metadata scanned for personal paths                                              |
| Alt text            | "AI Limit Ledger extension icon"                                                                                    |

Exceeds the Marketplace minimum of 128×128 (256×256 for Retina) by a wide margin.

## Marketplace screenshots — pending

The following files are **not yet produced**. No placeholder or mock image was committed in their
place; per Task 13's scope, they were not fabricated because this environment has no display or GUI
automation tool available to capture a real render of the extension UI. See
`docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md` for the exact manual steps a person with a desktop VS Code
install should follow, using synthetic fixture data only.

| File                                          | Purpose                                  | Planned format          | Planned size | Included in VSIX (planned)        |
| --------------------------------------------- | ---------------------------------------- | ----------------------- | ------------ | --------------------------------- |
| `assets/marketplace/dashboard-dark-en.png`    | Rich Dashboard, dark theme, English      | PNG, ~1440×900–1600×900 | ≤1 MB        | No (excluded via `.vscodeignore`) |
| `assets/marketplace/dashboard-light-en.png`   | Rich Dashboard, light theme, English     | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |
| `assets/marketplace/dashboard-tr.png`         | Rich Dashboard, Turkish                  | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |
| `assets/marketplace/safe-dashboard-en.png`    | Safe (webview-free) Dashboard, English   | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |
| `assets/marketplace/statusbar-tooltip-en.png` | Status bar item + hover tooltip, English | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |

Planned data source for all five: the real extension renderer (Rich/Safe Dashboard, status bar,
tooltip), driven manually against synthetic/disposable-account data — never a hand-drawn mockup and
never real personal account/quota data. Planned personal-data check: manual pixel review plus
metadata stripping before commit, both described in the runbook.

This inventory's screenshot rows must be filled in with real format/dimensions/size/SHA-256/alt
text once the runbook is completed, and `docs/MARKETPLACE-LISTING.md`'s screenshot list updated to
match, before a real Marketplace publish is attempted (Task 14).

## VSIX packaging policy for Marketplace assets

`vsce` (when `package.json.repository` points at a public GitHub repository, as it does here)
rewrites _relative_ image paths inside the packaged README to absolute
`https://github.com/<owner>/<repo>/raw/<branch>/<path>` HTTPS URLs automatically, rather than
requiring the images to be present inside the VSIX itself. This means:

- Marketplace screenshots can live in the repository (under `assets/marketplace/`) for the
  Marketplace listing page to render, and version control / provenance history, **without** being
  duplicated into the packaged `.vsix` — keeping the installable package small.
- `.vscodeignore` excludes `assets/marketplace/**` from the VSIX (see the `.vscodeignore` diff in
  this task) for exactly this reason; `assets/icon.png` remains included because the `icon` manifest
  field requires the file to exist inside the package itself, not just be reachable over HTTPS.
- Once real screenshots exist, verify with `npx vsce ls` (lists packaged files) and by inspecting
  the packaged `extension/readme.md` for `https://github.com/.../raw/main/assets/marketplace/...`
  URLs before any publish — this task does not publish, so that verification is deferred to Task 14
  or to whoever completes the runbook, whichever comes first.
