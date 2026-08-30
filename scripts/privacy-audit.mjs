#!/usr/bin/env node
/**
 * Privacy / personal-data audit for AI Limit Ledger (Task 14.2).
 *
 * This is not a secret scanner, and it does not replace one. GitHub's secret scanning and the
 * repository's Gitleaks job answer "is there a credential here that a provider would recognize and
 * revoke?". This tool answers a different, broader question that no upstream service asks on our
 * behalf: **does anything in this repository, its history, or its published package reveal who
 * built it or what machine it was built on?** A developer's user-profile path, a hostname, a LAN
 * address, a source map pointing at a build directory, or a VS Code profile path is not a secret —
 * nothing will ever revoke it — but it is exactly the kind of thing that should never ship to a
 * Marketplace user, and it is invisible to a credential scanner.
 *
 * Design constraints (identical to the repository's other tooling):
 * - Node built-ins only. No dependency is added to a zero-dependency extension.
 * - Offline and read-only. No network, no provider calls, no credential store, no `.env`, no VS
 *   Code SecretStorage. It reads repository content and nothing else.
 * - Scoped to the repository. It refuses to follow a symlink out of the repository root, and it
 *   never walks the user's home directory or the machine at large.
 * - **It never prints a matched value.** Terminal output, the JSON report, and anything a CI job
 *   could echo carry only a pattern id, a location, a structural mask, and a fingerprint. The raw
 *   match is discarded the moment it is classified (see `scripts/lib/privacy-patterns.mjs`).
 * - Fail-closed. A crash, a timeout, a subprocess error, or an unreadable input is a non-zero
 *   exit, never a silent pass.
 *
 * Usage:
 *   node scripts/privacy-audit.mjs                      # tracked source tree (default)
 *   node scripts/privacy-audit.mjs --history            # all reachable git history
 *   node scripts/privacy-audit.mjs --vsix <file.vsix>   # packaged VSIX, read without extracting
 *   node scripts/privacy-audit.mjs --json <report.json> # additionally write a redacted report
 *
 * Exit codes: 0 clean, 1 finding(s) require review, 2 the audit itself failed.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRIVACY_PATTERNS,
  PRIVACY_PATTERNS_BY_ID,
  classifyMatch,
  fingerprint,
  formatFindingLine,
  isHighEntropyCandidate,
  maskValue,
} from './lib/privacy-patterns.mjs';
import { readZipEntries, readZipEntryContent, unsafeZipEntryReason } from './lib/zip-reader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Limits
//
// Every limit here is a *documented refusal*, not a silent truncation: whenever one is hit the
// file is recorded as skipped with a machine-readable reason and appears in the report, so a large
// or unreadable file can never make the audit quietly cover less ground than it claims.
// ---------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  /** Largest single file/blob/entry that is scanned as text. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Total bytes across one run before the audit stops and fails rather than silently truncating. */
  maxTotalBytes: 512 * 1024 * 1024,
  /** Longest single line examined; a longer line is a minified bundle, not prose. */
  maxLineLength: 8192,
  /** Wall-clock budget for the whole run. */
  timeoutMs: 10 * 60 * 1000,
  /** Wall-clock budget for any one git subprocess. */
  gitTimeoutMs: 120 * 1000,
});

/** File extensions that are read as binary and checked structurally, never as blind text. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.vsix',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.exe',
  '.dll',
  '.node',
]);

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export const ALLOWLIST_PATH = 'scripts/privacy-allowlist.json';

/**
 * Validates an allowlist so it cannot become a blanket mute button.
 *
 * Three rules, each learned from how suppression lists normally rot:
 *  - every entry names exactly one known `patternId` (no "suppress everything here");
 *  - every entry names one concrete `path` with no wildcard segment (no `test/**`);
 *  - every entry carries a human `reason`.
 *
 * Deliberately absent: any way to allowlist a *value*. An allowlist entry can say "this pattern is
 * expected at this fixture path"; it can never contain the personal data it is excusing, which
 * would put the very thing the audit exists to keep out of the repository into a committed file.
 */
export function validateAllowlist(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return ['allowlist must be an array of entries'];
  entries.forEach((entry, index) => {
    const at = `allowlist[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const { patternId, path: entryPath, reason } = entry;
    if (typeof patternId !== 'string' || !PRIVACY_PATTERNS_BY_ID[patternId]) {
      errors.push(`${at}.patternId must be one known pattern id`);
    }
    if (typeof entryPath !== 'string' || entryPath.length === 0) {
      errors.push(`${at}.path must be a repository-relative path`);
    } else {
      if (entryPath.includes('*') || entryPath.includes('?')) {
        errors.push(`${at}.path must not use a wildcard — name the exact fixture file`);
      }
      if (entryPath.startsWith('/') || /^[A-Za-z]:/.test(entryPath) || entryPath.includes('..')) {
        errors.push(`${at}.path must be a repository-relative path without traversal`);
      }
    }
    if (typeof reason !== 'string' || reason.trim().length < 12) {
      errors.push(`${at}.reason must explain why the match is expected`);
    }
    for (const key of Object.keys(entry)) {
      if (!['patternId', 'path', 'reason'].includes(key)) {
        errors.push(`${at} has an unexpected field "${key}"`);
      }
    }
  });
  return errors;
}

/** True when `entry` suppresses this exact pattern at this exact path. */
export function allowlistMatches(entries, patternId, relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/');
  return entries.some(
    (entry) =>
      entry.patternId === patternId && String(entry.path).replaceAll('\\', '/') === normalized,
  );
}

function loadAllowlist(root) {
  const full = path.join(root, ALLOWLIST_PATH);
  if (!existsSync(full)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    throw new Error(`${ALLOWLIST_PATH} is not valid JSON`);
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.allow;
  const errors = validateAllowlist(entries);
  if (errors.length > 0) throw new Error(`${ALLOWLIST_PATH} is invalid:\n- ${errors.join('\n- ')}`);
  return entries;
}

// ---------------------------------------------------------------------------
// Content classification
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

/**
 * Reads a PNG's *metadata chunks only*.
 *
 * Scanning a PNG as if it were text is worse than useless: the deflate-compressed pixel stream
 * reliably produces byte runs that look like email addresses and tokens, which is precisely the
 * false positive the initial manual audit of this repository's icon hit. The real risk in a PNG is
 * the metadata an export tool writes — author, software, GPS, source file path — so this walks the
 * chunk structure and returns only the textual chunks, and returns `null` for anything that is not
 * a structurally valid PNG.
 */
export function readPngTextMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return chunks;
    if (type === 'IEND') break;
    if (length > buffer.length) return chunks;
    if (PNG_METADATA_CHUNKS.has(type)) {
      const data = buffer.subarray(offset + 8, offset + 8 + length);
      chunks.push({ type, text: data.toString('latin1') });
    }
    offset += 12 + length;
  }
  return chunks;
}

/** Heuristic: a NUL byte in the first 8 KiB means "not text". */
export function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Decodes a buffer as UTF-8, refusing silently-lossy decoding.
 *
 * `Buffer.toString('utf8')` replaces invalid sequences with U+FFFD rather than failing, which would
 * let malformed bytes reach the pattern engine as plausible-looking text. Using `TextDecoder` in
 * fatal mode makes invalid UTF-8 a deterministic, reported skip instead.
 */
export function decodeUtf8Strict(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scanner core
// ---------------------------------------------------------------------------

/**
 * Scans one unit of text and returns redacted findings.
 *
 * The raw matched value exists only inside this function: it is fingerprinted, masked, classified,
 * and then dropped. Nothing it returns can be un-redacted.
 */
export function scanText({ text, location, surface, commit, allowlist = [] }) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > LIMITS.maxLineLength) continue;

    for (const definition of PRIVACY_PATTERNS) {
      // A fresh RegExp per line keeps the module-level `g` patterns free of shared `lastIndex`
      // state, which would otherwise make results depend on scan order.
      const expression = new RegExp(definition.pattern.source, definition.pattern.flags);
      let match;
      while ((match = expression.exec(line)) !== null) {
        if (match[0].length === 0) {
          expression.lastIndex += 1;
          continue;
        }
        const { classification, reason } = classifyMatch(definition.id, match[0]);
        const suppressed = allowlistMatches(allowlist, definition.id, location);
        findings.push({
          patternId: definition.id,
          kind: definition.kind,
          severity: definition.severity,
          description: definition.description,
          path: location,
          line: index + 1,
          commit,
          surface,
          classification:
            suppressed && classification === 'finding' ? 'allowlisted' : classification,
          reason:
            suppressed && classification === 'finding' ? 'allowlisted fixture location' : reason,
          masked: maskValue(definition.id, match[0]),
          fingerprint: fingerprint(match[0]),
        });
      }
    }

    // High-entropy sweep runs only on tokens no declared pattern already claimed, so a token that
    // is already reported as a GitHub PAT is not also reported as "unexplained entropy".
    for (const token of line.match(/[A-Za-z0-9+/=_-]{24,512}/g) ?? []) {
      if (!isHighEntropyCandidate(token)) continue;
      const alreadyReported = findings.some(
        (finding) => finding.line === index + 1 && finding.fingerprint === fingerprint(token),
      );
      if (alreadyReported) continue;
      const { classification, reason } = classifyMatch('HIGH_ENTROPY_VALUE', token);
      if (classification !== 'finding') continue;
      const suppressed = allowlistMatches(allowlist, 'GENERIC_SECRET_ASSIGNMENT', location);
      if (suppressed) continue;
      findings.push({
        patternId: 'HIGH_ENTROPY_VALUE',
        kind: 'secret',
        severity: 'medium',
        description: 'Long high-entropy literal with no declared pattern — needs an explanation',
        path: location,
        line: index + 1,
        commit,
        surface,
        classification: 'finding',
        reason,
        masked: `<redacted:${token.length} chars>`,
        fingerprint: fingerprint(token),
      });
    }
  }

  return findings;
}

/**
 * Scans one buffer, choosing the right strategy for its type.
 * Returns `{ findings, skipped }` — `skipped` is a documented, reported refusal, never a silent one.
 */
export function scanBuffer({ buffer, location, surface, commit, allowlist = [] }) {
  const extension = path.extname(location).toLowerCase();

  if (buffer.length > LIMITS.maxFileBytes) {
    return {
      findings: [],
      skipped: {
        path: location,
        surface,
        reason: `exceeds ${LIMITS.maxFileBytes}-byte file limit`,
      },
    };
  }

  if (extension === '.png') {
    const chunks = readPngTextMetadata(buffer);
    if (chunks === null) {
      return {
        findings: [],
        skipped: { path: location, surface, reason: 'not a structurally valid PNG' },
      };
    }
    const findings = [];
    for (const chunk of chunks) {
      findings.push(
        ...scanText({
          text: chunk.text,
          location: `${location}#${chunk.type}`,
          surface,
          commit,
          allowlist,
        }),
      );
    }
    return { findings, skipped: null };
  }

  if (BINARY_EXTENSIONS.has(extension) || looksBinary(buffer)) {
    // Binary content is deliberately not pattern-scanned as text. Compressed bytes generate
    // convincing false positives (see the PNG note above) and a real leak inside a binary asset is
    // a packaging question the release audit already answers by entry name and denylist.
    return {
      findings: [],
      skipped: {
        path: location,
        surface,
        reason: 'binary content — checked by signature, not as text',
      },
    };
  }

  const text = decodeUtf8Strict(buffer);
  if (text === null) {
    return { findings: [], skipped: { path: location, surface, reason: 'not valid UTF-8' } };
  }

  return { findings: scanText({ text, location, surface, commit, allowlist }), skipped: null };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    timeout: LIMITS.gitTimeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * Resolves a repository-relative path and refuses anything that escapes the repository root.
 *
 * A symlink is the interesting case: `git ls-files` happily lists one, and following it could walk
 * the audit straight into the user's home directory — the single thing this tool must never read.
 * So the real path is resolved and required to stay under the (also real-path-resolved) root.
 */
export function resolveInsideRoot(root, relativePath) {
  const realRoot = realpathSync(root);
  const candidate = path.resolve(realRoot, relativePath);
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'path could not be resolved' };
  }
  const relative = path.relative(realRoot, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'symlink or path escapes the repository root' };
  }
  return { ok: true, real };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function auditSourceTree(root, allowlist, state) {
  const listed = git(root, ['ls-files', '-z']).split('\u0000').filter(Boolean);
  const findings = [];
  const skipped = [];
  for (const relativePath of listed) {
    const resolved = resolveInsideRoot(root, relativePath);
    if (!resolved.ok) {
      skipped.push({ path: relativePath, surface: 'source-tree', reason: resolved.reason });
      continue;
    }
    const stats = lstatSync(resolved.real);
    if (!stats.isFile()) {
      skipped.push({ path: relativePath, surface: 'source-tree', reason: 'not a regular file' });
      continue;
    }
    state.totalBytes += stats.size;
    if (state.totalBytes > LIMITS.maxTotalBytes) {
      throw new Error('total scan budget exceeded before the source tree was fully scanned');
    }
    const result = scanBuffer({
      buffer: readFileSync(resolved.real),
      location: relativePath,
      surface: 'source-tree',
      commit: null,
      allowlist,
    });
    findings.push(...result.findings);
    if (result.skipped) skipped.push(result.skipped);
  }
  return { findings, skipped, scanned: listed.length };
}

function auditHistory(root, allowlist, state) {
  const findings = [];
  const skipped = [];

  // Commit metadata is a surface of its own: an author/committer address is personal data that
  // lives outside any file's content.
  const identities = new Set(
    git(root, ['log', '--all', '--format=%an|%ae|%cn|%ce']).split('\n').filter(Boolean),
  );
  for (const identity of identities) {
    const [authorName, authorEmail, committerName, committerEmail] = identity.split('|');
    for (const [role, value] of [
      ['author-name', authorName],
      ['author-email', authorEmail],
      ['committer-name', committerName],
      ['committer-email', committerEmail],
    ]) {
      if (!value) continue;
      const patternId = role.endsWith('email') ? 'PERSONAL_EMAIL' : 'HIGH_ENTROPY_VALUE';
      if (!role.endsWith('email')) continue;
      const { classification, reason } = classifyMatch(patternId, value);
      findings.push({
        patternId,
        kind: 'personal-data',
        severity: 'high',
        description: `Git ${role} in commit metadata`,
        path: `git:${role}`,
        line: 0,
        commit: null,
        surface: 'history-metadata',
        classification,
        reason,
        masked: maskValue(patternId, value),
        fingerprint: fingerprint(value),
      });
    }
  }

  const objects = git(root, ['rev-list', '--objects', '--all']).split('\n').filter(Boolean);
  let blobs = 0;
  for (const line of objects) {
    const separator = line.indexOf(' ');
    if (separator === -1) continue;
    const sha = line.slice(0, separator);
    const name = line.slice(separator + 1).trim();
    if (!name) continue;
    let type;
    try {
      type = git(root, ['cat-file', '-t', sha]).trim();
    } catch {
      skipped.push({ path: name, surface: 'history', reason: 'object type could not be read' });
      continue;
    }
    if (type !== 'blob') continue;
    const size = Number(git(root, ['cat-file', '-s', sha]).trim());
    if (!Number.isFinite(size)) {
      throw new Error(`git reported a non-numeric size for blob ${sha.slice(0, 7)}`);
    }
    state.totalBytes += size;
    if (state.totalBytes > LIMITS.maxTotalBytes) {
      throw new Error('total scan budget exceeded before history was fully scanned');
    }
    if (size > LIMITS.maxFileBytes) {
      skipped.push({
        path: `${sha.slice(0, 7)}:${name}`,
        surface: 'history',
        reason: `blob exceeds ${LIMITS.maxFileBytes}-byte limit`,
      });
      continue;
    }
    blobs += 1;
    const buffer = git(root, ['cat-file', 'blob', sha], { encoding: 'buffer' });
    const result = scanBuffer({
      buffer,
      location: name,
      surface: 'history',
      commit: sha.slice(0, 7),
      allowlist,
    });
    findings.push(...result.findings);
    if (result.skipped) skipped.push(result.skipped);
  }
  attributeBlobsToCommits(root, findings);
  return { findings, skipped, scanned: blobs };
}

/**
 * Replaces the blob object id on each history finding with the commit that introduced that blob.
 *
 * `git rev-list --objects` yields blob ids, but a blob id is not actionable for a human: "which
 * commit put this here" is the question a reviewer actually has. Resolution is done once per
 * distinct blob that produced a finding — a handful at most — rather than for every object walked,
 * because `--find-object` is a full history search each time.
 */
function attributeBlobsToCommits(root, findings) {
  const cache = new Map();
  for (const finding of findings) {
    const blob = finding.commit;
    if (!blob) continue;
    if (!cache.has(blob)) {
      let commit = null;
      try {
        commit = git(root, ['log', '--all', '--format=%h', '-1', `--find-object=${blob}`]).trim();
      } catch {
        commit = null;
      }
      cache.set(blob, commit || blob);
    }
    finding.commit = cache.get(blob);
  }
}

function auditVsix(root, vsixPath, allowlist, state) {
  const absolute = path.isAbsolute(vsixPath) ? vsixPath : path.join(root, vsixPath);
  if (!existsSync(absolute)) throw new Error(`VSIX not found: ${vsixPath}`);
  const buffer = readFileSync(absolute);
  const entries = readZipEntries(buffer);
  if (entries.length === 0) throw new Error('VSIX central directory is empty or unreadable');

  const findings = [];
  const skipped = [];

  for (const entry of entries) {
    // An entry name that would escape the extraction root is a finding about the *package*, not
    // about its content — and it is checked before anything tries to interpret the entry.
    const unsafe = unsafeZipEntryReason(entry.fileName);
    if (unsafe) {
      findings.push({
        patternId: 'VSIX_UNSAFE_ENTRY_PATH',
        kind: 'personal-data',
        severity: 'critical',
        description: 'VSIX entry name would escape the extraction root',
        path: `<vsix-entry:${fingerprint(entry.fileName)}>`,
        line: 0,
        commit: null,
        surface: 'vsix',
        classification: 'finding',
        reason: unsafe,
        masked: '<redacted-entry-name>',
        fingerprint: fingerprint(entry.fileName),
      });
      continue;
    }

    // The entry name itself is scanned: a packaged file whose *name* carries a user path is as much
    // a leak as one whose contents do.
    findings.push(
      ...scanText({
        text: entry.fileName,
        location: `${path.basename(absolute)}!${entry.fileName}`,
        surface: 'vsix-entry-name',
        commit: null,
        allowlist,
      }),
    );

    state.totalBytes += entry.uncompressedSize;
    if (state.totalBytes > LIMITS.maxTotalBytes) {
      throw new Error('total scan budget exceeded before the package was fully scanned');
    }
    if (entry.uncompressedSize > LIMITS.maxFileBytes) {
      skipped.push({
        path: entry.fileName,
        surface: 'vsix',
        reason: `entry exceeds ${LIMITS.maxFileBytes}-byte limit`,
      });
      continue;
    }
    let content;
    try {
      content = readZipEntryContent(buffer, entry);
    } catch (error) {
      skipped.push({
        path: entry.fileName,
        surface: 'vsix',
        reason: `entry could not be inflated: ${error instanceof Error ? error.message : 'unknown'}`,
      });
      continue;
    }
    const result = scanBuffer({
      buffer: content,
      location: `${path.basename(absolute)}!${entry.fileName}`,
      surface: 'vsix',
      commit: null,
      allowlist,
    });
    findings.push(...result.findings);
    if (result.skipped) skipped.push(result.skipped);
  }

  return { findings, skipped, scanned: entries.length };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Splits findings into the report's buckets. Pure, so the summary logic is directly testable. */
export function summarize(findings) {
  const actionable = findings.filter((finding) => finding.classification === 'finding');
  return {
    total: findings.length,
    actionable,
    publicIdentity: findings.filter((finding) => finding.classification === 'public-identity'),
    safeFixtures: findings.filter((finding) => finding.classification === 'safe-fixture'),
    allowlisted: findings.filter((finding) => finding.classification === 'allowlisted'),
    ok: actionable.length === 0,
  };
}

/**
 * Builds the JSON report. Every field is already redacted — this function has no access to a raw
 * value because no finding ever carried one.
 */
export function buildJsonReport({ mode, target, findings, skipped, scanned, startedAt }) {
  const summary = summarize(findings);
  const distinct = (list) => [...new Set(list.map((finding) => finding.fingerprint))].length;
  return {
    tool: 'privacy-audit',
    reportVersion: 1,
    redacted: true,
    mode,
    target: target ?? null,
    generatedAtUtc: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    unitsScanned: scanned,
    limits: LIMITS,
    summary: {
      ok: summary.ok,
      actionable: summary.actionable.length,
      distinctActionableValues: distinct(summary.actionable),
      publicIdentity: summary.publicIdentity.length,
      safeFixtures: summary.safeFixtures.length,
      allowlisted: summary.allowlisted.length,
      skipped: skipped.length,
    },
    findings: findings.map((finding) => ({
      patternId: finding.patternId,
      kind: finding.kind,
      severity: finding.severity,
      description: finding.description,
      path: finding.path,
      line: finding.line,
      commit: finding.commit ?? null,
      surface: finding.surface,
      classification: finding.classification,
      reason: finding.reason,
      masked: finding.masked,
      fingerprint: finding.fingerprint,
    })),
    skipped,
  };
}

function renderReport(mode, target, findings, skipped, scanned) {
  const summary = summarize(findings);
  const heading = target ? `${mode} (${path.basename(target)})` : mode;
  console.log(`\nAI Limit Ledger — privacy audit [${heading}]\n${'='.repeat(46)}`);
  console.log(`units scanned: ${scanned}, skipped: ${skipped.length}`);

  const section = (title, list) => {
    console.log(`\n-- ${title}: ${list.length}`);
    const seen = new Set();
    for (const finding of list) {
      const key = `${finding.patternId}|${finding.fingerprint}|${finding.path}|${finding.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`   ${formatFindingLine(finding)}`);
    }
  };

  // Public identity is expected on nearly every documentation line, so it is grouped by distinct
  // value rather than listed per occurrence — a hundred identical lines would bury the section
  // that actually needs reading.
  const grouped = (title, list) => {
    const byFingerprint = new Map();
    for (const finding of list) {
      const existing = byFingerprint.get(finding.fingerprint);
      if (existing) existing.push(finding);
      else byFingerprint.set(finding.fingerprint, [finding]);
    }
    console.log(
      `\n-- ${title}: ${list.length} occurrence(s), ${byFingerprint.size} distinct value(s)`,
    );
    for (const [value, occurrences] of byFingerprint) {
      const first = occurrences[0];
      console.log(
        `   ${first.patternId} | ${first.severity} | fingerprint:${value} | ` +
          `${occurrences.length} occurrence(s) | e.g. ${first.path}:${first.line}`,
      );
    }
  };

  if (summary.publicIdentity.length > 0) {
    grouped('intentional public identity (expected, not a leak)', summary.publicIdentity);
  }
  if (summary.allowlisted.length > 0) section('allowlisted fixture locations', summary.allowlisted);
  if (summary.actionable.length > 0) section('findings requiring review', summary.actionable);

  if (skipped.length > 0) {
    console.log(`\n-- skipped (documented refusals): ${skipped.length}`);
    for (const entry of skipped.slice(0, 25)) {
      console.log(`   ${entry.surface} | ${entry.path} | ${entry.reason}`);
    }
    if (skipped.length > 25) console.log(`   ... and ${skipped.length - 25} more`);
  }

  console.log(
    `\n${'='.repeat(46)}\n${summary.actionable.length} finding(s) requiring review, ` +
      `${summary.publicIdentity.length} intentional public identity, ` +
      `${summary.safeFixtures.length} safe fixture(s), ${summary.allowlisted.length} allowlisted\n`,
  );
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parses argv into a mode. Unknown flags are rejected rather than ignored. */
export function parseArguments(argv) {
  const options = { mode: 'source', vsix: null, json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--history') {
      options.mode = 'history';
    } else if (argument === '--vsix') {
      options.mode = 'vsix';
      options.vsix = argv[index + 1];
      index += 1;
      if (!options.vsix || options.vsix.startsWith('--')) {
        throw new Error('--vsix requires a path to a .vsix file');
      }
    } else if (argument === '--json') {
      options.json = argv[index + 1];
      index += 1;
      if (!options.json || options.json.startsWith('--')) {
        throw new Error('--json requires an output path');
      }
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const startedAt = Date.now();
  const options = parseArguments(process.argv.slice(2));
  const allowlist = loadAllowlist(ROOT);
  const state = { totalBytes: 0 };

  const deadline = setTimeout(() => {
    console.error(`privacy-audit exceeded its ${LIMITS.timeoutMs}ms budget`);
    process.exit(2);
  }, LIMITS.timeoutMs);
  deadline.unref?.();

  let result;
  if (options.mode === 'history') result = auditHistory(ROOT, allowlist, state);
  else if (options.mode === 'vsix') result = auditVsix(ROOT, options.vsix, allowlist, state);
  else result = auditSourceTree(ROOT, allowlist, state);

  clearTimeout(deadline);

  const summary = renderReport(
    options.mode,
    options.vsix,
    result.findings,
    result.skipped,
    result.scanned,
  );

  if (options.json) {
    const report = buildJsonReport({
      mode: options.mode,
      target: options.vsix,
      findings: result.findings,
      skipped: result.skipped,
      scanned: result.scanned,
      startedAt,
    });
    const outputPath = path.isAbsolute(options.json) ? options.json : path.join(ROOT, options.json);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`redacted JSON report written to ${options.json}`);
  }

  process.exitCode = summary.ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    // Any failure of the audit itself — a git error, a malformed allowlist, an unreadable package —
    // exits 2. It must never be mistaken for "scanned successfully, found nothing".
    console.error('privacy-audit failed:', error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}

export { auditHistory, auditSourceTree, auditVsix };
