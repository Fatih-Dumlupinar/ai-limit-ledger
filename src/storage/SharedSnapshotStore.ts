import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProviderSnapshot } from '../providers/types';

const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BASE_DELAY_MS = 10;

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // Windows can transiently deny a rename onto an existing destination while another
  // in-flight rename/read briefly holds the file (antivirus scan, indexing, or a second
  // concurrent writer completing its own rename to the same target) — never seen on POSIX
  // rename, which is atomic. Retrying a handful of times with a short backoff clears it
  // without masking a genuine, persistent failure (e.g. a read-only destination).
  return code === 'EPERM' || code === 'EBUSY';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithBoundedRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt === RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) throw error;
      await delay(RENAME_BASE_DELAY_MS * attempt);
    }
  }
}

export class SharedSnapshotStore {
  constructor(private readonly directory: string) {}
  private get file(): string {
    return path.join(this.directory, 'provider-snapshots.json');
  }
  async write(snapshots: ProviderSnapshot[]): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    // pid + Date.now() alone can collide when multiple SharedSnapshotStore instances in the
    // same process write within the same millisecond (e.g. several providers refreshing at
    // once); the random suffix guarantees a unique temp path per call regardless of timing.
    const temp = `${this.file}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, snapshots }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await renameWithBoundedRetry(temp, this.file);
  }
  async read(): Promise<ProviderSnapshot[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8')) as {
        snapshots?: ProviderSnapshot[];
      };
      return Array.isArray(value.snapshots) ? value.snapshots : [];
    } catch {
      return [];
    }
  }
}
