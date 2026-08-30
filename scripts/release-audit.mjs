#!/usr/bin/env node
/**
 * Local, offline release-readiness audit for AI Limit Ledger.
 *
 * Design constraints (Task 10):
 * - No new dependency: uses only Node built-ins (fs, path, zlib, crypto).
 * - No network access, no provider calls.
 * - Read-only: never modifies source, package.json, or the lockfile.
 * - Never prints a credential/token/password value — only file, line, and category.
 * - Cross-platform: no shell-specific parsing, no OS-specific commands.
 *
 * Usage:
 *   node scripts/release-audit.mjs            # audits the source tree only
 *   node scripts/release-audit.mjs <file.vsix> # also audits a packaged VSIX
 *
 * Exit code is non-zero only when a check with severity "fail" is found.
 * "warn" findings are reported but do not fail the build — they are judgment
 * calls that a human should read (see docs/RELEASE-READINESS-0.6.1.md).
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** @typedef {{ id: string, severity: 'pass'|'warn'|'fail', summary: string, details?: string[] }} CheckResult */

/** @type {CheckResult[]} */
const results = [];

function record(id, severity, summary, details) {
  results.push({ id, severity, summary, details });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', '.tmp', 'test-tmp']);

/** Recursively lists files under `dir` (relative to ROOT), skipping build/vendor output. */
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(rel, out);
    } else {
      out.push(rel);
    }
  }
  return out;
}

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.json',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.nls.json',
]);

function isLikelyTextFile(relPath) {
  return TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Manifest / lockfile version consistency
// ---------------------------------------------------------------------------

function checkVersionConsistency() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const lockRootVersion = lock.version;
  const lockRootPkgVersion =
    lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;

  // `lockfileVersion` is the LOCKFILE FORMAT (currently 3), never confused with the project version.
  const versions = {
    'package.json:version': pkg.version,
    'package-lock.json:version': lockRootVersion,
    "package-lock.json:packages[''].version": lockRootPkgVersion,
  };
  const distinct = new Set(Object.values(versions));

  if (distinct.size === 1) {
    record('version-consistency', 'pass', `All manifest/lockfile versions match: ${pkg.version}`, [
      `lockfileVersion (format, not project version): ${lock.lockfileVersion}`,
    ]);
  } else {
    record(
      'version-consistency',
      'fail',
      "package.json, package-lock.json root, and package-lock.json packages[''] versions disagree",
      Object.entries(versions).map(([k, v]) => `${k} = ${v ?? '(missing)'}`),
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Forbidden absolute user paths
// ---------------------------------------------------------------------------

export const ABSOLUTE_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\"'<>]+/g,
  /\/Users\/[^/"'<>\s]+/g,
  /\/home\/[^/"'<>\s]+/g,
];

async function checkAbsoluteUserPaths() {
  const files = (await walk('src'))
    .concat(await walk('test'))
    .concat(await walk('docs'))
    .concat([
      'README.md',
      'README.tr.md',
      'CHANGELOG.md',
      'SECURITY.md',
      'PRIVACY.md',
      'SUPPORT.md',
      'PUBLISHING.md',
      'package.json',
    ])
    .filter((f) => existsSync(path.join(ROOT, f)) && isLikelyTextFile(f));

  const hits = [];
  for (const file of files) {
    const content = readFileSync(path.join(ROOT, file), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of ABSOLUTE_PATH_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match) {
          // Fixture/placeholder usernames (e.g. "C:\Users\fixture\...", "/home/test") exercise
          // redaction logic itself and are not a real developer's identity — same triage
          // principle as the credential-pattern scan below.
          const category = KNOWN_SAFE_FIXTURE_MARKERS.test(match[0])
            ? 'likely-fixture'
            : 'needs-review';
          hits.push({ file, line: index + 1, category });
        }
      }
    });
  }

  const needsReview = hits.filter((h) => h.category === 'needs-review');
  if (hits.length === 0) {
    record('absolute-user-paths', 'pass', 'No absolute user home paths found in src/test/docs.');
  } else if (needsReview.length === 0) {
    record(
      'absolute-user-paths',
      'warn',
      `${hits.length} absolute-path-shaped match(es), all fixture/placeholder usernames`,
      hits.slice(0, 25).map((h) => `${h.file}:${h.line} (fixture-marked)`),
    );
  } else {
    record(
      'absolute-user-paths',
      'fail',
      `${needsReview.length} line(s) contain what looks like a real absolute user path`,
      needsReview.slice(0, 25).map((h) => `${h.file}:${h.line}`),
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Credential-shaped pattern scan (never prints the matched value)
// ---------------------------------------------------------------------------

export const CREDENTIAL_PATTERNS = [
  { name: 'github-pat', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'openai-style-secret', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer-literal-token', pattern: /Bearer\s+[A-Za-z0-9._-]{24,}/g },
  {
    name: 'generic-long-hex-secret',
    pattern: /\b(?:secret|apikey|api_key|password)\s*[:=]\s*['"][0-9a-fA-F]{24,}['"]/gi,
  },
];

export const KNOWN_SAFE_FIXTURE_MARKERS =
  /fake|placeholder|redacted|xxxx|example|test-only|fixture|dummy|\btest\b|\bdemo\b/i;

async function checkCredentialPatterns() {
  const files = (await walk('src')).concat(await walk('test')).concat(await walk('docs'));
  const findings = [];
  for (const file of files) {
    if (!isLikelyTextFile(file)) continue;
    const content = readFileSync(path.join(ROOT, file), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { name, pattern } of CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          const category = KNOWN_SAFE_FIXTURE_MARKERS.test(line)
            ? 'likely-fixture'
            : 'needs-review';
          findings.push({ file, line: index + 1, name, category });
        }
      }
    });
  }

  const needsReview = findings.filter((f) => f.category === 'needs-review');
  if (findings.length === 0) {
    record('credential-patterns', 'pass', 'No credential-shaped patterns found.');
  } else if (needsReview.length === 0) {
    record(
      'credential-patterns',
      'warn',
      `${findings.length} credential-shaped match(es), all in files with fixture/placeholder markers`,
      findings.slice(0, 25).map((f) => `${f.file}:${f.line} [${f.name}] (fixture-marked)`),
    );
  } else {
    record(
      'credential-patterns',
      'fail',
      `${needsReview.length} credential-shaped match(es) without a fixture/placeholder marker — review required`,
      needsReview.slice(0, 25).map((f) => `${f.file}:${f.line} [${f.name}]`),
    );
  }
}

// ---------------------------------------------------------------------------
// 4. package.json lifecycle-script / dependency-source inventory
// ---------------------------------------------------------------------------

function checkSupplyChain() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');

  const dangerousScripts = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];
  const presentDangerous = dangerousScripts.filter((s) => pkg.scripts && pkg.scripts[s]);

  const suspiciousDeps = [];
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (name === '') continue;
    const resolved = entry.resolved;
    if (!resolved) continue;
    const isRegistry = /^https:\/\/registry\.npmjs\.org\//.test(resolved);
    const isGit = /^git(\+[a-z]+)?:\/\//.test(resolved) || resolved.includes('github.com');
    if (!isRegistry) {
      suspiciousDeps.push(`${name} -> ${resolved}`);
    }
    void isGit;
  }

  const prodDepCount = Object.keys(pkg.dependencies || {}).length;

  const details = [
    `Production dependencies: ${prodDepCount}`,
    `Lifecycle scripts present in package.json: ${presentDangerous.length === 0 ? 'none' : presentDangerous.join(', ')}`,
  ];
  if (suspiciousDeps.length > 0) {
    details.push(`Non-registry sources: ${suspiciousDeps.length}`);
  }

  if (presentDangerous.length > 0 || suspiciousDeps.length > 0) {
    record(
      'supply-chain',
      'fail',
      'Lifecycle scripts or non-registry dependency sources detected',
      details.concat(suspiciousDeps.slice(0, 25)),
    );
  } else if (prodDepCount > 0) {
    record('supply-chain', 'warn', 'Production dependencies present — review each one', details);
  } else {
    record(
      'supply-chain',
      'pass',
      'Zero production dependencies; all packages resolve to the npm registry',
      details,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Required documents / entrypoints in the source tree
// ---------------------------------------------------------------------------

const REQUIRED_SOURCE_FILES = [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'PRIVACY.md',
  'SUPPORT.md',
  'package.nls.json',
  'package.nls.tr.json',
  'assets/icon.png',
  'src/extension.ts',
];

function checkRequiredSourceFiles() {
  const missing = REQUIRED_SOURCE_FILES.filter((f) => !existsSync(path.join(ROOT, f)));
  if (missing.length === 0) {
    record('required-files', 'pass', 'All required source-tree files are present.');
  } else {
    record('required-files', 'fail', `${missing.length} required file(s) missing`, missing);
  }
}

function checkLocalizationParity() {
  const en = readJson('package.nls.json');
  const tr = readJson('package.nls.tr.json');
  const enKeys = new Set(Object.keys(en));
  const trKeys = new Set(Object.keys(tr));
  const missingInTr = [...enKeys].filter((k) => !trKeys.has(k));
  const missingInEn = [...trKeys].filter((k) => !enKeys.has(k));
  if (missingInTr.length === 0 && missingInEn.length === 0) {
    record(
      'localization-parity',
      'pass',
      `EN/TR manifest catalogs match (${enKeys.size} keys each).`,
    );
  } else {
    record('localization-parity', 'fail', 'EN/TR manifest localization catalogs are out of sync', [
      ...missingInTr.map((k) => `missing in TR: ${k}`),
      ...missingInEn.map((k) => `missing in EN: ${k}`),
    ]);
  }
}

// ---------------------------------------------------------------------------
// 6. Minimal pure-Node ZIP reader for VSIX content auditing (no dependency)
// ---------------------------------------------------------------------------

export function readZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1)
    throw new Error('Not a valid ZIP/VSIX: End Of Central Directory not found');

  const cdEntryCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let offset = cdOffset;
  const CD_SIG = 0x02014b50;
  for (let i = 0; i < cdEntryCount; i++) {
    if (buffer.readUInt32LE(offset) !== CD_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength);
    entries.push({ fileName, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntryContent(buffer, entry) {
  const LOCAL_SIG = 0x04034b50;
  const off = entry.localHeaderOffset;
  if (buffer.readUInt32LE(off) !== LOCAL_SIG)
    throw new Error(`Bad local header for ${entry.fileName}`);
  const fileNameLength = buffer.readUInt16LE(off + 26);
  const extraLength = buffer.readUInt16LE(off + 28);
  const dataStart = off + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.fileName}`);
}

// ---------------------------------------------------------------------------
// 7. VSIX content audit (only runs when a .vsix path is given)
// ---------------------------------------------------------------------------

export const VSIX_DENYLIST_PATTERNS = [
  /^extension\/\.git\//,
  /node_modules\//,
  /\.map$/,
  /(^|\/)\.env(\..*)?$/,
  /debug\.log$/i,
  /\.vsix$/,
  /coverage\//,
  /(^|\/)\.tmp\//,
  /-audit\.json$/,
  /-tree\.json$/,
  /\.bak$/,
  /~$/,
  // Development/build/release tooling — never needed by the running extension. Excluded from
  // the VSIX via .vscodeignore's `scripts/**`; listed here too so a future regression (e.g. that
  // ignore rule being accidentally removed) is caught by the post-package audit, not just by
  // silent omission.
  /^extension\/scripts\//,
  /^extension\/\.nvmrc$/,
  /^extension\/\.node-version$/,
  // Test fixtures and CI/workflow definitions — dev-time only, never needed by the installed
  // extension (Task 13).
  /^extension\/test\//,
  /^extension\/\.github\//,
  // Editor/agent-tooling scratch state (e.g. a local Claude Code session lock file) — never part
  // of the project's source and must never leak into a packaged VSIX (Task 13.1 found this
  // actually happening: an untracked, globally-gitignored `.claude/scheduled_tasks.lock` was
  // getting packaged because .vscodeignore had no rule for it).
  /^extension\/\.claude\//,
  // Marketplace listing screenshots and internal Marketplace-prep docs live in the repository for
  // the Marketplace page / provenance, not inside the installable package (Task 13) — see
  // docs/MARKETPLACE-ASSET-INVENTORY.md's "VSIX packaging policy" section.
  /^extension\/assets\/marketplace\//,
  /^extension\/docs\/MARKETPLACE-/,
  // Task 14 release-process docs — internal to the release procedure, never needed by the
  // installed extension. Excluded from the VSIX via .vscodeignore; listed here too for the same
  // regression-safety reason as the Marketplace docs above.
  /^extension\/docs\/RELEASE-PROCESS\.md$/,
  /^extension\/docs\/FIRST-MARKETPLACE-RELEASE-/,
  /^extension\/docs\/INSTALLATION-MIGRATION-/,
  /^extension\/docs\/ROLLBACK\.md$/,
  /^extension\/docs\/RELEASE-NOTES-/,
];

// vsce packages README/CHANGELOG/LICENSE under its own Marketplace-convention names/casing
// (readme.md, changelog.md, LICENSE.txt) rather than the repository's original filenames — this
// list intentionally matches vsce's actual packaged output, not the source-tree filenames.
export const VSIX_REQUIRED_ENTRIES = [
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/SECURITY.md',
  'extension/PRIVACY.md',
  'extension/SUPPORT.md',
  'extension/package.nls.json',
  'extension/package.nls.tr.json',
  'extension/out/extension.js',
];

const MAX_VSIX_BYTES = 5 * 1024 * 1024; // 5 MB budget for a dependency-free UI extension

function checkVsixContent(vsixPath) {
  const buffer = readFileSync(vsixPath);
  const sizeBytes = buffer.length;
  const entries = readZipEntries(buffer);
  const names = entries.map((e) => e.fileName);

  const denied = names.filter((n) => VSIX_DENYLIST_PATTERNS.some((p) => p.test(n)));
  const namesLower = new Set(names.map((n) => n.toLowerCase()));
  const missingRequired = VSIX_REQUIRED_ENTRIES.filter((n) => !namesLower.has(n.toLowerCase()));
  const absolutePathHits = [];
  for (const name of names) {
    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(name)) absolutePathHits.push(name);
    }
  }

  const largest = [...entries]
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)
    .slice(0, 20)
    .map((e) => `${e.fileName} (${e.uncompressedSize} bytes)`);

  record(
    'vsix-file-count',
    'pass',
    `VSIX contains ${entries.length} entries, ${sizeBytes} bytes`,
    largest,
  );

  if (missingRequired.length > 0) {
    record(
      'vsix-required-entries',
      'fail',
      `${missingRequired.length} required entr(y/ies) missing`,
      missingRequired,
    );
  } else {
    record('vsix-required-entries', 'pass', 'All required entries present.');
  }

  if (denied.length > 0) {
    record(
      'vsix-denylist',
      'fail',
      `${denied.length} denylisted entr(y/ies) present`,
      denied.slice(0, 25),
    );
  } else {
    record(
      'vsix-denylist',
      'pass',
      'No denylisted entries (no .git, node_modules, .map, .env, logs, scratch JSON).',
    );
  }

  if (absolutePathHits.length > 0) {
    record(
      'vsix-absolute-paths',
      'fail',
      'Absolute user paths found in VSIX entry names',
      absolutePathHits,
    );
  } else {
    record('vsix-absolute-paths', 'pass', 'No absolute user paths in VSIX entry names.');
  }

  if (sizeBytes > MAX_VSIX_BYTES) {
    record(
      'vsix-size-budget',
      'warn',
      `VSIX is ${sizeBytes} bytes, over the ${MAX_VSIX_BYTES} byte budget`,
    );
  } else {
    record(
      'vsix-size-budget',
      'pass',
      `VSIX is ${sizeBytes} bytes, within the ${MAX_VSIX_BYTES} byte budget.`,
    );
  }

  // Manifest version inside the VSIX must match package.json/lockfile.
  const pkgEntry = entries.find((e) => e.fileName === 'extension/package.json');
  if (pkgEntry) {
    const content = JSON.parse(readZipEntryContent(buffer, pkgEntry).toString('utf8'));
    const outerPkg = readJson('package.json');
    if (content.version === outerPkg.version) {
      record(
        'vsix-manifest-version',
        'pass',
        `VSIX manifest version matches package.json (${content.version}).`,
      );
    } else {
      record(
        'vsix-manifest-version',
        'fail',
        `VSIX manifest version (${content.version}) does not match package.json (${outerPkg.version})`,
      );
    }

    // Packaged publisher/name/id must match the intended Marketplace identity, not just the
    // outer package.json (guards against vsce packaging a stale/edited manifest).
    const packagedId = `${content.publisher}.${content.name}`;
    if (
      content.publisher === EXPECTED_MARKETPLACE_PUBLISHER &&
      content.name === EXPECTED_PACKAGE_NAME &&
      packagedId === EXPECTED_EXTENSION_ID
    ) {
      record('vsix-manifest-identity', 'pass', `Packaged manifest identity is ${packagedId}.`);
    } else {
      record(
        'vsix-manifest-identity',
        'fail',
        'Packaged manifest publisher/name does not match the expected Marketplace identity',
        [
          `publisher: ${content.publisher} (expected ${EXPECTED_MARKETPLACE_PUBLISHER})`,
          `name: ${content.name} (expected ${EXPECTED_PACKAGE_NAME})`,
          `id: ${packagedId} (expected ${EXPECTED_EXTENSION_ID})`,
        ],
      );
    }
  } else {
    record('vsix-manifest-version', 'fail', 'extension/package.json not found inside VSIX.');
    record('vsix-manifest-identity', 'fail', 'extension/package.json not found inside VSIX.');
  }

  // Credential-pattern scan over small text entries only (skip binaries and anything huge).
  const findings = [];
  for (const entry of entries) {
    if (!isLikelyTextFile(entry.fileName) || entry.uncompressedSize > 2 * 1024 * 1024) continue;
    let text;
    try {
      text = readZipEntryContent(buffer, entry).toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { name, pattern } of CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) findings.push(`${entry.fileName}:${index + 1} [${name}]`);
      }
    });
  }
  if (findings.length === 0) {
    record(
      'vsix-credential-scan',
      'pass',
      'No credential-shaped patterns found inside VSIX text entries.',
    );
  } else {
    record(
      'vsix-credential-scan',
      'fail',
      `${findings.length} credential-shaped match(es) inside VSIX`,
      findings.slice(0, 25),
    );
  }

  return { buffer, entries, sizeBytes };
}

// ---------------------------------------------------------------------------
// 8. Hash reporting (informational — used by the manual verification step,
//    never a pass/fail gate on its own since hashes legitimately change).
// ---------------------------------------------------------------------------

function reportHashes(vsixResult) {
  const targets = [
    'out/extension.js',
    'out/ui/SafeDashboard.js',
    'out/ui/ProviderStatusBarTooltip.js',
    'package.nls.json',
    'package.nls.tr.json',
    'assets/icon.png',
    'scripts/release-audit.mjs',
  ];
  const lines = [];
  for (const t of targets) {
    const full = path.join(ROOT, t);
    if (!existsSync(full)) {
      lines.push(`${t}: (not built — run npm run compile)`);
      continue;
    }
    lines.push(`${t}: sha256:${sha256(readFileSync(full))}`);
  }
  if (vsixResult) {
    lines.push(`VSIX file: sha256:${sha256(vsixResult.buffer)} (${vsixResult.sizeBytes} bytes)`);
  }
  record(
    'hashes',
    'pass',
    'Content hashes for manual before/after comparison (informational only).',
    lines,
  );
}

// ---------------------------------------------------------------------------
// 9. Marketplace identity, listing, and asset checks (Task 13)
// ---------------------------------------------------------------------------

export const EXPECTED_MARKETPLACE_PUBLISHER = 'fatihdumlupinar-dev';
export const EXPECTED_PACKAGE_NAME = 'ai-limit-ledger';
export const EXPECTED_EXTENSION_ID = `${EXPECTED_MARKETPLACE_PUBLISHER}.${EXPECTED_PACKAGE_NAME}`;
// Task 14 is the deliberate, separate version-bump task referenced by the Task 13 comment this
// replaces: it raises the first Marketplace release to 0.7.0. Update this constant only as part
// of a deliberate version-bump task — never as a side effect of an unrelated change.
export const EXPECTED_TASK_VERSION = '0.7.0';

export const PLACEHOLDER_PUBLISHER_VALUES = new Set([
  'local',
  'test',
  'example',
  'placeholder',
  'your-publisher-id',
  'undefined',
  '',
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkPublisherIdentity() {
  const pkg = readJson('package.json');
  const publisher = pkg.publisher;
  const issues = [];
  if (publisher !== EXPECTED_MARKETPLACE_PUBLISHER) {
    issues.push(`publisher is "${publisher}", expected "${EXPECTED_MARKETPLACE_PUBLISHER}"`);
  }
  if (PLACEHOLDER_PUBLISHER_VALUES.has(String(publisher).toLowerCase())) {
    issues.push(`publisher "${publisher}" looks like a placeholder value`);
  }
  if (issues.length === 0) {
    record(
      'marketplace-publisher',
      'pass',
      `publisher is exactly "${EXPECTED_MARKETPLACE_PUBLISHER}", not a placeholder.`,
    );
  } else {
    record('marketplace-publisher', 'fail', 'Marketplace publisher identity is incorrect', issues);
  }
}

function checkExtensionIdentity() {
  const pkg = readJson('package.json');
  const issues = [];
  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    issues.push(`name is "${pkg.name}", expected "${EXPECTED_PACKAGE_NAME}"`);
  }
  const actualId = `${pkg.publisher}.${pkg.name}`;
  if (actualId !== EXPECTED_EXTENSION_ID) {
    issues.push(`computed extension id is "${actualId}", expected "${EXPECTED_EXTENSION_ID}"`);
  }
  if (pkg.version !== EXPECTED_TASK_VERSION) {
    issues.push(
      `version is "${pkg.version}", expected "${EXPECTED_TASK_VERSION}" (unchanged by Task 13)`,
    );
  }
  if (pkg.private !== true) {
    issues.push('private is not exactly true');
  }
  if (pkg.preview !== true) {
    issues.push('preview is not exactly true (expected for the first Marketplace release)');
  }
  if (issues.length === 0) {
    record(
      'marketplace-extension-identity',
      'pass',
      `Extension identity is ${EXPECTED_EXTENSION_ID}, version ${EXPECTED_TASK_VERSION}, private+preview.`,
    );
  } else {
    record(
      'marketplace-extension-identity',
      'fail',
      'Extension identity/version/private/preview mismatch',
      issues,
    );
  }
}

function checkRepositoryLinks() {
  const pkg = readJson('package.json');
  const issues = [];
  const expectedRepoUrl = 'git+https://github.com/Fatih-Dumlupinar/ai-limit-ledger.git';
  const expectedHomepage = 'https://github.com/Fatih-Dumlupinar/ai-limit-ledger#readme';
  const expectedBugs = 'https://github.com/Fatih-Dumlupinar/ai-limit-ledger/issues';
  if (pkg.repository?.url !== expectedRepoUrl) {
    issues.push(`repository.url is "${pkg.repository?.url}", expected "${expectedRepoUrl}"`);
  }
  if (pkg.homepage !== expectedHomepage) {
    issues.push(`homepage is "${pkg.homepage}", expected "${expectedHomepage}"`);
  }
  if (pkg.bugs?.url !== expectedBugs) {
    issues.push(`bugs.url is "${pkg.bugs?.url}", expected "${expectedBugs}"`);
  }
  if (pkg.license !== 'MIT') {
    issues.push(`license is "${pkg.license}", expected "MIT"`);
  }
  if (issues.length === 0) {
    record(
      'marketplace-links',
      'pass',
      'repository/homepage/bugs/license all match the expected GitHub owner/repo and MIT license.',
    );
  } else {
    record(
      'marketplace-links',
      'fail',
      'One or more identity links do not match the expected values',
      issues,
    );
  }
}

function checkIconAsset() {
  const pkg = readJson('package.json');
  const iconField = pkg.icon;
  const issues = [];
  if (!iconField || !iconField.toLowerCase().endsWith('.png')) {
    issues.push(`icon field "${iconField}" is not a .png path (SVG icons are not permitted)`);
  }
  const iconPath = iconField ? path.join(ROOT, iconField) : null;
  if (!iconPath || !existsSync(iconPath)) {
    issues.push(`icon file not found at "${iconField}"`);
  } else {
    const buf = readFileSync(iconPath);
    const isPng = buf.length > 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    if (!isPng) {
      issues.push('icon file does not have a valid PNG signature');
    } else if (buf.length >= 24) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width < 128 || height < 128) {
        issues.push(`icon is ${width}x${height}, below the 128x128 Marketplace minimum`);
      }
    }
  }
  if (issues.length === 0) {
    record('marketplace-icon', 'pass', 'Icon is a PNG at least 128x128.');
  } else {
    record('marketplace-icon', 'fail', 'Icon does not meet Marketplace requirements', issues);
  }
}

export const MARKETPLACE_CATEGORY_ALLOWLIST = new Set([
  'Programming Languages',
  'Snippets',
  'Linters',
  'Themes',
  'Debuggers',
  'Formatters',
  'Keymaps',
  'SCM Providers',
  'Other',
  'Extension Packs',
  'Language Packs',
  'Data Science',
  'Machine Learning',
  'Visualization',
  'Notebooks',
  'Education',
  'Testing',
]);

function checkCategoriesAndKeywords() {
  const pkg = readJson('package.json');
  const categories = pkg.categories || [];
  const keywords = pkg.keywords || [];
  const issues = [];
  const invalidCategories = categories.filter((c) => !MARKETPLACE_CATEGORY_ALLOWLIST.has(c));
  if (invalidCategories.length > 0) {
    issues.push(`categories not on the Marketplace allowlist: ${invalidCategories.join(', ')}`);
  }
  if (categories.includes('Machine Learning')) {
    issues.push(
      '"Machine Learning" is not an accurate category — this extension reads provider usage metadata, it does not perform ML inference',
    );
  }
  if (keywords.length > 30) {
    issues.push(`${keywords.length} keywords exceeds the Marketplace limit of 30`);
  }
  const lower = keywords.map((k) => k.toLowerCase());
  const duplicates = lower.filter((k, i) => lower.indexOf(k) !== i);
  if (duplicates.length > 0) {
    issues.push(`duplicate keyword(s): ${[...new Set(duplicates)].join(', ')}`);
  }
  if (issues.length === 0) {
    record(
      'marketplace-categories-keywords',
      'pass',
      `${categories.length} valid categor(y/ies), ${keywords.length}/30 unique keywords.`,
    );
  } else {
    record('marketplace-categories-keywords', 'fail', 'Category/keyword policy violation', issues);
  }
}

export const REQUIRED_README_EN_SECTIONS = [
  'Why AI Limit Ledger?',
  'Screenshots',
  'Quick start',
  'What this extension reads',
  'What this extension does not read or store',
  'Commands',
  'Support',
  'Non-affiliation',
  'Known limitations',
  'Troubleshooting',
  'Settings',
  'License',
];

export const REQUIRED_README_TR_SECTIONS = [
  'Neden AI Limit Ledger?',
  'Ekran görüntüleri',
  'Hızlı başlangıç',
  'Bu eklenti neyi okur',
  'Bu eklenti neyi okumaz veya saklamaz',
  'Komutlar',
  'Destek',
  'Bağlantısızlık bildirimi',
  'Bilinen sınırlamalar',
  'Sorun giderme',
  'Ayarlar',
  'Lisans',
];

function checkReadmeSections() {
  const en = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const tr = readFileSync(path.join(ROOT, 'README.tr.md'), 'utf8');
  const missingEn = REQUIRED_README_EN_SECTIONS.filter(
    (h) => !new RegExp(`^#{1,3}\\s+${escapeRegExp(h)}\\s*$`, 'm').test(en),
  );
  const missingTr = REQUIRED_README_TR_SECTIONS.filter(
    (h) => !new RegExp(`^#{1,3}\\s+${escapeRegExp(h)}\\s*$`, 'm').test(tr),
  );
  if (missingEn.length === 0 && missingTr.length === 0) {
    record(
      'marketplace-readme-sections',
      'pass',
      'All required README.md/README.tr.md sections are present.',
    );
  } else {
    record('marketplace-readme-sections', 'fail', 'Required README sections are missing', [
      ...missingEn.map((h) => `README.md missing: "${h}"`),
      ...missingTr.map((h) => `README.tr.md missing: "${h}"`),
    ]);
  }
}

function checkNonAffiliationStatement() {
  const en = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const tr = readFileSync(path.join(ROOT, 'README.tr.md'), 'utf8');
  const providers = ['Microsoft', 'GitHub', 'OpenAI', 'Anthropic', 'xAI'];
  const enOk =
    /not affiliated with,?\s*endorsed by,?\s*or sponsored by/i.test(en) &&
    providers.every((p) => en.includes(p));
  const trOk = /bağlantılı\s+değildir/i.test(tr) && providers.every((p) => tr.includes(p));
  if (enOk && trOk) {
    record(
      'marketplace-non-affiliation',
      'pass',
      'Non-affiliation notice present in both README.md and README.tr.md, naming all five providers.',
    );
  } else {
    record('marketplace-non-affiliation', 'fail', 'Non-affiliation notice missing or incomplete', [
      `README.md: ${enOk ? 'ok' : 'missing/incomplete'}`,
      `README.tr.md: ${trOk ? 'ok' : 'missing/incomplete'}`,
    ]);
  }
}

export const FORBIDDEN_MARKETING_CLAIMS = [
  { name: 'measures-all-usage', pattern: /measures?\s+all\s+(of\s+)?(your\s+)?AI\s+usage/i },
  { name: 'all-data-official', pattern: /all\s+usage\s+data\s+comes?\s+from\s+official/i },
  { name: 'no-credential-ever-read', pattern: /no\s+credentials?\s+(is|are)\s+ever\s+read/i },
  { name: 'all-providers-realtime', pattern: /all\s+provider\s+data\s+is\s+real-?time/i },
  { name: 'all-quotas-comparable', pattern: /all\s+provider\s+quotas?\s+are\s+comparable/i },
  {
    name: 'claude-account-wide-total',
    pattern: /Claude\s+session\s+metrics?\s+(is|are)\s+an?\s+account[-\s]wide\s+total/i,
  },
  {
    name: 'grok-exact-percentage',
    pattern: /Grok\s+Free\s+accounts?\s+shows?\s+(an?\s+)?exact\s+usage\s+percentage/i,
  },
  {
    name: 'copilot-allowance-guaranteed',
    pattern: /Copilot\s+allowance\s+is\s+provided\s+for\s+every\s+account/i,
  },
  { name: 'fully-independent-official', pattern: /fully\s+independent\s+official\s+product/i },
];

function checkNoOverstatedClaims() {
  const files = ['README.md', 'README.tr.md'];
  const hits = [];
  for (const file of files) {
    const content = readFileSync(path.join(ROOT, file), 'utf8');
    for (const { name, pattern } of FORBIDDEN_MARKETING_CLAIMS) {
      if (pattern.test(content)) hits.push(`${file}: ${name}`);
    }
  }
  if (hits.length === 0) {
    record(
      'marketplace-no-overstated-claims',
      'pass',
      'No overstated/absolute marketing claims found in README.md/README.tr.md.',
    );
  } else {
    record('marketplace-no-overstated-claims', 'fail', 'Overstated marketing claim(s) found', hits);
  }
}

function checkReadmeImageLinks() {
  const files = ['README.md', 'README.tr.md'];
  const insecure = [];
  for (const file of files) {
    const content = readFileSync(path.join(ROOT, file), 'utf8');
    const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = imgPattern.exec(content))) {
      const url = m[1];
      if (/^http:\/\//i.test(url) || /^file:\/\//i.test(url) || /^[A-Za-z]:\\/.test(url)) {
        insecure.push(`${file}: ${url}`);
      }
    }
  }
  if (insecure.length === 0) {
    record(
      'marketplace-readme-image-links',
      'pass',
      'No insecure (http/file/local-path) image links in README files.',
    );
  } else {
    record(
      'marketplace-readme-image-links',
      'fail',
      'Insecure image link(s) found in README',
      insecure,
    );
  }
}

/**
 * Returns every `assets/marketplace/...` path referenced by a Markdown image link in `content`
 * for which `existsChecker(relPath)` returns false. Pure (no filesystem access itself), so tests
 * can pass synthetic README content and a fake existence checker instead of touching real files.
 */
export function findMissingScreenshotLinks(content, existsChecker) {
  const missing = [];
  const imgPattern = /!\[[^\]]*\]\((assets\/marketplace\/[^)]+)\)/g;
  let m;
  while ((m = imgPattern.exec(content))) {
    if (!existsChecker(m[1])) missing.push(m[1]);
  }
  return missing;
}

function checkReadmeScreenshotLinksNotBroken() {
  // Screenshots are optional (Task 13.1) — this check only guards against a *dangling* reference:
  // a README that links to assets/marketplace/<file>.png which does not exist on disk. When no
  // screenshots exist at all, README.md/README.tr.md simply have no such links (verified
  // separately in checkReadmeImageLinks-adjacent tests), which trivially passes here too.
  const files = ['README.md', 'README.tr.md'];
  const broken = [];
  for (const file of files) {
    const content = readFileSync(path.join(ROOT, file), 'utf8');
    const missing = findMissingScreenshotLinks(content, (relPath) =>
      existsSync(path.join(ROOT, relPath)),
    );
    broken.push(...missing.map((relPath) => `${file}: references missing ${relPath}`));
  }
  if (broken.length === 0) {
    record(
      'marketplace-readme-screenshot-links',
      'pass',
      'README.md/README.tr.md reference no missing assets/marketplace screenshot files.',
    );
  } else {
    record(
      'marketplace-readme-screenshot-links',
      'fail',
      'README references a Marketplace screenshot file that does not exist on disk',
      broken,
    );
  }
}

export const PUBLISH_INVOCATION_PATTERN = /vsce\s+publish|vsce\.publish\s*\(|ovsx\s+publish/;

async function checkNoPublishAutomation() {
  const pkg = readJson('package.json');
  const scriptHits = Object.entries(pkg.scripts || {}).filter(([, cmd]) =>
    PUBLISH_INVOCATION_PATTERN.test(cmd),
  );

  const workflowFiles = (await walk('.github')).filter((f) => /\.ya?ml$/.test(f));
  const workflowHits = [];
  for (const f of workflowFiles) {
    const content = readFileSync(path.join(ROOT, f), 'utf8');
    if (PUBLISH_INVOCATION_PATTERN.test(content)) workflowHits.push(f);
  }

  // This file's own comments/messages necessarily discuss the concept of a publish invocation
  // (e.g. this very check's name and messages) without actually invoking one — exclude it from
  // its own scripts/ scan rather than trying to keep every message forever free of a substring
  // match against PUBLISH_INVOCATION_PATTERN.
  const selfPath = fileURLToPath(import.meta.url);
  const scriptDirFiles = (await walk('scripts')).filter(
    (f) => isLikelyTextFile(f) && path.resolve(ROOT, f) !== selfPath,
  );
  const scriptDirHits = [];
  for (const f of scriptDirFiles) {
    const content = readFileSync(path.join(ROOT, f), 'utf8');
    if (PUBLISH_INVOCATION_PATTERN.test(content)) scriptDirHits.push(f);
  }

  const hits = [
    ...scriptHits.map(([name]) => `package.json script "${name}"`),
    ...workflowHits,
    ...scriptDirHits,
  ];
  if (hits.length === 0) {
    record(
      'marketplace-no-publish-automation',
      'pass',
      'No Marketplace publish-command invocation (vsce/ovsx) found in package.json scripts, .github workflows, or scripts/.',
    );
  } else {
    record(
      'marketplace-no-publish-automation',
      'fail',
      'A publish invocation was found — Task 13 must not add release automation',
      hits,
    );
  }
}

function checkNoEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (existsSync(envPath)) {
    record(
      'marketplace-no-env-file',
      'fail',
      'A .env file exists in the repository root — must never be committed.',
    );
  } else {
    record('marketplace-no-env-file', 'pass', 'No .env file present in the repository root.');
  }
}

export const MARKETPLACE_SCREENSHOT_FILENAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*\.png$/;
export const MAX_SCREENSHOT_BYTES = 1024 * 1024; // 1 MB budget per Marketplace screenshot

/**
 * Validates one screenshot's bytes/filename in isolation (pure — no filesystem access, no
 * `record()` side effect), so it can be exercised directly by tests against synthetic buffers.
 * Returns an array of human-readable issue strings; empty means the file passes every check.
 */
export function validateScreenshotFile(fileName, buffer) {
  const issues = [];
  const isPng = buffer.length > 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (!isPng) issues.push(`${fileName}: not a valid PNG signature`);
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    issues.push(
      `${fileName}: ${buffer.length} bytes exceeds the ${MAX_SCREENSHOT_BYTES} byte budget`,
    );
  }
  if (!MARKETPLACE_SCREENSHOT_FILENAME_PATTERN.test(fileName)) {
    issues.push(`${fileName}: filename does not match the lowercase-kebab-case.png policy`);
  }
  // Scan raw bytes (including any embedded tEXt/iTXt metadata) as Latin-1 text for
  // personal-path-shaped and credential/token-shaped content.
  const text = buffer.toString('latin1');
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text) && !KNOWN_SAFE_FIXTURE_MARKERS.test(text)) {
      issues.push(`${fileName}: possible personal path found in PNG bytes/metadata`);
    }
  }
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text) && !KNOWN_SAFE_FIXTURE_MARKERS.test(text)) {
      issues.push(
        `${fileName}: possible credential-shaped content found in PNG bytes/metadata [${name}]`,
      );
    }
  }
  return issues;
}

/**
 * Scans a directory of (optional) Marketplace screenshots and returns a {severity, summary,
 * details} result — pure with respect to `record()` (the caller decides how to report it), so
 * tests can point this at an isolated temp directory instead of the real `assets/marketplace/`.
 *
 * Screenshots are an optional Marketplace enhancement (Task 13.1) — there is no manifest field for
 * them and no VS Code/Marketplace publishing requirement that they exist (see
 * docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md). Their absence is therefore always "pass", never
 * "warn"/"fail" — only files that *are* present get validated, and only a genuine policy violation
 * on a present file produces anything other than pass.
 */
export async function scanMarketplaceScreenshots(absoluteDir) {
  if (!existsSync(absoluteDir)) {
    return {
      severity: 'pass',
      summary:
        'No Marketplace screenshots present — screenshots are optional and this is a fully supported state. See docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md if adding real ones later.',
    };
  }
  const entries = await readdir(absoluteDir);
  const pngFiles = entries.filter((f) => f.toLowerCase().endsWith('.png'));
  if (pngFiles.length === 0) {
    return {
      severity: 'pass',
      summary:
        'assets/marketplace/ exists but contains no screenshots yet — optional, fully supported state.',
    };
  }
  const issues = [];
  for (const file of pngFiles) {
    const buf = readFileSync(path.join(absoluteDir, file));
    issues.push(...validateScreenshotFile(file, buf));
  }
  if (issues.length === 0) {
    return {
      severity: 'pass',
      summary: `${pngFiles.length} Marketplace screenshot(s) present and pass format/size/filename/personal-data/credential checks.`,
    };
  }
  return {
    severity: 'fail',
    summary: 'Marketplace screenshot policy violation(s)',
    details: issues,
  };
}

async function checkMarketplaceScreenshotAssets() {
  const result = await scanMarketplaceScreenshots(path.join(ROOT, 'assets/marketplace'));
  record('marketplace-screenshots', result.severity, result.summary, result.details);
}

function checkPackagedReadmeImages(vsixResult) {
  if (!vsixResult) return;
  const readmeEntry = vsixResult.entries.find((e) => e.fileName === 'extension/readme.md');
  if (!readmeEntry) {
    record('vsix-readme-images', 'warn', 'No packaged extension/readme.md found to check.');
    return;
  }
  const content = readZipEntryContent(vsixResult.buffer, readmeEntry).toString('utf8');
  const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  const broken = [];
  let m;
  while ((m = imgPattern.exec(content))) {
    const url = m[1];
    if (/^https:\/\//i.test(url)) continue; // rewritten-to-GitHub or already absolute HTTPS
    broken.push(
      /^http:\/\//i.test(url) || /^file:\/\//i.test(url) || /^[A-Za-z]:\\/.test(url)
        ? `${url} (insecure/local scheme)`
        : `${url} (unexpected unrewritten relative path in packaged README)`,
    );
  }
  if (broken.length === 0) {
    record(
      'vsix-readme-images',
      'pass',
      'Packaged README has no insecure or unrewritten-relative image links.',
    );
  } else {
    record('vsix-readme-images', 'fail', 'Packaged README image link issue(s)', broken);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const vsixArg = process.argv[2];

  checkVersionConsistency();
  await checkAbsoluteUserPaths();
  await checkCredentialPatterns();
  checkSupplyChain();
  checkRequiredSourceFiles();
  checkLocalizationParity();

  checkPublisherIdentity();
  checkExtensionIdentity();
  checkRepositoryLinks();
  checkIconAsset();
  checkCategoriesAndKeywords();
  checkReadmeSections();
  checkNonAffiliationStatement();
  checkNoOverstatedClaims();
  checkReadmeImageLinks();
  checkReadmeScreenshotLinksNotBroken();
  await checkNoPublishAutomation();
  checkNoEnvFile();
  await checkMarketplaceScreenshotAssets();

  let vsixResult;
  if (vsixArg) {
    const vsixPath = path.isAbsolute(vsixArg) ? vsixArg : path.join(ROOT, vsixArg);
    if (!existsSync(vsixPath)) {
      record('vsix-presence', 'fail', `VSIX path given but not found: ${vsixArg}`);
    } else {
      vsixResult = checkVsixContent(vsixPath);
      checkPackagedReadmeImages(vsixResult);
    }
  } else {
    record(
      'vsix-presence',
      'warn',
      'No VSIX path given — run "npm run package" then "npm run audit:release -- <file>.vsix" to audit the packaged output.',
    );
  }

  reportHashes(vsixResult);

  // ---- report ----
  const width = { pass: '✓', warn: '~', fail: '✗' };
  let failCount = 0;
  let warnCount = 0;
  console.log('\nAI Limit Ledger — release audit\n' + '='.repeat(40));
  for (const r of results) {
    if (r.severity === 'fail') failCount++;
    if (r.severity === 'warn') warnCount++;
    console.log(`\n[${width[r.severity]}] ${r.id}: ${r.summary}`);
    if (r.details) for (const d of r.details) console.log(`    ${d}`);
  }
  console.log(
    `\n${'='.repeat(40)}\n${results.length} checks: ${results.length - failCount - warnCount} pass, ${warnCount} warn, ${failCount} fail\n`,
  );

  process.exitCode = failCount > 0 ? 1 : 0;
}

// Only auto-run when executed directly (`node scripts/release-audit.mjs`), never on import —
// this file is also imported as a plain ES module by test/ReleaseAudit.test.ts to unit-test its
// pure ZIP/pattern-matching logic without spawning a process or triggering a full audit run.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error('release-audit crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
