import * as path from 'node:path';

export interface FsLike {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  writeFile(filePath: string, data: string, options?: { mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export type Json = Record<string, unknown>;

export const asJsonObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

export interface SettingsRead {
  raw: string;
  parsed: Json;
  existed: boolean;
}

/** Reads ~/.claude/settings.json. Absence is not an error — Claude Code treats a missing file as empty settings. */
export async function readSettings(fs: FsLike, targetPath: string): Promise<SettingsRead> {
  let raw: string;
  try {
    raw = await fs.readFile(targetPath, 'utf8');
  } catch {
    return { raw: '{}', parsed: {}, existed: false };
  }
  let parsed: Json;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('not an object');
    parsed = value as Json;
  } catch {
    throw new Error('Claude Code settings.json contains invalid JSON.');
  }
  return { raw, parsed, existed: true };
}

/** Writes a file via temp-file + atomic rename in the same directory, never leaving a partial file at the final path. */
export async function atomicWriteFile(
  fs: FsLike,
  targetPath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = `${targetPath}.ai-limit-ledger-tmp-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tempPath, content, mode !== undefined ? { mode } : undefined);
  await fs.rename(tempPath, targetPath);
}

/** Byte-exact, timestamped backup of the settings file as it existed before any mutation. */
export async function byteExactBackup(
  fs: FsLike,
  targetPath: string,
  rawContent: string,
  clock: () => Date,
): Promise<string> {
  const stamp = clock().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${targetPath}.ai-limit-ledger.${stamp}.bak`;
  await fs.writeFile(backupPath, rawContent, { mode: 0o600 });
  return backupPath;
}

/**
 * Re-reads the settings file and writes back only the `statusLine` key, preserving every other
 * key untouched. Pass `newStatusLine: undefined` to delete the key entirely.
 */
export async function writeStatusLineOnly(
  fs: FsLike,
  targetPath: string,
  newStatusLine: unknown,
): Promise<Json> {
  return writeKeyOnly(fs, targetPath, 'statusLine', newStatusLine);
}

/**
 * Re-reads the settings file and writes back only the given top-level key, preserving every
 * other key (including sibling keys under the same parent object) untouched. Pass
 * `newValue: undefined` to delete the key entirely.
 */
export async function writeKeyOnly(
  fs: FsLike,
  targetPath: string,
  key: string,
  newValue: unknown,
): Promise<Json> {
  const current = await readSettings(fs, targetPath);
  const next: Json = { ...current.parsed };
  if (newValue === undefined) delete next[key];
  else next[key] = newValue;
  await atomicWriteFile(fs, targetPath, JSON.stringify(next, null, 2));
  return next;
}
