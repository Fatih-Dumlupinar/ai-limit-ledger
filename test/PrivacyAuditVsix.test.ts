import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  MAX_ENTRY_INFLATED_BYTES,
  readZipEntries,
  readZipEntryContent,
  unsafeZipEntryReason,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/lib/zip-reader.mjs';
import {
  readZipEntries as reExportedReadZipEntries,
  readZipEntryContent as reExportedReadZipEntryContent,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';
import { windowsUserPath } from './privacyAuditFixtures';

type ZipEntry = { fileName: string; uncompressedSize: number; method: number };

/**
 * Builds a minimal but structurally real ZIP archive in memory.
 *
 * The privacy audit reads a VSIX through the ZIP central directory rather than shelling out to an
 * unzip tool, so these tests need to be able to hand it archives with entry names no real packer
 * would ever produce — that is the whole point of the path-traversal checks.
 */
function makeZip(files: Array<{ name: string; content: string; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const stored = file.store === true;
    const data = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, nameBytes, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));

    offset += 30 + nameBytes.length + data.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

describe('zip-reader: central directory parsing', () => {
  it('lists every entry with its name and uncompressed size', () => {
    const zip = makeZip([
      { name: 'extension/package.json', content: '{"name":"x"}' },
      { name: 'extension/out/a.js', content: 'const a = 1;' },
    ]);
    const entries = readZipEntries(zip) as ZipEntry[];
    expect(entries.map((entry) => entry.fileName)).toEqual([
      'extension/package.json',
      'extension/out/a.js',
    ]);
    expect(entries[0].uncompressedSize).toBe(12);
  });

  it('inflates a deflated entry back to its exact bytes', () => {
    const zip = makeZip([{ name: 'a.txt', content: 'hello privacy audit' }]);
    const entries = readZipEntries(zip) as ZipEntry[];
    expect((readZipEntryContent(zip, entries[0]) as Buffer).toString('utf8')).toBe(
      'hello privacy audit',
    );
  });

  it('reads a stored (uncompressed) entry', () => {
    const zip = makeZip([{ name: 'a.txt', content: 'stored bytes', store: true }]);
    const entries = readZipEntries(zip) as ZipEntry[];
    expect(entries[0].method).toBe(0);
    expect((readZipEntryContent(zip, entries[0]) as Buffer).toString('utf8')).toBe('stored bytes');
  });

  it('rejects a buffer with no end-of-central-directory record', () => {
    expect(() => readZipEntries(Buffer.from('this is not a zip file at all'))).toThrow(
      /End Of Central Directory/,
    );
  });

  it('refuses to inflate an entry that claims to exceed the memory budget', () => {
    const zip = makeZip([{ name: 'a.txt', content: 'small' }]);
    const entries = readZipEntries(zip) as ZipEntry[];
    const oversized = { ...entries[0], uncompressedSize: MAX_ENTRY_INFLATED_BYTES + 1 };
    expect(() => readZipEntryContent(zip, oversized)).toThrow(/inflate budget/);
  });

  it('is the single implementation both auditors use', () => {
    expect(reExportedReadZipEntries).toBe(readZipEntries);
    expect(reExportedReadZipEntryContent).toBe(readZipEntryContent);
  });
});

describe('zip-reader: entry-name path safety', () => {
  it('accepts an ordinary packaged entry name', () => {
    expect(unsafeZipEntryReason('extension/out/extension.js')).toBeNull();
    expect(unsafeZipEntryReason('extension/package.json')).toBeNull();
  });

  it('rejects a POSIX traversal name', () => {
    expect(unsafeZipEntryReason('../../etc/passwd')).toMatch(/above the archive root/);
    expect(unsafeZipEntryReason('extension/../../outside.txt')).toMatch(/above the archive root/);
  });

  it('rejects a Windows-style traversal name', () => {
    expect(unsafeZipEntryReason('..\\..\\windows\\system32\\x.dll')).toMatch(
      /above the archive root/,
    );
  });

  it('rejects an absolute POSIX path', () => {
    expect(unsafeZipEntryReason('/etc/shadow')).toMatch(/absolute POSIX path/);
  });

  it('rejects a drive-letter path', () => {
    expect(unsafeZipEntryReason(windowsUserPath('evil.js'))).toMatch(/drive letter/);
  });

  it('rejects a UNC path', () => {
    expect(unsafeZipEntryReason('\\\\host\\share\\evil.js')).toMatch(/UNC path/);
  });

  it('rejects an empty name and a name carrying a control character', () => {
    expect(unsafeZipEntryReason('')).toMatch(/empty/);
    expect(unsafeZipEntryReason('extension/a\u0000b.js')).toMatch(/control character/);
  });

  it('does not mistake a legitimate dotted name for traversal', () => {
    expect(unsafeZipEntryReason('extension/out/..hidden.js')).toBeNull();
    expect(unsafeZipEntryReason('extension/a..b/c.js')).toBeNull();
  });
});

describe('privacy-audit: the real packaged VSIX contract', () => {
  it('finds a personal path planted in a synthetic package entry', async () => {
    // @ts-expect-error -- plain ES module, no type declarations
    const { scanBuffer } = await import('../scripts/privacy-audit.mjs');
    const zip = makeZip([
      {
        name: 'extension/out/a.js',
        content: `const home = ${JSON.stringify(windowsUserPath('build'))};`,
      },
    ]);
    const entries = readZipEntries(zip) as ZipEntry[];
    const content = readZipEntryContent(zip, entries[0]) as Buffer;
    const result = scanBuffer({
      buffer: content,
      location: `pkg.vsix!${entries[0].fileName}`,
      surface: 'vsix',
      commit: null,
      allowlist: [],
    }) as { findings: Array<{ patternId: string; classification: string }> };
    expect(result.findings.map((f) => f.patternId)).toContain('WINDOWS_USER_PATH');
    expect(result.findings[0].classification).toBe('finding');
  });
});
