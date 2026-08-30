/**
 * Minimal, dependency-free ZIP central-directory reader.
 *
 * Node has no built-in ZIP reader and this repository has zero production dependencies, so the
 * VSIX auditors implement the small slice of the format they actually need: walk the central
 * directory for entry names/sizes, and inflate one entry's bytes on demand via `node:zlib`.
 *
 * This module was extracted from `scripts/release-audit.mjs` (Task 14.2) so the release audit and
 * the privacy audit read a VSIX through exactly one implementation rather than two drifting
 * copies. `release-audit.mjs` re-exports `readZipEntries`/`readZipEntryContent` for its existing
 * importers, so the extraction is source-compatible.
 *
 * Nothing here ever writes to disk: an entry is inflated into memory and handed back as a Buffer,
 * which is what lets the privacy audit scan a package without extracting it.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Hard ceiling on a single inflated entry, so a zip bomb cannot exhaust memory. */
export const MAX_ENTRY_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * Reads the central directory and returns one descriptor per entry.
 * @param {Buffer} buffer
 */
export function readZipEntries(buffer) {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
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
  for (let i = 0; i < cdEntryCount; i++) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) break;
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

/**
 * Inflates one entry into memory. Never writes to disk and never shells out.
 * @param {Buffer} buffer
 * @param {{fileName: string, method: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number}} entry
 */
export function readZipEntryContent(buffer, entry) {
  const off = entry.localHeaderOffset;
  if (off + 30 > buffer.length || buffer.readUInt32LE(off) !== LOCAL_HEADER_SIGNATURE)
    throw new Error(`Bad local header for ${entry.fileName}`);
  if (entry.uncompressedSize > MAX_ENTRY_INFLATED_BYTES)
    throw new Error(`Entry exceeds the inflate budget: ${entry.fileName}`);
  const fileNameLength = buffer.readUInt16LE(off + 26);
  const extraLength = buffer.readUInt16LE(off + 28);
  const dataStart = off + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.fileName}`);
}

/** Matches an ASCII control character, which has no legitimate place in an archive entry name. */
const hasControlCharacter = (value) =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });

/**
 * Rejects an archive entry name that would escape the extraction root if it were ever written out.
 *
 * The privacy audit never extracts anything, but a package carrying such a name is itself the
 * finding: it means the archive was built by something that does not sanitize paths, and any
 * consumer that *does* extract it would be walked out of its target directory. Checked against the
 * name as stored, with backslashes normalized, so a Windows-style `..\` is caught as well as `../`.
 *
 * @param {string} name
 * @returns {string | null} a reason string when the name is unsafe, otherwise null
 */
export function unsafeZipEntryReason(name) {
  if (typeof name !== 'string' || name.length === 0) return 'entry name is empty';
  const normalized = name.replaceAll('\\', '/');
  if (normalized.startsWith('//')) return 'entry name is a UNC path';
  if (normalized.startsWith('/')) return 'entry name is an absolute POSIX path';
  if (/^[A-Za-z]:/.test(normalized)) return 'entry name carries a drive letter';
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../'))
    return 'entry name traverses above the archive root';
  if (normalized.endsWith('/..')) return 'entry name traverses above the archive root';
  if (hasControlCharacter(name)) return 'entry name contains a control character';
  return null;
}
