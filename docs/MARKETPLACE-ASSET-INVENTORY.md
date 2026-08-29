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

## Marketplace screenshots — optional, not currently added

Screenshots are an **optional** Marketplace enhancement, not a requirement — the VS Code Marketplace
has no manifest field for them and no publishing rule that requires them (verified against the
current official publishing/manifest documentation). The listing is complete and publishable from
`README.md` content alone. The five files below are **not currently present**; that is a normal,
supported state, not an open item. No placeholder or mock image has been committed in their place,
and none should ever be — if added, each must be a real render of the extension UI using synthetic
fixture data only. See `docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md` for the optional capture procedure.

| File                                          | Purpose                                  | Planned format          | Planned size | Included in VSIX (planned)        |
| --------------------------------------------- | ---------------------------------------- | ----------------------- | ------------ | --------------------------------- |
| `assets/marketplace/dashboard-dark-en.png`    | Rich Dashboard, dark theme, English      | PNG, ~1440×900–1600×900 | ≤1 MB        | No (excluded via `.vscodeignore`) |
| `assets/marketplace/dashboard-light-en.png`   | Rich Dashboard, light theme, English     | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |
| `assets/marketplace/dashboard-tr.png`         | Rich Dashboard, Turkish                  | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |
| `assets/marketplace/safe-dashboard-en.png`    | Safe (webview-free) Dashboard, English   | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |
| `assets/marketplace/statusbar-tooltip-en.png` | Status bar item + hover tooltip, English | PNG, ~1440×900–1600×900 | ≤1 MB        | No                                |

Planned data source for all five, if this optional enhancement is ever done: the real extension
renderer (Rich/Safe Dashboard, status bar, tooltip), driven manually against synthetic/disposable-
account data — never a hand-drawn mockup and never real personal account/quota data. Planned
personal-data check: manual pixel review plus metadata stripping before commit, both described in
the runbook.

If any of these files are added later, fill in this inventory's row with the real
format/dimensions/size/SHA-256/alt text, and update `docs/MARKETPLACE-LISTING.md`'s Screenshots
section to match. Adding them is never a precondition for a Marketplace publish.

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
