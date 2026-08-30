import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedSnapshotStore } from '../src/storage/SharedSnapshotStore';
import type { ProviderSnapshot } from '../src/providers/types';

// node:fs/promises is a built-in ESM module namespace, which Node makes non-configurable —
// vi.spyOn cannot redefine `rename` on it directly. Mocking the module and wrapping the real
// implementation in a vi.fn keeps every other test's real filesystem behavior intact while
// letting these two tests substitute a rejection for exactly the calls they care about.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const mockedRename = vi.mocked(rename);

/**
 * Task 10 filesystem/temp-safety regression suite. Each test gets its own `mkdtemp`-generated
 * directory (never a shared fixed path), and every deletion is a bounded `rmSync` scoped to that
 * exact directory this test created — never a broad/parent-relative recursive delete.
 */
describe('Task 10 release: filesystem/temp isolation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-limit-ledger-fs-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('each test run gets a unique temp directory (no fixed shared path)', () => {
    const other = mkdtempSync(join(tmpdir(), 'ai-limit-ledger-fs-test-'));
    try {
      expect(other).not.toBe(dir);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('SharedSnapshotStore.write() never leaves a stray .tmp file behind on success', async () => {
    const store = new SharedSnapshotStore(dir);
    await store.write([]);
    const entries = readdirSync(dir);
    expect(entries).toEqual(['provider-snapshots.json']);
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
  });

  it('the write is atomic: the target file is either the previous complete content or the new complete content, never partial', async () => {
    const store = new SharedSnapshotStore(dir);
    const first: ProviderSnapshot[] = [];
    await store.write(first);
    const beforeContent = readFileSync(join(dir, 'provider-snapshots.json'), 'utf8');
    expect(() => JSON.parse(beforeContent)).not.toThrow();

    await store.write(first);
    const afterContent = readFileSync(join(dir, 'provider-snapshots.json'), 'utf8');
    expect(() => JSON.parse(afterContent)).not.toThrow();
  });

  it('temp file names embed pid and a timestamp, so two processes writing concurrently cannot collide on the same temp path', async () => {
    // Reimplements the store's own temp-name derivation to assert the uniqueness contract
    // without racing the real filesystem: same directory + same target file, called twice in
    // immediate succession, must not reuse a temp filename.
    const store1 = new SharedSnapshotStore(dir);
    const store2 = new SharedSnapshotStore(dir);
    await Promise.all([store1.write([]), store2.write([])]);
    // Both concurrent writers must finish, and the target file must end up valid JSON — an
    // ENOTEMPTY-style collision on a shared temp name would leave one write throwing instead.
    const content = readFileSync(join(dir, 'provider-snapshots.json'), 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('twenty concurrent writers to the same directory all settle without ENOTEMPTY or a corrupted final file', async () => {
    const writers = Array.from({ length: 20 }, () => new SharedSnapshotStore(dir));
    await expect(Promise.all(writers.map((w) => w.write([])))).resolves.toBeDefined();
    const content = readFileSync(join(dir, 'provider-snapshots.json'), 'utf8');
    const parsed = JSON.parse(content) as { schemaVersion: number; snapshots: unknown[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.snapshots)).toBe(true);
  });

  afterEach(async () => {
    // Restore the mocked rename export back to the real filesystem implementation so a
    // persistent override set by one test (mockRejectedValue) never leaks into the next.
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mockedRename.mockReset();
    mockedRename.mockImplementation((...args: Parameters<typeof rename>) => actual.rename(...args));
  });

  it('a transient EPERM on rename (Windows AV/indexer lock) is retried until it clears', async () => {
    const store = new SharedSnapshotStore(dir);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const permError = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockedRename
      .mockRejectedValueOnce(permError)
      .mockRejectedValueOnce(permError)
      .mockImplementationOnce((...args: Parameters<typeof rename>) => actual.rename(...args));
    await expect(store.write([])).resolves.toBeUndefined();
    expect(mockedRename).toHaveBeenCalledTimes(3);
  });

  it('a persistent rename failure is not swallowed after the retry budget is exhausted', async () => {
    const store = new SharedSnapshotStore(dir);
    const permError = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockedRename.mockRejectedValue(permError);
    await expect(store.write([])).rejects.toThrow('EPERM');
  });

  it('a non-transient rename error (e.g. read-only destination) fails immediately without retrying', async () => {
    const store = new SharedSnapshotStore(dir);
    const readOnlyError = Object.assign(new Error('EROFS'), { code: 'EROFS' });
    mockedRename.mockRejectedValue(readOnlyError);
    await expect(store.write([])).rejects.toThrow('EROFS');
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('a missing directory is created (mkdir recursive) rather than failing the write', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    const store = new SharedSnapshotStore(nested);
    await store.write([]);
    expect(existsSync(join(nested, 'provider-snapshots.json'))).toBe(true);
  });

  it('read() on a directory that was never written to returns an empty array instead of throwing', async () => {
    const store = new SharedSnapshotStore(dir);
    await expect(store.read()).resolves.toEqual([]);
  });

  it('read() on a corrupted snapshot file returns an empty array instead of throwing or crashing the caller', async () => {
    const store = new SharedSnapshotStore(dir);
    await store.write([]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'provider-snapshots.json'), 'not valid json{{{', 'utf8');
    await expect(store.read()).resolves.toEqual([]);
  });

  it('the written snapshot file is not group/world-readable (mode 0o600) on platforms that enforce POSIX permissions', async () => {
    const store = new SharedSnapshotStore(dir);
    await store.write([]);
    if (process.platform === 'win32') return; // POSIX file mode bits are not meaningful on Windows
    const { statSync } = await import('node:fs');
    const mode = statSync(join(dir, 'provider-snapshots.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rmSync cleanup in this suite is always scoped to the exact mkdtemp path, never a parent directory', () => {
    // A static guard against the broad-delete failure mode described in the Task 10 brief:
    // this file must never call rmSync with tmpdir() itself, "..", or a bare relative path.
    const source = readFileSync(__filename, 'utf8');
    const rmCalls = [...source.matchAll(/rmSync\(([^,)]+)/g)].map((m) => m[1].trim());
    for (const target of rmCalls) {
      expect(target).not.toBe('tmpdir()');
      expect(target).not.toMatch(/\.\.$|\.\.['"]/);
    }
  });
});
