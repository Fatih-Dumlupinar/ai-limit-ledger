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
      'CHANGELOG.md',
      'SECURITY.md',
      'PRIVACY.md',
      'SUPPORT.md',
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
  } else {
    record('vsix-manifest-version', 'fail', 'extension/package.json not found inside VSIX.');
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

  let vsixResult;
  if (vsixArg) {
    const vsixPath = path.isAbsolute(vsixArg) ? vsixArg : path.join(ROOT, vsixArg);
    if (!existsSync(vsixPath)) {
      record('vsix-presence', 'fail', `VSIX path given but not found: ${vsixArg}`);
    } else {
      vsixResult = checkVsixContent(vsixPath);
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
