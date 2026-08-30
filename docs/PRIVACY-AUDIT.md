# Privacy audit

`scripts/privacy-audit.mjs` answers one question that no upstream service asks on this project's
behalf:

> Does anything in this repository, its history, or its published package reveal **who built it** or
> **what machine it was built on**?

It is a permanent, dependency-free tool (Node built-ins only, matching `scripts/release-audit.mjs`
and `scripts/verify-workflows.mjs`), and it runs as a hard gate in the Release Candidate workflow.

## How this differs from secret scanning

GitHub's secret scanning and this repository's Gitleaks job (`.github/workflows/secret-scan.yml`)
look for **credentials a provider would recognize and revoke** — a token, a key, a certificate. That
is a narrow, high-value question, and those tools answer it better than anything written here.

The privacy audit asks a **broader and lower-stakes** question that credential scanners deliberately
ignore. A developer's `C:\Users\<name>` path, a hostname, a LAN address, a source map pointing at a
build directory, or a VS Code profile path is not a secret — no provider will ever revoke it, and no
secret scanner will ever report it. But it is exactly the kind of thing that should not ship to a
stranger who installs the extension from the Marketplace.

The two are complementary and both run. The privacy audit also carries credential patterns, but as a
backstop, not as a replacement: if it and Gitleaks ever disagree, Gitleaks is authoritative about
credentials.

## Public identity vs leaked personal data

This is the distinction the tool exists to make, and it is why "no findings" from a naive scanner
would be misleading.

Some personal-looking data in this repository is **published on purpose**:

- `Fatih-Dumlupinar` — the repository owner's GitHub handle.
- `fatihdumlupinar-dev` and `fatihdumlupinar-dev.ai-limit-ledger` — the Marketplace publisher and
  extension id.
- `…@users.noreply.github.com` — the address in every commit. This is GitHub's _privacy-preserving_
  address, issued precisely so a real mailbox never appears in commit metadata.
- The canonical repository and Marketplace listing URLs.

These are reported in their own **intentional public identity** section rather than silently
dropped. A report that hid them could not distinguish a genuinely anonymous package from one nobody
had examined. They never fail the audit.

Everything else that looks personal is either a **safe fixture** or a **finding**:

- **Safe fixture** — an obviously synthetic value: a conventional placeholder account name
  (`fixture`, `me`, `test`, `someone`), an RFC- or vendor-reserved documentation value
  (`user@example.com`, `127.0.0.1`, `123e4567-e89b-…`), a degenerate placeholder UUID, a hand-typed
  placeholder credential (a run of the alphabet, a repeated character), or an impersonal
  cryptographic digest (a lockfile `sha512-…` integrity hash, a commit SHA). The repository's
  contributor rules require fixtures to look like this, which is what makes this triage possible.
- **Finding** — anything else. A human must look at it, and the audit exits non-zero.

For a path, the fixture marker must be in the **account segment**, never anywhere else in the path.
`C:\Users\<real-account>\test` is a finding: the trailing `test` directory does not launder a real
account name. (This document writes the account segment as a placeholder for the same reason the
tool masks it — a doc that spelled out a realistic account name would be flagged by the very audit
it describes, and rightly so.)

## What it scans

- **Source tree** (default) — every file tracked by git.
- **History** (`--history`) — every blob reachable from every ref, plus author and committer
  identities from commit metadata. A finding is attributed to the commit that introduced the blob,
  not to the blob id.
- **Packaged VSIX** (`--vsix <path>`) — entry names and entry contents, read straight out of the ZIP
  central directory and inflated in memory. Nothing is ever extracted to disk.

Within those, it covers: Windows/macOS/Linux user-profile paths, UNC and share paths, email
addresses, private and loopback IP addresses, MAC addresses, UUIDs, source maps carrying absolute
build paths, VS Code profile paths, PNG text metadata, and a set of credential shapes (GitHub,
Azure DevOps/Marketplace, npm, provider API keys, AWS, PEM private keys, JWTs, Authorization
headers, connection strings, credential-bearing URLs, cookie/session and generic secret
assignments), plus an unexplained-high-entropy backstop.

## What it deliberately does not scan

These are refusals, not gaps:

- **Anything outside the repository.** It never walks the home directory or the machine at large,
  and it refuses to follow a symlink whose real path escapes the repository root.
- **Credential stores.** No VS Code SecretStorage, no OS credential manager, no browser session, no
  `.env` file contents, no provider credentials.
- **Raw provider payloads.** No API responses, prompts, transcripts, or model output.
- **Binary content as text.** Compressed bytes reliably produce runs that look like email addresses
  and tokens — this repository's own icon does exactly that. Binaries are checked by signature and
  structure instead. For PNGs that means walking the chunk table and reading only `tEXt`/`iTXt`/
  `zTXt`/`eXIf` metadata, which is where an export tool would actually write an author name, GPS
  coordinates, or a source file path.
- **Oversized files and lines.** Anything past the documented per-file, per-line, and total-scan
  limits is skipped **and reported as skipped**, so a limited scan can never be mistaken for a
  complete one.

## Redaction

The tool never prints a matched value — not to stdout, not to stderr, not to a JSON report, not to a
GitHub Actions job summary. The raw match is fingerprinted, masked, and classified, and then
discarded; a finding object has no field that could carry it, so there is no code path that could
render one by mistake.

Each finding is reported as:

```
PATTERN_ID | severity | path:line | commit | masked | fingerprint:xxxxxxxxxxxx | surface
```

for example:

```
WINDOWS_USER_PATH | medium | test/example.test.ts:42 | fa18c24 | C:\Users\<redacted>\... | fingerprint:12ab34cd56ef | source-tree
```

The mask keeps only structural shape (`C:\Users\<redacted>\...`, `<redacted-local>@<redacted-domain>`,
or a bare `<redacted:N chars>` length class for credential shapes). The fingerprint is the first 12
hex characters of the value's SHA-256 — enough to correlate "the same value appears in these five
places" across runs and reports, and not reversible into the value. `--json <path>` writes the same
redacted content as a machine-readable report; report files are gitignored and excluded from the
VSIX.

## Allowlist

`scripts/privacy-allowlist.json` suppresses a known false positive. Each entry names exactly three
things:

```json
{
  "patternId": "MACHINE_UUID",
  "path": "test/Example.test.ts",
  "reason": "placeholder identifier used by a fixture"
}
```

The constraints are enforced by `validateAllowlist` and covered by tests:

- One **known** pattern id per entry — no "suppress everything here".
- One **exact** repository-relative path — no wildcards, no directory-wide mutes, no traversal.
- A **reason** a human wrote.
- **No value field.** An entry can say "this pattern is expected at this fixture path"; it can never
  contain the personal data it is excusing, which would put the very thing the audit exists to keep
  out of the repository into a committed file.

An allowlisted match is reported as `allowlisted`, not deleted from the report.

## Why history findings do not trigger a rewrite

The audit reports what it finds in history; it never rewrites anything, and neither should a reader
of its output reflexively do so. Rewriting history is a destructive, coordinated operation: it
changes every commit SHA after the rewrite point, invalidates existing tags, releases, provenance
attestations, and review links, and breaks every clone and fork. That cost is worth paying for a
real, live credential — and in that case the rewrite is the _second_ step, after revoking the
credential, which is what actually removes the risk.

For everything else it is the wrong trade. A synthetic fixture, a placeholder path, or a
noreply commit address in an old commit is not made safer by rewriting; the repository is simply
made harder to trust and harder to verify. So the tool's job is to surface the finding with enough
information to triage it, and the decision to rewrite stays an explicit, separately-reasoned human
one.

## Usage

```bash
npm run audit:privacy                                   # tracked source tree
npm run audit:privacy -- --history                      # all reachable history
npm run audit:privacy -- --vsix ai-limit-ledger-X.Y.Z.vsix
npm run audit:privacy -- --json privacy-audit-report.json
```

Exit codes: `0` clean, `1` findings require review, `2` the audit itself failed. A crash, a timeout,
a git subprocess error, a malformed allowlist, or an unreadable package is always `2` — never a
silent pass.

All three modes run as gates in `release-candidate.yml`; see `docs/RELEASE-PROCESS.md`.
