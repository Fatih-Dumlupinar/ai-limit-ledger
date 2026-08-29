# Dependency risk register (0.6.2)

Generated during Task 10 (0.6.1) and updated during Task 10.1 (0.6.2). Re-run `npm audit` and
revisit this table before every subsequent release; it is a point-in-time record, not a live
feed.

> **`npm audit` is a network operation, not a local-only one.** It sends your resolved
> dependency tree (package names and versions from `package-lock.json`) to the configured npm
> registry and asks it for known advisories; it does not upload source code or credentials, but
> it does require registry connectivity and its result reflects the advisory database at the
> moment it ran. `npm run audit:release` (`scripts/release-audit.mjs`) is the separate,
> dependency-free, fully offline tool that never touches the network — it only inspects local
> files (manifest/lockfile consistency, path/credential patterns, VSIX content). **The two are
> not interchangeable and this document previously blurred that line in one sentence — see the
> errata note at the bottom.**

## Summary (0.6.2)

- **Production dependencies: 0.** Unchanged from 0.6.1 — `package.json` `dependencies` is `{}`.
- **Development dependencies: 9 direct**, now **427 total including transitive** (varies
  slightly by platform-optional packages npm chooses to install).
- **`npm audit` findings: 0.** All 5 findings that were open in 0.6.1 (`vitest`, `vite`,
  `esbuild`, `vite-node`, `@vitest/mocker`) are resolved by the Task 10.1 `vitest` 2→4 upgrade.
  Verified with `npm audit --json` and `npm audit --omit=dev --json`, both reporting
  `{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}`.

## Task 10.1: how the 5 findings were closed

| Package          | 0.6.1 version                     | 0.6.2 version                                          | Direct/Transitive             | Resolution                                                                                                               |
| ---------------- | --------------------------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `vitest`         | `2.1.9` (critical finding)        | `4.1.11`                                               | Direct devDependency          | Upgraded to the latest stable, non-prerelease 4.x release (`dist-tags.latest`, verified via `npm view vitest dist-tags`) |
| `vite`           | `5.4.21` (moderate/high findings) | `8.2.2`                                                | Transitive (via `vitest`)     | Pulled in automatically by the `vitest@4.1.11` upgrade; not a direct dependency, not added deliberately                  |
| `esbuild`        | `0.21.5` (moderate finding)       | resolved transitively, no longer separately vulnerable | Transitive (via `vite`)       | Same — automatic via the `vitest`/`vite` upgrade                                                                         |
| `vite-node`      | `2.1.9` (moderate finding)        | **removed**                                            | Was transitive (via `vitest`) | Vitest 4 replaced `vite-node` with Vite's own Module Runner; the package no longer appears in `npm ls` at all            |
| `@vitest/mocker` | `2.1.9` (moderate finding)        | `4.1.11`                                               | Transitive (via `vitest`)     | Upgraded in lockstep with `vitest` (same version number, official Vitest monorepo package)                               |

No non-major fix existed on the Vitest 2.x line at the time of the original 0.6.1 audit (latest
was `2.2.0-beta.2`, a prerelease, still vulnerable). The major upgrade was deferred in 0.6.1
specifically so it could be done as its own controlled, tested change — this is that change.
`npm audit fix --force` was **not** used; the upgrade was done explicitly
(`npm install vitest@4.1.11 --save-dev`), and `vitest@4.1.11` was chosen deliberately (the exact
`dist-tags.latest` value at audit time, not `beta`/`rc`/`5.0.0-beta.7`/`5.0.0-rc.2`, which were
also published to the registry at the same time but are prereleases).

## Node development runtime

- **0.6.1 policy:** none — `package.json` had no `engines.node`, and local development used
  Node `20.10.0`, which reached end-of-life status before this release.
- **0.6.2 policy:** `engines.node` is now `">=22.12.0"`. Node 24 (the current LTS line, "Krypton"
  per `https://nodejs.org/en/about/previous-releases`) is the preferred development target;
  Node 22 (LTS line "Jod") is the minimum supported development runtime. Node 20 ("Iron") is
  EOL and is no longer recommended anywhere in this project's documentation.
- This is a **development-time** requirement only — installing and running the packaged
  extension never requires the end user to have any particular Node version, or Node at all
  beyond what the VS Code extension host itself bundles. See `README.md`'s "Development
  requirements" section for the explicit distinction.
- Final Task 10.1 verification ran on a portable, official, checksum-verified Node **24.20.0**
  (see `docs/RELEASE-READINESS-0.6.2.md` for the exact verification steps and hash).

## License compliance (informational — not the extension's own license)

Unchanged from 0.6.1: the extension's own license is MIT; all direct devDependencies are
MIT/Apache-2.0; none are shipped in the VSIX (`node_modules/**` is excluded, and
`npm run package` uses `--no-dependencies`). The `vitest` 2→4 upgrade did not change this —
`vite` (also MIT) is still transitive-only and dev-only.

## Task 12.1: Node type compatibility and major-update policy

- Dependabot PR **#5** changed `@types/node` from `20.19.43` to `26.3.0`. It did not produce a
  runtime/provider error, but it created unnecessary extension-host compatibility risk. The change
  is restored to the `^20.17.0` manifest range and the compatible `20.19.43` lockfile resolution.
- `@types/node` is a development type contract; it does not automatically track the Node version
  installed on the development machine. The development engine remains Node `>=22.12.0`, with
  Node 24 preferred, while `@types/vscode` and `engines.vscode` continue to describe the VS Code
  extension host.
- Dependabot now ignores npm `version-update:semver-major` updates for normal version-update PRs.
  Minor and patch updates remain grouped and open. Per Dependabot's `update-types` contract, this
  ignore rule does not block security updates. Major migrations are manual, planned tasks reviewed
  for changelog impact, peer dependencies, and CI/toolchain compatibility.
- The PR **#2** `@typescript-eslint` updates remain in place; TypeScript 5, ESLint 9, and Vitest 4
  remain the supported toolchain majors.

## Re-evaluation trigger

Revisit this table before every release, and immediately if `npm audit` reports a new finding
against `vitest@4.1.11`, `vite@8.2.2`, or any of their transitive dependencies.

---

## Errata (added in Task 10.1)

The 0.6.1 version of this document contained one imprecise sentence in its "re-evaluation
trigger" section that read: _"before every release (`npm audit` as part of `npm run
audit:release`'s dependency inventory step)"_ — this incorrectly implied that
`npm run audit:release` invokes `npm audit`, or that the two share a network-vs-offline nature.
**They do not:** `scripts/release-audit.mjs` never calls `npm audit` and never makes a network
request of any kind; `npm audit` is a separate, registry-dependent command that must be run on
its own. This document (and the parallel note in `docs/SECURITY-AUDIT-0.6.1.md`, which described
running `npm audit --json` as being "against the local lockfile" in a way that could be misread
as network-free) are corrected here rather than silently rewritten — the original 0.6.1 files
are left as they were published, and this note is the record of the correction. See
`docs/RELEASE-READINESS-0.6.2.md` for the corrected README/SECURITY/PUBLISHING wording.
