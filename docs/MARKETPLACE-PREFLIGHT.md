# Marketplace publish preflight checklist

Manual checklist to run **before any real Marketplace publish**. Task 13 prepared every item below
that could be prepared without authenticating to the Marketplace or running `vsce publish`. Task 14
adds the release-candidate/finalize workflows this checklist plugs into (see "How this checklist is
executed" at the bottom) — the manual Marketplace upload itself is still a human action, not
something either workflow performs.

Check every box against the actual state of the branch/tag being published, not from memory.

## Publisher identity

- [ ] `package.json` `publisher` is exactly `fatihdumlupinar-dev`.
- [ ] The Marketplace publisher `fatihdumlupinar-dev` exists and its display name is
      "Fatih Dumlupınar Dev" (verify in the publisher portal — not checkable offline).
- [ ] No other person/bot has been added to the publisher without the owner's knowledge.

## Extension identity

- [ ] `package.json` `name` is exactly `ai-limit-ledger`.
- [ ] Resulting permanent extension ID is `fatihdumlupinar-dev.ai-limit-ledger`.
- [ ] `displayName` NLS string resolves to `AI Limit Ledger`.
- [ ] No existing Marketplace listing collides on package name or display name (re-check live at
      publish time, not just against this task's point-in-time search).

## Version

- [ ] `package.json`, `package-lock.json` root, and `package-lock.json` `packages['']` versions
      all agree.
- [ ] The version has a corresponding, first (most recent) `CHANGELOG.md` entry.
- [ ] The version being published has not already been published under this publisher (Marketplace
      rejects re-publishing an existing version number).

## README

- [ ] `README.md` (English) renders correctly as the Marketplace long description.
- [ ] `README.tr.md` is linked from the top of `README.md` and carries the same section semantics.
- [ ] No section makes an overstated claim (see the "must not claim" list in `README.md`'s privacy
      section and this task's PR description).
- [ ] All internal doc links (`docs/...`, `SECURITY.md`, `PRIVACY.md`, `SUPPORT.md`) resolve.

## Screenshots

**Optional: real product screenshots may be added later.** The VS Code Marketplace has no manifest
field for screenshots and no publishing rule that requires them — this is not a publish gate, and a
missing screenshot must never block or delay a release.

- [ ] (Only if any screenshot exists) Each screenshot was produced via
      `docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md` and contains only synthetic/disposable-account data,
      never a real username, email, file path, account ID, or unredacted quota value.
- [ ] (Only if any screenshot exists) It has a real SHA-256/dimensions/size recorded in
      `docs/MARKETPLACE-ASSET-INVENTORY.md`.

## Links

- [ ] `repository`, `bugs.url`, `homepage` in `package.json` all point at
      `Fatih-Dumlupinar/ai-limit-ledger`.
- [ ] All README image links use HTTPS (no `http://`, `file://`, or local/absolute paths).
- [ ] `npx vsce ls` / packaged `readme.md` shows relative image paths correctly rewritten to
      `https://github.com/Fatih-Dumlupinar/ai-limit-ledger/raw/main/...` URLs.

## License

- [ ] `LICENSE` file present, MIT, matches `package.json` `license` field.

## Privacy

- [ ] `PRIVACY.md` is current for the version being published (no undocumented new data read).
- [ ] README's "what this extension reads" / "does not read" sections match `PRIVACY.md`.

## Security

- [ ] `SECURITY.md` private-reporting instructions are current and functional.
- [ ] `npm audit` and `npm audit --omit=dev` show no unaddressed findings above the project's
      documented risk register threshold (`docs/DEPENDENCY-RISK-REGISTER.md`).
- [ ] CI, CodeQL, Secret Scan, and Dependency Review checks are green on the commit being published.

## Support

- [ ] `SUPPORT.md` is current and does not reference removed commands/settings.
- [ ] Issues link resolves to a repository that accepts issues.

## Changelog

- [ ] `CHANGELOG.md`'s top entry matches the version being published and is not still under
      `[Unreleased]`.

## Provider limitations

- [ ] Listing text and README correctly describe official vs. experimental sources for every
      provider (Codex, Claude Code, Copilot, Grok) — see `docs/PROVIDER_CAPABILITY_MATRIX.md`.
- [ ] No claim implies a provider integration is more complete/official than it is.

## Non-affiliation

- [ ] Non-affiliation notice present, unmodified in meaning, in both README files.
- [ ] No provider logo/trademark image used anywhere in the listing.

## VSIX audit

- [ ] `npm run package` produces `ai-limit-ledger-<version>.vsix`.
- [ ] `npm run audit:release -- <file>.vsix` reports **zero** `fail` findings.
- [ ] Manual VSIX content review: no `scripts/**`, no test fixtures, no `.nvmrc`/`.node-version`,
      no `.github/**`, no credentials, no personal paths (see this task's VSIX audit results for the
      current baseline expectations).

## Installation migration

- [ ] Confirmed that a controlled local-to-Marketplace installation migration procedure exists and
      is documented (`docs/INSTALLATION-MIGRATION-0.7.0.md`, the "Installation status" section of
      the README, and `PUBLISHING.md`'s identity-change note) — the actual migration itself is a
      manual, user-driven action taken after the Marketplace version is live, not performed by
      this checklist or either release workflow.

## Authentication

- [ ] No Marketplace PAT, `VSCE_PAT`, or other publishing credential exists anywhere in this
      repository, its Actions secrets, or its workflows (Task 14 deliberately does not create one).
      The Marketplace upload in this checklist is always the manual VSIX upload path.

## Release approval

- [ ] A human with publisher-portal access has reviewed this checklist and explicitly approved
      the specific commit/candidate to publish.
- [ ] The `production-release` GitHub Environment has at least one required reviewer configured
      (repository owner action, not created by either release workflow).

## Rollback readiness

- [ ] `docs/ROLLBACK.md` has been read for the specific failure mode before taking any corrective
      action — Marketplace supports unlisting/deprecating a version, not deleting Marketplace
      history or re-using a version number.

---

## How this checklist is executed (Task 14 and later)

See `docs/RELEASE-PROCESS.md` for the full procedure. In summary:

- `.github/workflows/release-candidate.yml` (`workflow_dispatch` only) builds, tests, audits, and
  packages the exact `main` commit and uploads a candidate artifact with its SHA-256, an SBOM, and
  a release manifest. It never tags, releases, or publishes.
- The Marketplace upload itself is always manual — this checklist, `docs/RELEASE-PROCESS.md`, and
  `docs/FIRST-MARKETPLACE-RELEASE-0.7.0.md` are what a human works through to do it.
- `.github/workflows/finalize-release.yml` (`workflow_dispatch` only, gated behind the
  `production-release` environment and a strict input allowlist) re-verifies the candidate against
  the confirmed commit/hash and only then creates the git tag and GitHub Release.
- `docs/INSTALLATION-MIGRATION-0.7.0.md` covers the local-identity-to-Marketplace-identity
  installation migration; it remains a manual, user-driven action, not something either workflow
  performs.
- `docs/ROLLBACK.md` covers every rollback/failure scenario; neither workflow force-moves a tag,
  overwrites a release asset, or unpublishes a Marketplace version.
