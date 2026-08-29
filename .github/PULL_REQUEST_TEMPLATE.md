## Summary

<!-- What does this PR change, and why? -->

## Checklist

- [ ] `npm run compile` passes
- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes
- [ ] `npm test` passes (three consecutive full runs if source/runtime/test-infra changed)
- [ ] Localization: new/changed user-facing strings added to **both** `package.nls.json` and `package.nls.tr.json` (or N/A)
- [ ] Rich Dashboard and Safe Dashboard stay in parity for any changed field (or N/A)
- [ ] Status bar impact considered (compact/detailed/hidden modes) (or N/A)
- [ ] Privacy: no new credential/token/prompt/transcript/account-identifier storage or logging introduced
- [ ] Logging: no raw provider response, credential, or absolute personal path is logged
- [ ] Network: any new network host is HTTPS-only, exact-host-allowlisted, and documented below
- [ ] Provider provenance: official vs. experimental vs. calculated data is correctly labeled (see `CONTRIBUTING.md`)
- [ ] Documentation updated (`README.md` / `README.tr.md` / `docs/`) if user-facing behavior changed
- [ ] `CHANGELOG.md` updated
- [ ] No real credentials, tokens, or personal paths used in tests or fixtures (fixture/placeholder markers only)
- [ ] No raw provider response was logged or committed during development of this change
- [ ] `out/`, `dist/`, `coverage/`, `.vsix`, and audit scratch files are not included in this diff
- [ ] Any new dependency is justified below (or N/A — no new dependency)

## New network access (if any)

<!-- Host, endpoint, why it's needed, official vs. experimental, consent gating -->

## New dependency (if any)

<!-- Package, why it's needed, why an existing dependency/built-in can't do it -->

## Breaking changes

<!-- Any change to settings keys/defaults, command IDs, or public behavior. "None" if not applicable. -->

## Test plan

<!-- How did you verify this? -->
