# Contributing to AI Limit Ledger

Thanks for your interest in contributing. This project is a privacy-first VS Code extension with zero production dependencies, and contributions are expected to preserve both of those properties.

## Development setup

- **Node**: 24 LTS preferred, Node 22 minimum (see `.nvmrc`/`.node-version` and `package.json`'s `engines.node`). Node 20 is end-of-life and unsupported.
- Install dependencies from the lockfile, never a fresh resolve:

  ```powershell
  npm ci
  ```

- Build, lint, format, test, and audit:

  ```powershell
  npm run compile
  npm run lint
  npm run format:check
  npm run verify:workflows
  npm test
  npm run audit:release
  ```

Run the full chain above before opening a pull request. `npm run audit:release` (`scripts/release-audit.mjs`) is this project's own dependency-free, offline check for manifest/lockfile consistency, absolute-path and credential-shaped patterns, and (when pointed at a built `.vsix`) packaging content — it is separate from `npm audit`, which requires registry network access; both matter but they check different things.

The repository workflows are part of the review surface. `CI` runs the quality matrix on Ubuntu and
Windows and packages a VSIX only after quality passes. `CodeQL`, `Secret Scan`, and `Dependency
Review` use read-first permissions; `Secret Scan` checks the full Git history with Gitleaks
redaction and a verified official checksum. Every external Action reference is pinned to a full
commit SHA with a release comment. Do not use `pull_request_target`, repository secrets, floating
Action tags, `npm install`, or automatic Dependabot merging.

## Branching and pull requests

- Branch from `main`.
- Keep PRs focused; avoid bundling unrelated changes.
- Prefer [Conventional Commits](https://www.conventionalcommits.org/) style commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, etc.) — not strictly enforced, but appreciated for a readable history.
- Fill out the pull request template completely; an incomplete checklist will slow down review.

## Test expectations

- Every behavior change needs test coverage. This project treats test count and file count as a floor, not a target to game — write tests that actually exercise the new/changed behavior.
- Run the full suite at least once before submitting; if you touched source, runtime behavior, or test infrastructure, run it three consecutive times to catch flakiness (`npm test` three times, all identical pass counts, no `ENOTEMPTY`/timing-dependent failures).
- Never commit `.only`/`.skip` on suites you didn't intend to disable.

## Localization

User-facing strings ship in English and Turkish (`package.nls.json` / `package.nls.tr.json`, and the runtime localization service under `src/`). If you add or change a user-facing string:

- Add both the English and Turkish value.
- Keep placeholders/interpolation tokens identical between the two.
- Do not leave a Turkish string as a copy-pasted English fallback — if you can't translate it yourself, say so in the PR description and ask for help rather than guessing.

## Provider provenance rules

This project distinguishes **official**, **experimental**, and **derived/calculated** data on every provider card, and that distinction must never be blurred:

- Only officially documented provider endpoints/CLIs may be labeled as an official source.
- Any undocumented or reverse-engineered endpoint must be gated behind its own explicit opt-in consent, clearly labeled "Experimental" in the UI, and isolated from official data paths so it can never silently overwrite an official value.
- A calculated or user-configured value (e.g. a manually entered plan allowance) must be labeled as calculated, never presented as if the provider returned it.
- Do not add a new undocumented/reverse-engineered provider endpoint without discussing it in an issue first — these carry real risk of breaking silently or violating a provider's terms, and need explicit review.

## Privacy and logging boundaries

- Never read, store, or log a raw provider credential, OAuth token, session cookie, or full raw provider response body.
- Never log or persist an absolute user-specific filesystem path, email address, account ID, or other personal identifier, in source, tests, fixtures, or documentation.
- Test fixtures needing a "sensitive-looking" value (a path, token, or email) must use an obviously fake/generic marker (e.g. `C:\Users\fixture\...`, `ghp_` + placeholder letters, `account@example.com`) — never a real value, and never a real person's name or path.
- New network access must be HTTPS-only, exact-host-allowlisted, and reviewed for whether it needs its own consent gate (see Provider provenance rules above).

## Adding a dependency

This project has zero production dependencies by design. A new `devDependency` needs a clear justification in the PR description (what it replaces or enables); a new production `dependency` is a much higher bar and should be raised as an issue before you write the code.

## Generated output

Do not commit `out/`, `dist/`, `coverage/`, `.vsix` files, `node_modules/`, or any local audit/scratch JSON (`*-audit.json`, `*-tree.json`). These are all covered by `.gitignore`; if `git status` shows one of them as untracked-but-not-ignored, something is misconfigured — fix `.gitignore` rather than force-adding the file.

## Reporting a security vulnerability

**Do not open a public issue for a security vulnerability.** See [SECURITY.md](SECURITY.md) for how to report one privately.
