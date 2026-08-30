# AI Limit Ledger 0.7.1 — reusable release process and development environment (Preview)

This is a process and documentation release. **No provider, runtime, status bar, or dashboard
behavior changes in 0.7.1.** It makes the release machinery introduced in 0.7.0 reusable for every
future version, ships a complete VS Code development environment for contributors, and corrects
installation documentation that became wrong the moment 0.7.0 went live on the Marketplace.

The manifest keeps `"preview": true`, and the GitHub Release is marked pre-release to reflect that
same preview status.

## Release process

The publishing decision is unchanged and deliberate: **the Marketplace upload is manual, performed
by the repository owner from the publisher management page.** No workflow in this repository holds,
requests, or is capable of using a `VSCE_PAT`, an Azure DevOps PAT, a Marketplace token, `vsce
login`, `vsce publish`, `--oidc`, or any other publishing credential. GitHub Actions automates only
the build, the audit, and — after a human has verified the Marketplace listing — the annotated ref
and the GitHub Release.

- Both release workflows are now **version-generic**. `Release Candidate` and `Finalize Release`
  accept the version as a dispatch input instead of carrying a frozen `0.7.0` constant, and the
  policy verifier now fails the build if either workflow reintroduces one.
- The version input is validated against a single anchored grammar, `^[0-9]+\.[0-9]+\.[0-9]+$`, in
  the first step that touches it. A `v` prefix, a two-part `0.7`, a prerelease or build-metadata
  suffix, `latest`/`main`, an empty value, or anything carrying a shell metacharacter fails the run
  before the value can reach a file path, a jq filter, an artifact name, or a ref name. Every
  dispatch input arrives through `env:` and is never interpolated into a shell body.
- The Marketplace confirmation phrase is now derived from the validated version —
  `I_HAVE_VERIFIED_MARKETPLACE_<version>` — so last release's confirmation can never finalize the
  next one.
- `Release Candidate` gained preflight gates: the `CHANGELOG.md` section for the version must
  exist, `docs/RELEASE-NOTES-<version>.md` must exist and be non-empty, the `[Unreleased]` section
  must be preserved, and a candidate is refused outright if the release ref already exists.
- `Finalize Release` now verifies that the candidate artifact contains exactly the five expected
  files and nothing else, in addition to the existing hash, manifest, publisher, extension-ID, and
  `main`-ancestry checks.

## Development environment

- `.vscode/launch.json` now offers **Run Extension — Clean Development Host** as the default F5
  profile. It runs the working tree's build in an Extension Development Host with its own
  `--user-data-dir` and `--extensions-dir` under the gitignored `.tmp/vscode-dev/`, resolved
  through `${workspaceFolder}` so no developer's home directory appears anywhere. It never copies
  your SecretStorage, never signs in to a real provider, and never changes a global VS Code
  setting — your normal profile keeps running the stable Marketplace build.
- Added `.vscode/tasks.json` (Install Dependencies, Compile, Watch, Test, Test Watch, Lint, Format
  Check, Verify Workflows, npm Audit, Release Audit, Package VSIX, Full Local Check), all
  delegating to `package.json` scripts. There is deliberately no publish or release task.
- Added `.vscode/extensions.json` recommending only ESLint, Prettier, and the official GitHub
  Actions extension, and `.vscode/settings.json` with workspace-scoped settings only.
- Added the `test:watch`, `audit:release:packaged`, and `check:local` npm scripts.
- Added [`docs/DEVELOPMENT.md`](DEVELOPMENT.md), covering the toolchain, F5 debugging, breakpoints,
  logs, single-test and watch runs, the full local check, VSIX build and isolated smoke test, the
  normal-profile vs. Development Host separation, provider-credential safety, the branch/PR flow,
  and the release and rollback procedures.

## Installation documentation

0.7.0 is live on the Marketplace, so the README's "not yet published — install from source"
guidance was stale. Both `README.md` and `README.tr.md` now lead with the real installation paths:

- **Marketplace UI** — `Ctrl+Shift+X`, search `@id:fatihdumlupinar-dev.ai-limit-ledger`, Install.
- **CLI** — `code --install-extension "fatihdumlupinar-dev.ai-limit-ledger"`.

Building from source remains documented, but as a contributor path rather than the way to install
the extension. The non-affiliation notice, privacy statements, provider limitations, and preview
status are unchanged.

## Please read before relying on a number

Unchanged from 0.7.0, and still true:

- Claude session metrics reflect the most recently observed CLI session, not an account-wide total.
- GitHub Copilot's allowance may not be available on an organization-managed account.
- Grok Free accounts may not expose a numeric usage percentage from the official source.
- Experimental provider endpoints may change or stop working without notice from the provider.
- AI Limit Ledger never calls a model/inference endpoint to read usage.
- Units are never combined or compared across providers.

## Verifying this release

Every GitHub Release asset comes from one audited Release Candidate build of one `main` commit:

- `ai-limit-ledger-0.7.1.vsix`
- `SHA256SUMS.txt` — verify with `sha256sum -c SHA256SUMS.txt`
- `release-manifest.json` — version, commit, publisher, extension ID, toolchain, and VSIX SHA-256
- `sbom.cdx.json` — CycloneDX-shaped SBOM
- `RELEASE_NOTES.md` — this file

The VSIX also carries a GitHub build-provenance attestation, verifiable with
`gh attestation verify ai-limit-ledger-0.7.1.vsix --repo Fatih-Dumlupinar/ai-limit-ledger`.
