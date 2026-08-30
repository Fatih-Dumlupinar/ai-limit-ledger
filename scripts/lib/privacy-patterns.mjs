/**
 * Shared, dependency-free pattern/redaction primitives for the privacy audit (Task 14.2).
 *
 * Design constraints, identical in spirit to `scripts/release-audit.mjs`:
 * - Node built-ins only (`node:crypto`), no new dependency for a zero-dependency extension.
 * - Pure: every function here is a value-in/value-out predicate or formatter, so the whole
 *   classification surface can be unit-tested without touching a filesystem, a process, or a
 *   network.
 * - **A matched value never leaves this module.** Callers get a fingerprint and a structural mask;
 *   there is deliberately no exported function that returns the raw match. That is what makes it
 *   safe to print a finding to a terminal, a CI log, a job summary, or a JSON report.
 *
 * The three-way triage this module implements is the heart of the audit, and it is not the same as
 * a secret scanner's:
 *
 *   1. `public-identity` — the project's deliberate, already-public identity (the owner's GitHub
 *      handle, the Marketplace publisher id, GitHub's noreply commit address, the repository and
 *      listing URLs). These are *supposed* to be in the repository. They are reported in their own
 *      bucket rather than silently dropped, so an audit can show what identity the project
 *      publishes on purpose instead of pretending it found nothing.
 *   2. `safe-fixture` — an obviously synthetic test value (`C:\Users\fixture\...`,
 *      `user@example.com`, `127.0.0.1`, an RFC-reserved documentation value). The repository's
 *      contributor rules require fixtures to look like this precisely so that this triage is
 *      possible.
 *   3. `finding` — everything else: a value that looks like real personal data or a real
 *      credential, and that a human must look at.
 */

import { createHash } from 'node:crypto';

/** Severity ordering used for exit-code decisions and report sorting. */
export const SEVERITY_ORDER = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

/**
 * Every pattern the audit knows about.
 *
 * `kind` separates the two questions the audit answers: `personal-data` ("does this leak who or
 * which machine built it?") and `secret` ("is this a usable credential?"). Both are reported, but
 * they lead to different remediation advice.
 */
export const PRIVACY_PATTERNS = Object.freeze([
  // --- personal data / machine identity -----------------------------------------------------
  {
    id: 'WINDOWS_USER_PATH',
    kind: 'personal-data',
    severity: 'medium',
    description: 'Windows user-profile path (C:\\Users\\<name>)',
    pattern: /[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._~ -]{1,64}/g,
  },
  {
    id: 'MACOS_HOME_PATH',
    kind: 'personal-data',
    severity: 'medium',
    description: 'macOS home directory path (/Users/<name>)',
    pattern: /\/Users\/[A-Za-z0-9._-]{1,64}/g,
  },
  {
    id: 'LINUX_HOME_PATH',
    kind: 'personal-data',
    severity: 'medium',
    description: 'Linux home directory path (/home/<name>)',
    pattern: /\/home\/[A-Za-z0-9._-]{1,64}/g,
  },
  {
    id: 'UNC_PATH',
    kind: 'personal-data',
    severity: 'medium',
    description: 'Windows UNC/share path (\\\\host\\share)',
    pattern: /(?<![A-Za-z0-9\\])\\\\[A-Za-z0-9._-]{2,63}\\[A-Za-z0-9._$-]{1,63}/g,
  },
  {
    id: 'PERSONAL_EMAIL',
    kind: 'personal-data',
    severity: 'high',
    description: 'Email address',
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g,
  },
  {
    id: 'PRIVATE_IP',
    kind: 'personal-data',
    severity: 'low',
    description: 'Local/private IPv4 address',
    pattern:
      /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'MAC_ADDRESS',
    kind: 'personal-data',
    severity: 'medium',
    description: 'MAC hardware address',
    pattern: /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g,
  },
  {
    id: 'MACHINE_UUID',
    kind: 'personal-data',
    severity: 'low',
    description: 'UUID/GUID that may identify a machine or account',
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  },
  {
    id: 'SOURCE_MAP_ABSOLUTE_PATH',
    kind: 'personal-data',
    severity: 'high',
    description: 'Source map referencing an absolute build-machine path',
    pattern: /"(?:sources|sourceRoot)"\s*:\s*(?:\[\s*)?"(?:[A-Za-z]:[\\/]|\/(?:home|Users)\/)/g,
  },
  {
    id: 'VSCODE_PROFILE_PATH',
    kind: 'personal-data',
    severity: 'medium',
    description: 'VS Code user-data/profile directory path',
    pattern:
      /(?:[A-Za-z]:\\{1,2}|\/)[^\s'"]{0,120}?(?:AppData\\{1,2}Roaming\\{1,2}Code|\.config\/Code|Library\/Application Support\/Code)(?:[\\/][^\s'"]{0,120})?/g,
  },

  {
    // Detecting the project's own identity is not paranoia — it is what lets the report *show* the
    // identity the project publishes on purpose, instead of a bare "nothing found" that leaves a
    // reader unable to tell a genuinely anonymous package from an unexamined one. Every match here
    // classifies as `public-identity` and never fails the audit.
    id: 'PROJECT_PUBLIC_IDENTITY',
    kind: 'personal-data',
    severity: 'info',
    description: 'Deliberate public project identity (owner handle, publisher id, project URL)',
    pattern:
      /\bFatih-Dumlupinar\b|\bfatihdumlupinar-dev(?:\.ai-limit-ledger)?\b|marketplace\.visualstudio\.com\/items/g,
  },

  // --- credentials / secrets ----------------------------------------------------------------
  {
    id: 'GITHUB_TOKEN',
    kind: 'secret',
    severity: 'critical',
    description: 'GitHub personal access / OAuth / refresh token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,255}\b/g,
  },
  {
    id: 'GITHUB_FINE_GRAINED_TOKEN',
    kind: 'secret',
    severity: 'critical',
    description: 'GitHub fine-grained personal access token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  },
  {
    id: 'AZURE_MARKETPLACE_PAT',
    kind: 'secret',
    severity: 'critical',
    description: 'Azure DevOps / Marketplace personal access token assignment',
    pattern:
      /\b(?:VSCE_PAT|AZURE_DEVOPS_(?:EXT_)?PAT|ADO_PAT|MARKETPLACE_(?:TOKEN|PAT)|OVSX_PAT)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{20,}/g,
  },
  {
    id: 'NPM_TOKEN',
    kind: 'secret',
    severity: 'critical',
    description: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: 'OPENAI_STYLE_KEY',
    kind: 'secret',
    severity: 'critical',
    description: 'OpenAI/Anthropic-style provider API key',
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'AWS_ACCESS_KEY_ID',
    kind: 'secret',
    severity: 'critical',
    description: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'PRIVATE_KEY_BLOCK',
    kind: 'secret',
    severity: 'critical',
    description: 'PEM private key material',
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
  },
  {
    id: 'JWT',
    kind: 'secret',
    severity: 'high',
    description: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'AUTHORIZATION_HEADER',
    kind: 'secret',
    severity: 'high',
    description: 'Literal Authorization header value',
    pattern: /\b[Aa]uthorization\s*[:=]\s*['"]?(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    id: 'CONNECTION_STRING',
    kind: 'secret',
    severity: 'high',
    description: 'Database/broker connection string',
    pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?|mssql):\/\/[^\s'"<>]{4,}/g,
  },
  {
    id: 'PASSWORD_IN_URL',
    kind: 'secret',
    severity: 'high',
    description: 'URL whose userinfo component carries a password',
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/'"@]{1,64}:[^\s:/'"@]{1,64}@/g,
  },
  {
    id: 'COOKIE_OR_SESSION',
    kind: 'secret',
    severity: 'high',
    description: 'Cookie/session value assignment',
    pattern:
      /\b(?:set-cookie|session[_-]?(?:id|token)|refresh_token|access_token)\s*[:=]\s*['"][^'"\s]{16,}['"]/gi,
  },
  {
    id: 'GENERIC_SECRET_ASSIGNMENT',
    kind: 'secret',
    severity: 'medium',
    description: 'Generic secret/apikey/password assignment with a long literal value',
    pattern:
      /\b(?:secret|api[_-]?key|password|passwd|client_secret|webhook_secret)\s*[:=]\s*['"][^'"\s]{16,}['"]/gi,
  },
]);

/** Fast lookup by pattern id, used by the allowlist and by report rendering. */
export const PRIVACY_PATTERNS_BY_ID = Object.freeze(
  Object.fromEntries(PRIVACY_PATTERNS.map((entry) => [entry.id, entry])),
);

export const PRIVACY_PATTERN_IDS = Object.freeze(PRIVACY_PATTERNS.map((entry) => entry.id));

// ---------------------------------------------------------------------------
// Intentional public identity
// ---------------------------------------------------------------------------

/**
 * The project's deliberate public identity.
 *
 * These values are published on purpose — they are the repository owner, the Marketplace publisher,
 * and the canonical project URLs. Treating them as leaks would make the audit cry wolf on every
 * run; ignoring them silently would be worse, because then a report saying "no personal data" would
 * be hiding the identity the project genuinely does publish. So they get their own classification
 * and their own section in the report.
 *
 * GitHub's `users.noreply.github.com` commit address is deliberately included: it is the *privacy
 * preserving* address GitHub issues precisely so a real mailbox never appears in commit metadata.
 */
export const PUBLIC_IDENTITY_MATCHERS = Object.freeze([
  {
    id: 'PUBLIC_GITHUB_NOREPLY_EMAIL',
    description: 'GitHub-issued noreply commit address (privacy-preserving by design)',
    pattern: /^(?:[0-9]+\+)?[A-Za-z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com$/i,
  },
  {
    id: 'PUBLIC_GITHUB_SUPPORT_EMAIL',
    description: 'GitHub platform noreply address used by the web-flow committer',
    pattern: /^noreply@github\.com$/i,
  },
  {
    id: 'PUBLIC_OWNER_HANDLE',
    description: 'Repository owner GitHub handle',
    pattern: /^Fatih-Dumlupinar$/i,
  },
  {
    id: 'PUBLIC_MARKETPLACE_PUBLISHER',
    description: 'Marketplace publisher id / extension id',
    pattern: /^fatihdumlupinar-dev(?:\.ai-limit-ledger)?$/i,
  },
  {
    id: 'PUBLIC_PROJECT_URL',
    description: 'Canonical repository or Marketplace listing URL',
    pattern:
      /^(?:https?:\/\/)?(?:github\.com\/Fatih-Dumlupinar\/ai-limit-ledger|marketplace\.visualstudio\.com\/items)/i,
  },
]);

/**
 * Documentation/example values that RFCs and vendors reserve precisely so they can appear in
 * public text without ever referring to a real person, host, or network.
 */
export const RESERVED_DOCUMENTATION_MATCHERS = Object.freeze([
  /(?:^|@|\/\/)(?:example|test|invalid|localhost)(?:\.(?:com|org|net|test|invalid|local))?$/i,
  /@example\.(?:com|org|net)$/i,
  /^(?:127\.0\.0\.1|::1|0\.0\.0\.0)$/,
  /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./,
  /^123e4567-e89b-12d3-a456-426614174000$/i,
  /^550e8400-e29b-41d4-a716-446655440000$/i,
  // A "degenerate" UUID whose every hex digit is the same character (00000000-0000-…, 11111111-…)
  // cannot have come from a UUID generator; it is a hand-typed placeholder.
  /^([0-9a-f])\1{7}-\1{4}-\1{4}-\1{4}-\1{12}$/i,
]);

/**
 * Detects a credential-shaped value whose body is visibly hand-typed rather than generated.
 *
 * A real token is random; a fixture is a person typing the alphabet or repeating a character. Both
 * can clear an entropy threshold — `abcdefghijklmnopqrstuvwx` has *maximal* entropy for its length
 * because every character is distinct — so entropy alone cannot tell them apart and a structural
 * test is needed instead.
 */
export function isHandTypedPlaceholder(value) {
  const text = String(value);
  const ascendingRun = /(?:abcdefgh|bcdefghi|cdefghij|defghijk|0123456|1234567|2345678)/i;
  if (ascendingRun.test(text)) return true;
  // Six or more identical characters in a row (xxxxxx, 000000, aaaaaa).
  if (/(.)\1{5,}/.test(text)) return true;
  return false;
}

/**
 * Values that are cryptographic digests of *public* artifacts rather than anything personal.
 *
 * A lockfile's Subresource Integrity digest (`sha512-<base64>`) is long, maximally high-entropy,
 * and completely impersonal: it is a hash of a public tarball, it is required for supply-chain
 * verification, and it is meant to be committed. Without this rule the entropy heuristic reports
 * every dependency in `package-lock.json`, which is how a scanner teaches its users to ignore it.
 * Recognizing the format is strictly better than allowlisting the whole lockfile, because a real
 * credential pasted into that file would still be reported.
 */
export const NON_PERSONAL_DIGEST_MATCHERS = Object.freeze([
  {
    id: 'SUBRESOURCE_INTEGRITY_DIGEST',
    description: 'Subresource Integrity digest of a public package artifact',
    pattern: /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/,
  },
  {
    id: 'GIT_OBJECT_SHA',
    description: 'Git object / pinned action commit SHA (public, immutable identifier)',
    pattern: /^[0-9a-f]{40}$|^[0-9a-f]{64}$/,
  },
]);

/**
 * Words that mark a value as an intentional synthetic fixture. Matched against the *matched value
 * itself*, not the surrounding line, so an unrelated word elsewhere on a line cannot launder a real
 * value into looking like a fixture — the same tightening principle as
 * `release-audit.mjs`'s absolute-path triage.
 */
export const SAFE_FIXTURE_MARKERS =
  /\b(?:fixture|example|placeholder|redacted|sample|dummy|fake|test|tests|testing|demo|anyone|someone|nobody|secretuser|localhost)\b/i;

/**
 * Account names that are conventionally synthetic — the stand-in a developer writes when a fixture
 * needs *a* user name and the identity is irrelevant.
 *
 * Matched **exactly** (case-insensitively) against the account segment of a path, never as a
 * substring: `me` clears `C:\Users\me\snap.json` but does nothing for `C:\Users\<longer-name>`, and no
 * entry here could ever excuse a real account name. Keeping this an exact-match closed set is what
 * separates it from a fuzzy marker regex, which is how such lists normally decay into "matches
 * everything".
 */
export const SYNTHETIC_ACCOUNT_NAMES = Object.freeze(
  new Set([
    'me',
    'you',
    'user',
    'users',
    'someone',
    'anyone',
    'nobody',
    'person',
    'private',
    'secretuser',
    'dev',
    'developer',
    'alice',
    'bob',
    'carol',
    'foo',
    'bar',
    'runner',
    'ci',
  ]),
);

// ---------------------------------------------------------------------------
// Fingerprinting and masking
// ---------------------------------------------------------------------------

/**
 * Stable, non-reversible identifier for a matched value.
 *
 * Twelve hex characters of SHA-256 is enough to correlate "the same value appears in these five
 * places" and "this is the same value the last report saw", while being far too short and
 * unsalted-but-truncated to be worth attacking for a value that is, by construction, already
 * suspected of being sensitive. It is an identifier, never a commitment scheme.
 */
export function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Renders a matched value as a structural mask that keeps only what a human needs in order to act:
 * the *shape* of the thing and where the sensitive part sat. The variable portion is always
 * replaced by `<redacted>`, never truncated-but-shown, because a truncated token prefix is still a
 * token prefix.
 */
export function maskValue(patternId, value) {
  const raw = String(value);
  switch (patternId) {
    case 'WINDOWS_USER_PATH': {
      const drive = raw.slice(0, 1);
      return `${drive}:\\Users\\<redacted>\\...`;
    }
    case 'MACOS_HOME_PATH':
      return '/Users/<redacted>/...';
    case 'LINUX_HOME_PATH':
      return '/home/<redacted>/...';
    case 'UNC_PATH':
      return '\\\\<redacted-host>\\<redacted-share>';
    case 'PERSONAL_EMAIL':
      return '<redacted-local>@<redacted-domain>';
    case 'PRIVATE_IP':
      return '<redacted-private-ipv4>';
    case 'MAC_ADDRESS':
      return '<redacted-mac>';
    case 'MACHINE_UUID':
      return '<redacted-uuid>';
    case 'SOURCE_MAP_ABSOLUTE_PATH':
      return '"sources":["<redacted-absolute-path>"]';
    case 'VSCODE_PROFILE_PATH':
      return '<redacted-vscode-profile-path>';
    case 'PRIVATE_KEY_BLOCK':
      return '-----BEGIN <redacted> PRIVATE KEY-----';
    default:
      // For every credential shape the safest mask reveals nothing but the length class, which is
      // all a reviewer needs to tell "someone pasted a real token" from "someone wrote xxx".
      return `<redacted:${raw.length} chars>`;
  }
}

/** Shannon entropy in bits per character — used only as a heuristic, never as proof. */
export function shannonEntropy(value) {
  const text = String(value);
  if (text.length === 0) return 0;
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * Flags a long, mixed-charset, high-entropy literal that no declared pattern matched.
 *
 * This is deliberately conservative — it is the audit's "explain this value" prompt, not an
 * accusation. A hex digest, a base64 blob of compressed data, and a real token all look alike from
 * the outside, which is exactly why the result is reported at `medium` for a human to resolve
 * rather than being treated as a confirmed credential.
 */
export function isHighEntropyCandidate(value) {
  const text = String(value);
  if (text.length < 32 || text.length > 512) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return false;

  // A credential is not just "long and mixed-case" — that describes every camelCase identifier in
  // the codebase. Three further constraints separate a random secret from ordinary source text:
  //
  //  - Entropy above 4.5 bits/char. Pure hexadecimal tops out at exactly 4.0, which deliberately
  //    excludes the repository's many legitimate 40/64-character commit and asset SHAs; English-ish
  //    identifiers land around 3.5-4.2; base64 randomness sits near 5.5-6.
  //  - At least one digit, with a meaningful digit ratio. Identifiers are overwhelmingly alphabetic.
  //  - No long unbroken alphabetic run. `providerStatusBarTooltipFormatter` is one; random material
  //    is interrupted by digits every few characters.
  if (!/[0-9]/.test(text) || !/[A-Za-z]/.test(text)) return false;
  const digitRatio = (text.match(/[0-9]/g) ?? []).length / text.length;
  if (digitRatio < 0.1) return false;
  const longestAlphabeticRun = Math.max(
    ...(text.match(/[A-Za-z]+/g) ?? ['']).map((run) => run.length),
  );
  if (longestAlphabeticRun > 16) return false;
  return shannonEntropy(text) >= 4.5;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Triages one matched value into `public-identity`, `safe-fixture`, or `finding`.
 *
 * Only the value itself is considered — never the surrounding line, and never the file path. A
 * location-based exemption belongs in the allowlist, where it must be written down with a reason;
 * letting it happen implicitly here is how scanners quietly stop scanning.
 *
 * @returns {{ classification: 'public-identity'|'safe-fixture'|'finding', reason: string }}
 */
export function classifyMatch(patternId, value) {
  const raw = String(value);

  for (const matcher of PUBLIC_IDENTITY_MATCHERS) {
    if (matcher.pattern.test(raw)) {
      return { classification: 'public-identity', reason: matcher.description };
    }
  }

  for (const matcher of NON_PERSONAL_DIGEST_MATCHERS) {
    if (matcher.pattern.test(raw)) {
      return { classification: 'safe-fixture', reason: matcher.description };
    }
  }

  for (const matcher of RESERVED_DOCUMENTATION_MATCHERS) {
    if (matcher.test(raw)) {
      return {
        classification: 'safe-fixture',
        reason: 'RFC/vendor-reserved documentation value',
      };
    }
  }

  // A path's fixture marker must be in the *identity* segment (the user name), not anywhere in the
  // path — `C:\Users\<real-account>\projects\test` must not be laundered by the trailing "test".
  const identitySegment = personalPathIdentitySegment(patternId, raw);
  if (identitySegment !== null) {
    if (SYNTHETIC_ACCOUNT_NAMES.has(identitySegment.toLowerCase())) {
      return { classification: 'safe-fixture', reason: 'conventional synthetic account name' };
    }
    return SAFE_FIXTURE_MARKERS.test(identitySegment)
      ? { classification: 'safe-fixture', reason: 'synthetic fixture user name' }
      : { classification: 'finding', reason: 'path carries a real-looking account name' };
  }

  if (isHandTypedPlaceholder(raw)) {
    return {
      classification: 'safe-fixture',
      reason: 'hand-typed placeholder, not generated material',
    };
  }

  if (SAFE_FIXTURE_MARKERS.test(raw)) {
    return { classification: 'safe-fixture', reason: 'value carries a synthetic fixture marker' };
  }

  return { classification: 'finding', reason: 'no public-identity or fixture marker' };
}

/**
 * Returns the account-name segment of a personal path match, or null when the pattern is not a
 * personal path. Exported so the "which part of the path is the identity" rule is testable on its
 * own rather than only through `classifyMatch`.
 */
export function personalPathIdentitySegment(patternId, value) {
  const raw = String(value);
  if (patternId === 'WINDOWS_USER_PATH') {
    const match = raw.match(/Users\\{1,2}([^\\]{1,64})/);
    return match ? match[1] : '';
  }
  if (patternId === 'MACOS_HOME_PATH') {
    const match = raw.match(/^\/Users\/([^/]{1,64})/);
    return match ? match[1] : '';
  }
  if (patternId === 'LINUX_HOME_PATH') {
    const match = raw.match(/^\/home\/([^/]{1,64})/);
    return match ? match[1] : '';
  }
  return null;
}

/**
 * Renders one finding as a single redacted report line, in the fixed field order the release
 * documentation specifies:
 *
 *   PATTERN_ID | severity | path:line | commit | masked | fingerprint:xxxxxxxxxxxx | surface
 *
 * The finding object it receives already carries only `masked` and `fingerprint` — the raw matched
 * value is discarded at match time and is never stored on a finding, so there is no code path,
 * here or in any caller, that could accidentally render it.
 */
export function formatFindingLine(finding) {
  return [
    finding.patternId,
    finding.severity,
    `${finding.path}:${finding.line}`,
    finding.commit ?? '-',
    finding.masked,
    `fingerprint:${finding.fingerprint}`,
    finding.surface,
  ].join(' | ');
}
