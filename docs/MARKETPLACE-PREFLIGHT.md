# Marketplace publish preflight checklist

Manual checklist to run **before any real Marketplace publish**. Task 13 prepares every item below
that can be prepared without authenticating to the Marketplace or running `vsce publish`; it does
not execute the checklist end-to-end because publishing itself is out of scope (see "Deferred to
Task 14" at the bottom).

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
      is documented (see "Installation status" section of the README and
      `PUBLISHING.md`'s identity-change note) — the actual migration itself is **deferred to
      Task 14**, not performed here.

## Authentication

- [ ] Deferred to Task 14 — Marketplace authentication (PAT or Microsoft Entra workload identity /
      GitHub OIDC) is intentionally not set up, requested, or stored as part of Task 13.

## Release approval

- [ ] A human with publisher-portal access has reviewed this checklist and explicitly approved
      the specific commit/tag to publish.

## Rollback readiness

- [ ] A rollback/unpublish procedure is documented before the first real publish (deferred to
      Task 14 — Marketplace supports unlisting/deprecating a version, not deleting Marketplace
      history; know this before publishing).

---

## Deferred to Task 14 (explicitly out of scope here)

- Marketplace authentication (PAT creation, Microsoft Entra workload identity, GitHub OIDC)
- Manual-approval release environment / release workflow
- Version bump / git tag workflow
- GitHub Release creation
- `vsce publish` / Marketplace upload
- The first real publish
- Controlled local-extension-identity-to-Marketplace-identity installation migration
- Rollback / unpublish procedure execution
