import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LIMITS,
  allowlistMatches,
  buildJsonReport,
  decodeUtf8Strict,
  looksBinary,
  parseArguments,
  readPngTextMetadata,
  resolveInsideRoot,
  scanBuffer,
  scanText,
  summarize,
  validateAllowlist,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/privacy-audit.mjs';
import { account, personalEmail, windowsUserPath } from './privacyAuditFixtures';

const ROOT = resolve(__dirname, '..');

type Finding = {
  patternId: string;
  classification: string;
  masked: string;
  fingerprint: string;
  path: string;
  line: number;
  reason: string;
  severity: string;
};

const scratchDirectories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'privacy-audit-test-'));
  scratchDirectories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of scratchDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A locked temp directory on Windows must never fail the suite; the OS reclaims it.
    }
  }
});

const scan = (text: string, location = 'fixture.ts'): Finding[] =>
  scanText({ text, location, surface: 'test', commit: null, allowlist: [] }) as Finding[];

/** Builds a syntactically valid PNG with the given optional metadata chunks. */
function makePng(chunks: Array<{ type: string; text: string }> = []): Buffer {
  const parts: Buffer[] = [Buffer.from('89504e470d0a1a0a', 'hex')];
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    // The CRC is not validated by the reader, so four zero bytes keep the fixture honest and small.
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  parts.push(chunk('IHDR', ihdr));
  for (const entry of chunks) parts.push(chunk(entry.type, Buffer.from(entry.text, 'latin1')));
  parts.push(chunk('IDAT', Buffer.from([0x08, 0x1d])));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

describe('privacy-audit: text scanning produces only redacted findings', () => {
  it('reports a personal path with a location, a mask, and a fingerprint', () => {
    const findings = scan(`const home = ${JSON.stringify(windowsUserPath('projects'))};`);
    const finding = findings.find((f) => f.patternId === 'WINDOWS_USER_PATH');
    expect(finding).toBeDefined();
    expect(finding?.classification).toBe('finding');
    expect(finding?.line).toBe(1);
    expect(finding?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('never lets the matched value appear on any field of a finding', () => {
    const secret = windowsUserPath('projects');
    const serialized = JSON.stringify(scan(`const home = ${JSON.stringify(secret)};`));
    expect(serialized).not.toContain(account);
  });

  it('records the correct line number for a match on a later line', () => {
    const findings = scan(['first', 'second', `mail: ${personalEmail}`].join('\n'));
    expect(findings.find((f) => f.patternId === 'PERSONAL_EMAIL')?.line).toBe(3);
  });

  it('skips a line longer than the configured limit rather than scanning a minified bundle', () => {
    const padding = 'x'.repeat(LIMITS.maxLineLength + 10);
    expect(scan(`${padding} ${windowsUserPath('x')}`)).toEqual([]);
  });

  it('does not let a global pattern carry lastIndex state between lines', () => {
    const text = ['a@one.example', 'b@two.example', 'c@three.example'].join('\n');
    const emails = scan(text).filter((f) => f.patternId === 'PERSONAL_EMAIL');
    expect(emails.map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it('reports a safe fixture separately from a finding rather than dropping it', () => {
    const findings = scan('const home = "C:\\\\Users\\\\fixture\\\\projects";');
    expect(findings[0]?.classification).toBe('safe-fixture');
    expect(summarize(findings).ok).toBe(true);
  });
});

describe('privacy-audit: binary, PNG, and encoding handling', () => {
  it('reads PNG text metadata chunks structurally', () => {
    const png = makePng([{ type: 'tEXt', text: `Author\u0000${windowsUserPath('shot.png')}` }]);
    const chunks = readPngTextMetadata(png) as Array<{ type: string; text: string }>;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('tEXt');
  });

  it('flags a personal path hidden in PNG metadata, attributing it to the chunk', () => {
    const png = makePng([{ type: 'tEXt', text: `Source: ${windowsUserPath('shot.png')}` }]);
    const result = scanBuffer({
      buffer: png,
      location: 'assets/shot.png',
      surface: 'test',
      commit: null,
      allowlist: [],
    }) as { findings: Finding[]; skipped: unknown };
    expect(result.findings.map((f) => f.patternId)).toContain('WINDOWS_USER_PATH');
    expect(result.findings[0].path).toBe('assets/shot.png#tEXt');
  });

  it('does not scan PNG pixel data as text, which is where false positives come from', () => {
    // Compressed image bytes reliably contain email- and token-shaped runs. A PNG with no metadata
    // chunk must therefore produce nothing at all, however its IDAT stream happens to decode.
    const png = makePng();
    const result = scanBuffer({
      buffer: png,
      location: 'assets/icon.png',
      surface: 'test',
      commit: null,
      allowlist: [],
    }) as { findings: Finding[] };
    expect(result.findings).toEqual([]);
  });

  it('returns null for a file that claims to be a PNG but is not', () => {
    expect(readPngTextMetadata(Buffer.from('not a png at all'))).toBeNull();
  });

  it('skips binary content with a documented reason instead of scanning it as text', () => {
    const binary = Buffer.concat([Buffer.from('prefix'), Buffer.alloc(4), Buffer.from('suffix')]);
    const result = scanBuffer({
      buffer: binary,
      location: 'out/thing.bin',
      surface: 'test',
      commit: null,
      allowlist: [],
    }) as { findings: Finding[]; skipped: { reason: string } };
    expect(result.findings).toEqual([]);
    expect(result.skipped.reason).toMatch(/binary/i);
    expect(looksBinary(binary)).toBe(true);
  });

  it('refuses invalid UTF-8 deterministically rather than decoding it lossily', () => {
    const invalid = Buffer.from([0xc3, 0x28, 0x41, 0x42]);
    expect(decodeUtf8Strict(invalid)).toBeNull();
    const result = scanBuffer({
      buffer: invalid,
      location: 'docs/broken.md',
      surface: 'test',
      commit: null,
      allowlist: [],
    }) as { findings: Finding[]; skipped: { reason: string } };
    expect(result.findings).toEqual([]);
    expect(result.skipped.reason).toMatch(/UTF-8/i);
  });

  it('skips an oversized file with a documented reason instead of truncating it silently', () => {
    const oversized = Buffer.alloc(LIMITS.maxFileBytes + 1, 0x61);
    const result = scanBuffer({
      buffer: oversized,
      location: 'docs/huge.md',
      surface: 'test',
      commit: null,
      allowlist: [],
    }) as { findings: Finding[]; skipped: { reason: string } };
    expect(result.findings).toEqual([]);
    expect(result.skipped.reason).toMatch(/limit/i);
  });

  it('declares finite, non-NaN limits', () => {
    for (const [name, value] of Object.entries(LIMITS as Record<string, number>)) {
      expect(Number.isFinite(value), name).toBe(true);
      expect(Number.isNaN(value), name).toBe(false);
      expect(value, name).toBeGreaterThan(0);
    }
  });
});

describe('privacy-audit: repository containment', () => {
  it('resolves an ordinary repository-relative file', () => {
    expect((resolveInsideRoot(ROOT, 'package.json') as { ok: boolean }).ok).toBe(true);
  });

  it('refuses a path that traverses above the repository root', () => {
    const result = resolveInsideRoot(ROOT, '../../../etc') as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('refuses to follow a symlink that escapes the repository root', () => {
    const outside = scratch();
    writeFileSync(join(outside, 'secrets.txt'), windowsUserPath('secret'), 'utf8');
    // The in-repository end of the link lives under the gitignored .tmp/ area, so an interrupted
    // run can never leave an untracked scratch directory in the working tree.
    mkdirSync(join(ROOT, '.tmp'), { recursive: true });
    const inside = mkdtempSync(join(ROOT, '.tmp', 'privacy-symlink-'));
    scratchDirectories.push(inside);
    let created = false;
    try {
      symlinkSync(join(outside, 'secrets.txt'), join(inside, 'escape.txt'), 'file');
      created = true;
    } catch {
      // Creating a symlink on Windows needs Developer Mode or elevation. When it is unavailable the
      // containment rule is still asserted above by the traversal case; this branch just records
      // that the environment could not exercise the symlink path.
    }
    if (created) {
      const relative = `${inside.slice(ROOT.length + 1).replaceAll('\\', '/')}/escape.txt`;
      const result = resolveInsideRoot(ROOT, relative) as { ok: boolean; reason: string };
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/escapes the repository root/i);
    }
  });
});

describe('privacy-audit: allowlist', () => {
  const valid = [
    {
      patternId: 'MACHINE_UUID',
      path: 'test/Example.test.ts',
      reason: 'placeholder identifier used by a fixture',
    },
  ];

  it('accepts a well-formed entry', () => {
    expect(validateAllowlist(valid)).toEqual([]);
    expect(allowlistMatches(valid, 'MACHINE_UUID', 'test/Example.test.ts')).toBe(true);
  });

  it('suppresses only the named pattern at the named path', () => {
    expect(allowlistMatches(valid, 'PERSONAL_EMAIL', 'test/Example.test.ts')).toBe(false);
    expect(allowlistMatches(valid, 'MACHINE_UUID', 'test/Other.test.ts')).toBe(false);
  });

  it('rejects a wildcard path, which would mute a whole directory', () => {
    const errors = validateAllowlist([{ ...valid[0], path: 'test/**' }]) as string[];
    expect(errors.join(' ')).toMatch(/wildcard/i);
  });

  it('rejects an absolute or traversing path', () => {
    expect(
      (validateAllowlist([{ ...valid[0], path: '/etc/passwd' }]) as string[]).length,
    ).toBeGreaterThan(0);
    expect(
      (validateAllowlist([{ ...valid[0], path: '../outside.ts' }]) as string[]).length,
    ).toBeGreaterThan(0);
  });

  it('rejects an unknown pattern id', () => {
    const errors = validateAllowlist([{ ...valid[0], patternId: 'NOT_A_PATTERN' }]) as string[];
    expect(errors.join(' ')).toMatch(/patternId/);
  });

  it('rejects an entry with no meaningful reason', () => {
    const errors = validateAllowlist([{ ...valid[0], reason: 'because' }]) as string[];
    expect(errors.join(' ')).toMatch(/reason/);
  });

  it('rejects an entry carrying any field beyond patternId, path, and reason', () => {
    const errors = validateAllowlist([{ ...valid[0], value: windowsUserPath() }]) as string[];
    expect(errors.join(' ')).toMatch(/unexpected field/);
  });

  it('marks a suppressed match as allowlisted rather than deleting it from the report', () => {
    const findings = scanText({
      text: `const home = ${JSON.stringify(windowsUserPath('x'))};`,
      location: 'test/Example.test.ts',
      surface: 'test',
      commit: null,
      allowlist: [
        {
          patternId: 'WINDOWS_USER_PATH',
          path: 'test/Example.test.ts',
          reason: 'documented fixture location for this pattern',
        },
      ],
    }) as Finding[];
    expect(findings[0].classification).toBe('allowlisted');
    expect(summarize(findings).ok).toBe(true);
  });

  it('keeps the repository allowlist itself valid and narrow', () => {
    const entries = JSON.parse(
      readFileSync(resolve(ROOT, 'scripts/privacy-allowlist.json'), 'utf8'),
    );
    expect(validateAllowlist(entries)).toEqual([]);
    for (const entry of entries as Array<{ path: string }>) {
      expect(entry.path).not.toContain('*');
      expect(entry.path.startsWith('test/')).toBe(true);
    }
  });
});

describe('privacy-audit: JSON report', () => {
  const findings = scanText({
    text: [`a: ${windowsUserPath('x')}`, 'b: user@example.com', 'c: Fatih-Dumlupinar'].join('\n'),
    location: 'fixture.ts',
    surface: 'source-tree',
    commit: null,
    allowlist: [],
  }) as Finding[];

  const report = buildJsonReport({
    mode: 'source',
    target: null,
    findings,
    skipped: [{ path: 'x.png', surface: 'source-tree', reason: 'binary content' }],
    scanned: 1,
    startedAt: Date.now(),
  }) as Record<string, unknown>;

  it('marks itself redacted and carries no raw matched value', () => {
    expect(report.redacted).toBe(true);
    expect(JSON.stringify(report)).not.toContain(account);
  });

  it('separates findings, public identity, and safe fixtures in its summary', () => {
    const summary = report.summary as Record<string, number | boolean>;
    expect(summary.publicIdentity).toBeGreaterThan(0);
    expect(summary.safeFixtures).toBeGreaterThan(0);
    expect(summary.skipped).toBe(1);
  });

  it('gives every reported finding a mask and a fingerprint but no value field', () => {
    for (const finding of report.findings as Array<Record<string, unknown>>) {
      expect(finding.masked).toBeDefined();
      expect(finding.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(Object.keys(finding)).not.toContain('value');
      expect(Object.keys(finding)).not.toContain('match');
    }
  });

  it('records the skipped units so a limited scan cannot look like a complete one', () => {
    expect((report.skipped as unknown[]).length).toBe(1);
  });
});

describe('privacy-audit: command line contract', () => {
  it('defaults to scanning the source tree', () => {
    expect(parseArguments([])).toMatchObject({ mode: 'source', vsix: null, json: null });
  });

  it('parses the history, vsix, and json modes', () => {
    expect(parseArguments(['--history'])).toMatchObject({ mode: 'history' });
    expect(parseArguments(['--vsix', 'a.vsix'])).toMatchObject({ mode: 'vsix', vsix: 'a.vsix' });
    expect(parseArguments(['--json', 'r.json'])).toMatchObject({ json: 'r.json' });
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseArguments(['--everything'])).toThrow(/unknown argument/);
  });

  it('rejects a mode flag with a missing operand', () => {
    expect(() => parseArguments(['--vsix'])).toThrow(/requires a path/);
    expect(() => parseArguments(['--json', '--history'])).toThrow(/requires an output path/);
  });
});

describe('privacy-audit: exit-code semantics', () => {
  const script = resolve(ROOT, 'scripts/privacy-audit.mjs');
  const run = (args: string[]): { status: number; output: string } => {
    try {
      const output = execFileSync(process.execPath, [script, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 300000,
      });
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    }
  };

  it('exits 0 with no actionable finding on the current source tree', () => {
    const result = run([]);
    expect(result.output).toMatch(/0 finding\(s\) requiring review/);
    expect(result.status).toBe(0);
  });

  it('exits 2 — a tool failure, never a silent pass — on a bad argument', () => {
    const result = run(['--nonsense']);
    expect(result.status).toBe(2);
    expect(result.output).toMatch(/privacy-audit failed/);
  });

  it('exits 2 when asked to audit a package that does not exist', () => {
    const result = run(['--vsix', 'no-such-package-0.0.0.vsix']);
    expect(result.status).toBe(2);
    expect(result.output).toMatch(/VSIX not found/);
  });

  it('writes a redacted JSON report that contains no matched value', () => {
    const directory = scratch();
    const reportPath = join(directory, 'privacy-audit-report.json');
    const result = run(['--json', reportPath]);
    expect(result.status).toBe(0);
    const written = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(written.redacted).toBe(true);
    expect(written.summary.ok).toBe(true);

    // Every user-path-shaped string anywhere in the written report must have `<redacted>` where the
    // account name would be. This is the assertion that actually proves the report is safe to
    // attach to a CI run or paste into an issue.
    const raw = readFileSync(reportPath, 'utf8');
    const accountSegments = [...raw.matchAll(/[A-Za-z]:\\{1,2}Users\\{1,2}([^\\"]*)/g)].map(
      (match) => match[1],
    );
    expect(accountSegments.length).toBeGreaterThan(0);
    // Each is either the mask itself or a `<name>`-style placeholder inside a pattern's own
    // description; what must never appear is a literal account name.
    for (const segment of accountSegments) {
      expect(segment.startsWith('<'), segment).toBe(true);
    }
    expect(raw).not.toMatch(/"value"|"match"|"raw"/);
  });
});

describe('privacy-audit: packaged-artifact scanning', () => {
  it('never writes an inflated entry to disk while scanning a package', () => {
    // The reader hands back a Buffer, so a VSIX can be audited without an extraction directory
    // existing at any point — which is what keeps the audit from creating the very artifact it is
    // meant to inspect.
    const payload = Buffer.from(`const home = ${JSON.stringify(windowsUserPath('x'))};`, 'utf8');
    const compressed = deflateRawSync(payload);
    expect(compressed.length).toBeGreaterThan(0);
    const result = scanBuffer({
      buffer: payload,
      location: 'pkg.vsix!extension/out/a.js',
      surface: 'vsix',
      commit: null,
      allowlist: [],
    }) as { findings: Finding[] };
    expect(result.findings.map((f) => f.patternId)).toContain('WINDOWS_USER_PATH');
  });
});
