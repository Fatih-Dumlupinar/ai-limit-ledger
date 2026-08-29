# Security audit — 0.6.1 (Task 10)

> **Errata (added in Task 10.1, 0.6.2 — this document's original text below is left unchanged):**
> The "Method" paragraph's phrase "run against the local lockfile (no other network access was
> used)" is imprecise and could be misread as `npm audit` being a network-free, local-only
> command. It is not: `npm audit` sends the resolved dependency tree to the configured npm
> registry to check it against known advisories, and requires registry connectivity to return a
> current result. What was true, and is restated correctly here, is that no _other_ network
> access beyond that one registry query was used — no source code or credentials were sent, and
> the separate `scripts/release-audit.mjs` tool (the "offline auditing script" mentioned two
> sentences later) genuinely never touches the network. See
> `docs/DEPENDENCY-RISK-REGISTER.md`'s own errata section for the parallel correction.

Scope: the 0.6.0 source tree, its dependency graph, its packaging output, and its local
release tooling. No user credentials, provider sessions, or `.env`/SecretStorage contents were
read during this audit; no real provider API/model call was made; no login flow was run.

## Method

Static, read-only review of `src/`, `test/`, configuration files, and generated build/package
output, followed by targeted, safe, minimal fixes and new regression tests. `npm audit --json`
was run against the local lockfile (no other network access was used). The full VSIX was built
and inspected with a new offline auditing script (`scripts/release-audit.mjs`).

## Findings and outcomes

### Fixed

1. **Windows temp-file race in `SharedSnapshotStore`** (`src/storage/SharedSnapshotStore.ts`).
   Discovered by a new concurrency regression test
   (`test/FilesystemTempIsolation.test.ts`), not by inspection alone. Root cause: the atomic-write
   temp filename was `${file}.${pid}.${Date.now()}.tmp`; two writes from the same process inside
   the same millisecond produced the same temp path, and the second `fs.rename()` then failed —
   observed as `ENOENT` (temp already consumed by the other writer) and, once the filename
   collision was fixed, as an intermittent `EPERM` from Windows' non-atomic-across-handles
   rename semantics under contention. Fixed by (a) adding a random suffix
   (`crypto.randomBytes(4)`) to guarantee a unique temp path per call, and (b) a bounded retry
   (5 attempts, linear backoff, `EPERM`/`EBUSY` only) around the rename itself. Verified with 10
   new tests including 20 fully concurrent writers to the same directory, stable across multiple
   repeated runs.
2. **Unnecessary VSIX bloat from compiled source maps.** `.vscodeignore` did not exclude
   `out/**/*.map`; 107 of the 233 files (~46%) `vsce ls` would have packaged were `.js.map`
   files whose `sources` field points at `../../src/*.ts` — paths that are never shipped, so the
   maps had zero runtime debugging value once installed. Excluded via `.vscodeignore`; VSIX file
   count dropped from 233 to 125 (further to 123 non-`out` + 107 fewer maps after removing the
   two local scratch files below).
3. **Local audit-tool scratch files nearly shipped in the VSIX.** During discovery,
   `npm audit --json > audit-raw.json` and `npm ls --all --json > deps-tree.json` were run in
   the repo root; because neither pattern was in `.vscodeignore`, `vsce ls` showed both would
   have been packaged. Deleted immediately, and `.vscodeignore` now denies `*-audit.json` /
   `*-tree.json` (and the new internal docs, `scripts/**`, `.gitignore`) as defense in depth
   against the same mistake recurring.

### Reviewed, no code change needed

4. **`npm audit`: 5 findings, all dev-only, all deferred.** See
   `docs/DEPENDENCY-RISK-REGISTER.md` for the full table. Zero production dependencies means
   none of the 5 (`vitest`, `vite`, `esbuild`, `vite-node`, `@vitest/mocker`) are reachable at
   runtime or shipped in the VSIX; the only fix is a semver-major `vitest` upgrade, deliberately
   not auto-applied.
5. **Network/redirect/CLI/webview boundaries** (`ProviderLinkRegistry`, `GrokCliProxyTransport`,
   `GitHubBillingClient`, `ClaudeWrapperRunner`, `SharedSnapshotStore` before the fix above) were
   already exact-host-allowlisted, HTTPS-only, redirect-rejecting, size-capped,
   timeout-bounded, and used `spawn()` with a fixed command and typed argument array (never
   shell string concatenation) prior to this audit. No change was needed to those files beyond
   the temp-file fix above; this was verified by reading the implementations and by the
   pre-existing `ProviderLinkRegistry.test.ts`, `ProviderLinkCoverage.test.ts`,
   `GrokCliProxyTransport.test.ts`, and `CopilotEntitlementTransport.test.ts` suites, which
   already cover host allowlisting, redirect rejection, timeouts, and response-size limits.
6. **No absolute personal paths or credential-shaped values in source.** A static scan across
   `src/`, `test/`, `docs/`, and the built VSIX (via `scripts/release-audit.mjs`) found only
   fixture-marked placeholder paths (`C:\Users\fixture\...`, `/home/test`, `/home/fixture`) used
   to test redaction logic itself — none are a real developer identity. No credential-shaped
   pattern (GitHub PAT, OpenAI-style key, AWS key ID, PEM private-key block, long Bearer token,
   or a `secret`/`password`-labeled hex literal) was found anywhere in the tree or the packaged
   VSIX.
7. **Experimental-endpoint isolation** (Copilot entitlement transport, Grok CLI-proxy
   transport, Claude CLI-free OAuth usage transport) was already structurally separated from the
   official transports, response-allowlisted, provenance-tagged, and gated behind explicit
   per-feature consent prior to this audit; no new undocumented endpoint was added, and none of
   the existing ones were modified.

## Not done in this task (by design)

- No `.github/` GitHub Actions workflow was created — `docs/CI-SECURITY-DESIGN.md` is a design
  document only, per the Task 10 brief; real workflows are Task 12.
- No public GitHub repository was created, and no commit, tag, or push was made — verified in
  the final report's Git-status section.
- No dependency was added to satisfy any check in this audit; `scripts/release-audit.mjs` uses
  only Node built-ins.
- `npm audit fix --force` was not run, and no major dependency version was upgraded.
