# Publishing checklist

Task 12 does not publish a release, upload a Marketplace artifact, or configure automatic
publishing. The CI package job creates a short-retention validation artifact only; it never runs
`vsce publish`. Ruleset configuration and any future publish workflow remain separate, manually
reviewed work.

This extension is not published yet. It is an unofficial community extension and must never imply OpenAI endorsement.

1. Create an Azure DevOps / Visual Studio Marketplace publisher and choose a unique publisher ID.
2. Check Marketplace name uniqueness before the first release.
3. Change `package.json` `publisher` from `local` only after the publisher ID is known.
4. Create a local-only PAT with **Marketplace: Manage**; never put it in this repository, prompts, or logs.
5. Run `vsce login <publisher-id>`, then `vsce package` and `vsce publish`.
6. For updates, increment the version, update CHANGELOG, run tests/package, then publish. The current development artifact is `ai-limit-ledger-0.6.2.vsix`.
7. Before publishing, run both `npm audit` (requires npm registry network access — checks known advisories against the resolved dependency tree) and `npm run audit:release -- <file>.vsix` (a separate, dependency-free, fully offline local/VSIX content check) against the freshly packaged VSIX and confirm the latter reports zero `fail` findings (see `docs/RELEASE-READINESS-0.6.2.md`). These two commands check different things and neither substitutes for the other.
8. Build and test on a supported Node LTS (Node 24 preferred, Node 22 minimum — see `.nvmrc`/`package.json` `engines.node`); Node 20 is end-of-life and unsupported for development.

Before a future publish, first complete the ruleset checks documented in `docs/BRANCH-RULESET.md`
and confirm that the Task 12 CI, CodeQL, Secret Scan, and Dependency Review checks are green. Do
not add Marketplace credentials to CI or to this repository.

Before publishing 0.6.x, verify the Marketplace description clearly says that Copilot uses the official GitHub Billing REST API plus VS Code auth or an explicit Plan-read PAT, and that Grok tries the official `x.ai/billing` ACP method first while its CLI-proxy fallback is experimental and opt-in. Do not imply xAI, GitHub, OpenAI, or Anthropic endorsement.

Before publishing, add Marketplace screenshots for normal, compact, warning, critical, unavailable, tooltip, and details-panel states.
