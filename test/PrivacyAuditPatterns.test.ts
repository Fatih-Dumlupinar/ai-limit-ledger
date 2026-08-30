import { describe, expect, it } from 'vitest';
import {
  NON_PERSONAL_DIGEST_MATCHERS,
  PRIVACY_PATTERNS,
  PRIVACY_PATTERNS_BY_ID,
  PRIVACY_PATTERN_IDS,
  PUBLIC_IDENTITY_MATCHERS,
  SYNTHETIC_ACCOUNT_NAMES,
  classifyMatch,
  fingerprint,
  formatFindingLine,
  isHandTypedPlaceholder,
  isHighEntropyCandidate,
  maskValue,
  personalPathIdentitySegment,
  shannonEntropy,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/lib/privacy-patterns.mjs';
import {
  account,
  machineUuid,
  macAddress,
  connectionString,
  credentialBearingUrl,
  highEntropyLiteral,
  personalEmail,
  posixHomePath,
  privateIpAddress,
  sourceMapWithAbsolutePath,
  sourceMapWithRelativePath,
  uncPath,
  vscodeProfilePath,
  windowsUserPath,
  windowsUserPathOn,
} from './privacyAuditFixtures';

type PatternDefinition = { id: string; kind: string; severity: string; pattern: RegExp };

/**
 * Every "sensitive-looking" literal in this file is assembled from fragments at runtime rather than
 * written out whole. That keeps a token-shaped string out of the committed bytes entirely, so the
 * repository's own Gitleaks history scan and release audit have nothing to trip over — the same
 * convention test/ReleaseAudit.test.ts already uses for its fixture values.
 */
const githubTokenPrefix = ['gh', 'p_'].join('');
const npmTokenPrefix = ['npm', '_'].join('');
const openAiPrefix = ['sk', '-'].join('');
const pemBanner = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
const jwtHeader = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'QWxhZGRpbjpvcGVu'].join(
  '.',
);

/** Matches `value` against exactly one pattern id, returning the matched text. */
function matchWith(patternId: string, value: string): string | null {
  const definition = (PRIVACY_PATTERNS as PatternDefinition[]).find((p) => p.id === patternId);
  if (!definition) throw new Error(`unknown pattern id ${patternId}`);
  const expression = new RegExp(definition.pattern.source, definition.pattern.flags);
  const match = expression.exec(value);
  return match ? match[0] : null;
}

const detects = (patternId: string, value: string) => matchWith(patternId, value) !== null;

const classificationOf = (patternId: string, value: string) =>
  (classifyMatch(patternId, value) as { classification: string }).classification;

describe('privacy-audit: personal-data pattern detection', () => {
  it('detects a Windows user-profile path', () => {
    expect(detects('WINDOWS_USER_PATH', windowsUserPath('projects', 'thing'))).toBe(true);
  });

  it('detects a Windows user path written with escaped backslashes, as it appears in JSON', () => {
    expect(
      detects('WINDOWS_USER_PATH', `"cwd": ${JSON.stringify(windowsUserPathOn('D', 'build'))}`),
    ).toBe(true);
  });

  it('detects a Linux home directory path', () => {
    expect(detects('LINUX_HOME_PATH', `HOME=${posixHomePath('home')}/src`)).toBe(true);
  });

  it('detects a macOS home directory path', () => {
    expect(detects('MACOS_HOME_PATH', `${posixHomePath('Users')}/Library/Logs`)).toBe(true);
  });

  it('detects a UNC share path without matching an ordinary escaped Windows path', () => {
    expect(detects('UNC_PATH', `copy ${uncPath('artifacts', 'out.zip')}`)).toBe(true);
  });

  it('detects an email address', () => {
    expect(detects('PERSONAL_EMAIL', 'contact: someone@somewhere.org')).toBe(true);
  });

  it('detects private and loopback IPv4 addresses but not an arbitrary dotted number', () => {
    expect(detects('PRIVATE_IP', `listening on ${privateIpAddress}`)).toBe(true);
    expect(detects('PRIVATE_IP', 'loopback 127.0.0.1')).toBe(true);
    expect(detects('PRIVATE_IP', 'version 8.4.201.7')).toBe(false);
  });

  it('detects a MAC hardware address in both separator styles', () => {
    expect(detects('MAC_ADDRESS', `adapter ${macAddress}`)).toBe(true);
    expect(detects('MAC_ADDRESS', `adapter ${macAddress.toUpperCase().replaceAll(':', '-')}`)).toBe(
      true,
    );
  });

  it('detects a UUID', () => {
    expect(detects('MACHINE_UUID', `machineId ${machineUuid}`)).toBe(true);
  });

  it('detects a source map whose sources point at an absolute build path', () => {
    expect(detects('SOURCE_MAP_ABSOLUTE_PATH', sourceMapWithAbsolutePath)).toBe(true);
    expect(detects('SOURCE_MAP_ABSOLUTE_PATH', sourceMapWithRelativePath)).toBe(false);
  });

  it('detects a VS Code user-profile directory path', () => {
    expect(detects('VSCODE_PROFILE_PATH', vscodeProfilePath)).toBe(true);
  });

  it('detects the project public identity so it can be reported, not silently ignored', () => {
    expect(detects('PROJECT_PUBLIC_IDENTITY', 'github.com/Fatih-Dumlupinar/ai-limit-ledger')).toBe(
      true,
    );
    expect(detects('PROJECT_PUBLIC_IDENTITY', 'publisher: fatihdumlupinar-dev')).toBe(true);
  });
});

describe('privacy-audit: credential pattern detection', () => {
  it('detects a GitHub personal access token', () => {
    expect(detects('GITHUB_TOKEN', `token=${githubTokenPrefix}${'A1b2C3d4'.repeat(4)}`)).toBe(true);
  });

  it('detects a GitHub fine-grained token', () => {
    expect(detects('GITHUB_FINE_GRAINED_TOKEN', `${'github_pat_'}${'X9y8Z7w6'.repeat(4)}`)).toBe(
      true,
    );
  });

  it('detects an Azure DevOps / Marketplace PAT assignment', () => {
    expect(detects('AZURE_MARKETPLACE_PAT', `VSCE_PAT=${'Q7r8S9t0'.repeat(4)}`)).toBe(true);
  });

  it('detects an npm access token', () => {
    expect(detects('NPM_TOKEN', `${npmTokenPrefix}${'M3n4P5q6'.repeat(5)}`)).toBe(true);
  });

  it('detects an OpenAI/Anthropic-style provider key', () => {
    expect(detects('OPENAI_STYLE_KEY', `${openAiPrefix}${'T7u8V9w0'.repeat(4)}`)).toBe(true);
  });

  it('detects an AWS access key id', () => {
    expect(detects('AWS_ACCESS_KEY_ID', `${'AK'}${'IA'}QRSTUVWX23456789`)).toBe(true);
  });

  it('detects a PEM private key banner', () => {
    expect(detects('PRIVATE_KEY_BLOCK', pemBanner)).toBe(true);
  });

  it('detects a JSON Web Token', () => {
    expect(detects('JWT', `token: ${jwtHeader}`)).toBe(true);
  });

  it('detects a literal Authorization header', () => {
    expect(detects('AUTHORIZATION_HEADER', `Authorization: Bearer ${'Z8y7X6w5'.repeat(4)}`)).toBe(
      true,
    );
  });

  it('detects a database connection string', () => {
    expect(detects('CONNECTION_STRING', connectionString)).toBe(true);
  });

  it('detects credentials embedded in a URL', () => {
    expect(detects('PASSWORD_IN_URL', credentialBearingUrl)).toBe(true);
  });

  it('detects a cookie/session assignment', () => {
    expect(detects('COOKIE_OR_SESSION', `refresh_token = "${'K2l3M4n5'.repeat(3)}"`)).toBe(true);
  });

  it('does not flag ordinary source code', () => {
    for (const line of [
      "const label = 'used/allowance/remaining'",
      'https://api.github.com/user',
      "expect(status).toBe('rate-limited')",
      'import { readFileSync } from "node:fs";',
    ]) {
      const hits = (PRIVACY_PATTERNS as PatternDefinition[]).filter((definition) => {
        const expression = new RegExp(definition.pattern.source, definition.pattern.flags);
        return expression.test(line);
      });
      expect(
        hits.map((h) => h.id),
        line,
      ).toEqual([]);
    }
  });
});

describe('privacy-audit: classification of public identity vs leaked data', () => {
  it("classifies GitHub's noreply commit address as intentional public identity", () => {
    expect(classificationOf('PERSONAL_EMAIL', '12345678+someone@users.noreply.github.com')).toBe(
      'public-identity',
    );
    expect(classificationOf('PERSONAL_EMAIL', 'noreply@github.com')).toBe('public-identity');
  });

  it('classifies the owner handle and Marketplace publisher id as public identity', () => {
    expect(classificationOf('PROJECT_PUBLIC_IDENTITY', 'Fatih-Dumlupinar')).toBe('public-identity');
    expect(classificationOf('PROJECT_PUBLIC_IDENTITY', 'fatihdumlupinar-dev.ai-limit-ledger')).toBe(
      'public-identity',
    );
  });

  it('classifies a genuine personal mailbox as a finding, not as public identity', () => {
    expect(classificationOf('PERSONAL_EMAIL', personalEmail)).toBe('finding');
  });

  it('classifies a documentation-reserved address and address block as a safe fixture', () => {
    expect(classificationOf('PERSONAL_EMAIL', 'user@example.com')).toBe('safe-fixture');
    expect(classificationOf('PRIVATE_IP', '127.0.0.1')).toBe('safe-fixture');
  });

  it('distinguishes a placeholder UUID from one that could identify a machine', () => {
    expect(classificationOf('MACHINE_UUID', '123e4567-e89b-12d3-a456-426614174000')).toBe(
      'safe-fixture',
    );
    expect(classificationOf('MACHINE_UUID', '11111111-1111-1111-1111-111111111111')).toBe(
      'safe-fixture',
    );
    expect(classificationOf('MACHINE_UUID', machineUuid)).toBe('finding');
  });

  it('treats a fixture account name as safe and a real-looking one as a finding', () => {
    expect(classificationOf('WINDOWS_USER_PATH', 'C:\\Users\\fixture\\workspace')).toBe(
      'safe-fixture',
    );
    expect(classificationOf('WINDOWS_USER_PATH', 'C:\\Users\\me\\snap.json')).toBe('safe-fixture');
    expect(classificationOf('LINUX_HOME_PATH', '/home/test')).toBe('safe-fixture');
    expect(classificationOf('WINDOWS_USER_PATH', windowsUserPath('workspace'))).toBe('finding');
  });

  it('only excuses a fixture marker in the account segment, never elsewhere in the path', () => {
    // The trailing "test" directory must not launder a real account name.
    expect(classificationOf('WINDOWS_USER_PATH', windowsUserPath('test'))).toBe('finding');
    expect(personalPathIdentitySegment('WINDOWS_USER_PATH', windowsUserPath('test'))).toBe(account);
  });

  it('matches synthetic account names exactly, never as a substring', () => {
    expect(SYNTHETIC_ACCOUNT_NAMES.has('me')).toBe(true);
    expect(
      classificationOf('WINDOWS_USER_PATH', windowsUserPath('src').replace(account, 'mehmet')),
    ).toBe('finding');
  });

  it('classifies lockfile integrity digests and commit SHAs as impersonal public data', () => {
    expect(classificationOf('GENERIC_SECRET_ASSIGNMENT', `sha512-${'AbC9dEf7'.repeat(8)}==`)).toBe(
      'safe-fixture',
    );
    expect(classificationOf('HIGH_ENTROPY_VALUE', '3d3c42e5aac5ba805825da76410c181273ba90b1')).toBe(
      'safe-fixture',
    );
    expect((NON_PERSONAL_DIGEST_MATCHERS as unknown[]).length).toBeGreaterThan(0);
  });

  it('recognizes a hand-typed placeholder credential as a fixture', () => {
    expect(isHandTypedPlaceholder(`${openAiPrefix}abcdefghijklmnopqrstuvwx`)).toBe(true);
    expect(isHandTypedPlaceholder('xxxxxxxxxxxx')).toBe(true);
    expect(isHandTypedPlaceholder('Q7r8S9t0M3n4P5q6')).toBe(false);
  });

  it('falls back to "finding" for an unknown pattern id with no recognizable marker', () => {
    expect(classificationOf('SOME_PATTERN_THAT_DOES_NOT_EXIST', 'Q7r8S9t0M3n4P5q6')).toBe(
      'finding',
    );
  });
});

describe('privacy-audit: high-entropy heuristic', () => {
  it('computes Shannon entropy over the value', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1, 5);
  });

  it('flags a long random mixed-charset literal', () => {
    expect(isHighEntropyCandidate(highEntropyLiteral)).toBe(true);
  });

  it('does not flag an ordinary long camelCase identifier', () => {
    expect(isHighEntropyCandidate('providerStatusBarTooltipFormatterRegistry')).toBe(false);
  });

  it('does not flag a hexadecimal digest, whose entropy cannot exceed four bits per character', () => {
    expect(isHighEntropyCandidate('3d3c42e5aac5ba805825da76410c181273ba90b1')).toBe(false);
  });

  it('does not flag a value that is too short to be a credential', () => {
    expect(isHighEntropyCandidate('a9F2kQ7zX1mB')).toBe(false);
  });
});

describe('privacy-audit: redaction', () => {
  it('never returns the original value from any mask', () => {
    const samples: Array<[string, string]> = [
      ['WINDOWS_USER_PATH', windowsUserPath('secret')],
      ['MACOS_HOME_PATH', `${posixHomePath('Users')}/secret`],
      ['LINUX_HOME_PATH', `${posixHomePath('home')}/secret`],
      ['UNC_PATH', uncPath('artifacts')],
      ['PERSONAL_EMAIL', personalEmail],
      ['MAC_ADDRESS', macAddress],
      ['MACHINE_UUID', machineUuid],
      ['GITHUB_TOKEN', `${githubTokenPrefix}${'A1b2C3d4'.repeat(4)}`],
      ['JWT', jwtHeader],
    ];
    for (const [patternId, value] of samples) {
      const masked = maskValue(patternId, value) as string;
      expect(masked, patternId).not.toContain(value);
      expect(masked, patternId).toContain('redacted');
    }
  });

  it('keeps only the structural shape of a personal path, never the account name', () => {
    expect(maskValue('WINDOWS_USER_PATH', windowsUserPathOn('D', 'secret'))).toBe(
      'D:\\Users\\<redacted>\\...',
    );
    expect(maskValue('WINDOWS_USER_PATH', windowsUserPathOn('D', 'secret'))).not.toContain(account);
  });

  it('reduces an unrecognized credential shape to a length class only', () => {
    const value = `${githubTokenPrefix}${'A1b2C3d4'.repeat(4)}`;
    expect(maskValue('GITHUB_TOKEN', value)).toBe(`<redacted:${value.length} chars>`);
  });

  it('produces a stable, truncated, non-reversible fingerprint', () => {
    const value = windowsUserPath('secret');
    expect(fingerprint(value)).toBe(fingerprint(value));
    expect(fingerprint(value)).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint(value)).not.toContain(account);
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });

  it('renders a finding line with no field able to carry a raw value', () => {
    const line = formatFindingLine({
      patternId: 'WINDOWS_USER_PATH',
      severity: 'medium',
      path: 'test/example.test.ts',
      line: 42,
      commit: 'fa18c24',
      masked: 'C:\\Users\\<redacted>\\...',
      fingerprint: '12ab34cd56ef',
      surface: 'source-tree',
    }) as string;
    expect(line).toBe(
      'WINDOWS_USER_PATH | medium | test/example.test.ts:42 | fa18c24 | C:\\Users\\<redacted>\\... | fingerprint:12ab34cd56ef | source-tree',
    );
  });
});

describe('privacy-audit: pattern table integrity', () => {
  it('gives every pattern a unique id, a kind, and a severity', () => {
    const ids = (PRIVACY_PATTERN_IDS as string[]).slice();
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of PRIVACY_PATTERNS as PatternDefinition[]) {
      expect(['personal-data', 'secret'], definition.id).toContain(definition.kind);
      expect(['info', 'low', 'medium', 'high', 'critical'], definition.id).toContain(
        definition.severity,
      );
      expect(PRIVACY_PATTERNS_BY_ID[definition.id]).toBe(definition);
    }
  });

  it('keeps every public-identity matcher anchored so it cannot excuse a longer value', () => {
    for (const matcher of PUBLIC_IDENTITY_MATCHERS as Array<{ id: string; pattern: RegExp }>) {
      expect(matcher.pattern.source, matcher.id).toMatch(/^\^/);
    }
  });
});
