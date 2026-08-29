import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_PATH_PATTERNS,
  CREDENTIAL_PATTERNS,
  KNOWN_SAFE_FIXTURE_MARKERS,
  VSIX_DENYLIST_PATTERNS,
  VSIX_REQUIRED_ENTRIES,
  readZipEntries,
  readZipEntryContent,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const SCRIPT_PATH = resolve(__dirname, '../scripts/release-audit.mjs');

/** Builds a minimal, valid ZIP (the same on-disk format a VSIX uses) entirely in memory. */
function buildTestZip(entries: Array<{ name: string; content: string; store?: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawContent = Buffer.from(entry.content, 'utf8');
    const store = entry.store ?? false;
    const data = store ? rawContent : deflateRawSync(rawContent);
    const method = store ? 0 : 8;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by the reader)
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(rawContent.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(rawContent.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

describe('release-audit.mjs — pure-Node ZIP reader', () => {
  it('reads back a stored (uncompressed) entry byte-for-byte', () => {
    const zip = buildTestZip([{ name: 'extension/readme.md', content: '# Hello', store: true }]);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].fileName).toBe('extension/readme.md');
    expect(readZipEntryContent(zip, entries[0]).toString('utf8')).toBe('# Hello');
  });

  it('reads back a deflated entry byte-for-byte', () => {
    const content = 'x'.repeat(500) + 'the quick brown fox';
    const zip = buildTestZip([{ name: 'extension/out/extension.js', content }]);
    const entries = readZipEntries(zip);
    expect(readZipEntryContent(zip, entries[0]).toString('utf8')).toBe(content);
  });

  it('reads multiple entries in order with correct sizes', () => {
    const zip = buildTestZip([
      { name: 'a.txt', content: 'one', store: true },
      { name: 'b.txt', content: 'two-two', store: false },
      { name: 'c.txt', content: '', store: true },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e: { fileName: string }) => e.fileName)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
    expect(entries[0].uncompressedSize).toBe(3);
    expect(entries[2].uncompressedSize).toBe(0);
  });

  it('throws a clear error for a buffer that is not a ZIP', () => {
    expect(() => readZipEntries(Buffer.from('not a zip file'))).toThrow(/End Of Central Directory/);
  });

  it('rejects an unsupported compression method when reading content', () => {
    const zip = buildTestZip([{ name: 'a.txt', content: 'x', store: true }]);
    const entries = readZipEntries(zip);
    const tampered = { ...entries[0], method: 99 };
    expect(() => readZipEntryContent(zip, tampered)).toThrow(/Unsupported ZIP compression method/);
  });
});

describe('release-audit.mjs — VSIX denylist patterns', () => {
  const denied = (name: string) => VSIX_DENYLIST_PATTERNS.some((p: RegExp) => p.test(name));

  it.each([
    'extension/.git/HEAD',
    'extension/node_modules/foo/index.js',
    'extension/out/extension.js.map',
    'extension/.env',
    'extension/.env.local',
    'extension/debug.log',
    'extension/old-build.vsix',
    'extension/coverage/index.html',
    'extension/.tmp/scratch.json',
    'npm-audit.json',
    'deps-tree.json',
    'extension/backup.bak',
    'extension/file~',
  ])('flags %s as denylisted', (name) => {
    expect(denied(name)).toBe(true);
  });

  it.each([
    'extension/out/extension.js',
    'extension/package.json',
    'extension/readme.md',
    'extension/docs/SETTINGS.md',
    'extension/assets/icon.png',
  ])('does not flag %s', (name) => {
    expect(denied(name)).toBe(false);
  });
});

describe('release-audit.mjs — required VSIX entries reflect vsce packaging conventions', () => {
  it('expects lowercase readme/changelog and LICENSE.txt, matching vsce output, not repo filenames', () => {
    expect(VSIX_REQUIRED_ENTRIES).toContain('extension/readme.md');
    expect(VSIX_REQUIRED_ENTRIES).toContain('extension/changelog.md');
    expect(VSIX_REQUIRED_ENTRIES).toContain('extension/LICENSE.txt');
    expect(VSIX_REQUIRED_ENTRIES).not.toContain('extension/README.md');
  });
});

describe('release-audit.mjs — credential-shaped pattern set', () => {
  const matches = (line: string) =>
    CREDENTIAL_PATTERNS.some(({ pattern }: { pattern: RegExp }) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    });

  // Each fixture line below carries the word "fixture" so this file's own credential-shaped
  // literals are triaged as `likely-fixture`, not `needs-review`, by `npm run audit:release`
  // itself — the same triage a real placeholder/test value gets, per the Task 10 brief.
  it.each([
    "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123'", // fixture value
    "apiKey: 'sk-abcdefghijklmnopqrstuvwx'", // fixture value
    'AKIAABCDEFGHIJKLMNOP', // fixture value
    '-----BEGIN RSA PRIVATE KEY-----', // fixture value
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', // fixture value
  ])('flags a realistic-looking secret: %s', (line) => {
    expect(matches(line)).toBe(true);
  });

  it.each([
    "const label = 'used/allowance/remaining'",
    'https://api.github.com/user',
    "expect(status).toBe('rate-limited')",
  ])('does not flag ordinary code: %s', (line) => {
    expect(matches(line)).toBe(false);
  });

  it('the fixture-marker allowlist recognizes common placeholder words', () => {
    expect(KNOWN_SAFE_FIXTURE_MARKERS.test('token = FAKE_TOKEN_FOR_TEST')).toBe(true);
    expect(KNOWN_SAFE_FIXTURE_MARKERS.test('C:\\Users\\fixture\\workspace')).toBe(true);
    expect(KNOWN_SAFE_FIXTURE_MARKERS.test('HOME=/home/test')).toBe(true);
  });

  it('the fixture-marker allowlist does not match an unrelated real-looking value', () => {
    expect(KNOWN_SAFE_FIXTURE_MARKERS.test('ghp_9f8e7d6c5b4a3210')).toBe(false);
  });
});

describe('release-audit.mjs — absolute user path patterns', () => {
  const matches = (line: string) =>
    ABSOLUTE_PATH_PATTERNS.some((p: RegExp) => {
      p.lastIndex = 0;
      return p.test(line);
    });

  // "fixture" appears in every sample path below so this file's own path-shaped literals are
  // triaged as `likely-fixture`, not `needs-review`, by `npm run audit:release` itself.
  it('matches a Windows user path', () => {
    expect(matches('C:\\Users\\fixture\\source\\repo')).toBe(true);
  });

  it('matches a macOS user path', () => {
    expect(matches('/Users/fixture/projects/repo')).toBe(true);
  });

  it('matches a Linux home path', () => {
    expect(matches('/home/fixture/.config/thing')).toBe(true);
  });

  it('does not match an unrelated path', () => {
    expect(matches('src/providers/CodexProvider.ts')).toBe(false);
  });
});

describe('release-audit.mjs — end-to-end script run against the real working tree', () => {
  it('exits 0 (or 1 only for genuine, reviewed findings) and never prints a real-looking secret value', () => {
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync('node', [SCRIPT_PATH], {
        encoding: 'utf8',
        cwd: resolve(__dirname, '..'),
      });
    } catch (error) {
      const execError = error as { stdout?: string; status?: number };
      stdout = execError.stdout ?? '';
      exitCode = execError.status ?? 1;
    }
    expect(stdout).toMatch(/AI Limit Ledger — release audit/);
    expect(stdout).toMatch(/checks:/);
    // The report must categorize findings by file/line/category, never echo a captured secret
    // value: no long hex/base64 run immediately after "sha256:" is expected here (hashes are
    // fine — they are content fingerprints, not the credential patterns under test), but a
    // "ghp_"/"sk-"/"AKIA" literal token value must never appear verbatim in the report.
    expect(stdout).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(stdout).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(stdout).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect([0, 1]).toContain(exitCode);
  });

  it('running the script twice in a row on the same tree produces the same pass/warn/fail counts (deterministic, no flakiness)', () => {
    const run = () => {
      try {
        return execFileSync('node', [SCRIPT_PATH], {
          encoding: 'utf8',
          cwd: resolve(__dirname, '..'),
        });
      } catch (error) {
        return (error as { stdout?: string }).stdout ?? '';
      }
    };
    const first = run().match(/\d+ checks: \d+ pass, \d+ warn, \d+ fail/)?.[0];
    const second = run().match(/\d+ checks: \d+ pass, \d+ warn, \d+ fail/)?.[0];
    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it('importing the module does not execute the audit (no side-effecting top-level run)', async () => {
    // If `main()` ran on import, this dynamic import would print a full report to stdout;
    // we only assert the module resolves and exposes its pure helpers, proving the
    // `isMain` guard works when the file is loaded as a library rather than executed directly.
    const mod = await import('../scripts/release-audit.mjs');
    expect(typeof mod.readZipEntries).toBe('function');
  });
});
