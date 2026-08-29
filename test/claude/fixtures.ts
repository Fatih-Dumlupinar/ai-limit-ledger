import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FsLike } from '../../src/providers/claude/ClaudeSettingsFile';
import type { GlobalStateLike, SecretsLike } from '../../src/providers/claude/ClaudeRecoveryStore';
import type { ConfirmUi } from '../../src/providers/claude/ClaudeIntegrationTransaction';

export function realFs(): FsLike {
  return {
    readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
    writeFile: async (filePath, data, options) => {
      await fs.writeFile(filePath, data, options);
    },
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    mkdir: async (dirPath, options) => {
      await fs.mkdir(dirPath, options);
    },
    unlink: (filePath) => fs.unlink(filePath),
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function fakeSecrets(
  initial: Record<string, string> = {},
): SecretsLike & { store: (k: string, v: string) => Promise<void> } {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.get(key);
    },
    async store(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export function fakeGlobalState(initial: Record<string, unknown> = {}): GlobalStateLike {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue: T): T {
      return store.has(key) ? (store.get(key) as T) : defaultValue;
    },
    async update(key, value) {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

export function fakeConfirm(overrides: Partial<ConfirmUi> = {}): ConfirmUi {
  return {
    showIntro: async () => true,
    showConsent: async () => 'auto',
    chooseExistingStatusLineAction: async () => 'preserve',
    confirmRepair: async () => true,
    notify: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
}
