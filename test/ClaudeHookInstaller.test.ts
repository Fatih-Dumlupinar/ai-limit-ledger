import { describe, expect, it } from 'vitest';
import {
  hookScriptPathFor,
  installActivityHooks,
  uninstallActivityHooks,
} from '../src/providers/claude/hooks/ClaudeHookInstaller';
import type { FsLike } from '../src/providers/claude/ClaudeSettingsFile';

function memoryFs(initial: Record<string, string> = {}): FsLike & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error('ENOENT');
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdir: async () => undefined,
    unlink: async (p) => {
      files.delete(p);
    },
  };
}

const SETTINGS = '/fixture/.claude/settings.json';
const STORAGE = '/fixture/globalStorage';
const ACTIVITY = '/fixture/globalStorage/claude-hook-activity.jsonl';

describe('installActivityHooks / uninstallActivityHooks', () => {
  it('adds Stop/StopFailure/SessionStart entries without touching an unrelated existing hook', async () => {
    const fs = memoryFs({
      [SETTINGS]: JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      }),
    });
    const result = await installActivityHooks(fs, SETTINGS, STORAGE, 'linux', ACTIVITY);
    expect(result.ok).toBe(true);
    const settings = JSON.parse(fs.files.get(SETTINGS)!);
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'Write', hooks: [{ type: 'command', command: 'echo hi' }] },
    ]);
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.StopFailure).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    const scriptPath = hookScriptPathFor(STORAGE, 'linux');
    expect(fs.files.get(scriptPath)).toContain('schemaVersion');
  });

  it('is idempotent: running install twice does not duplicate the entry', async () => {
    const fs = memoryFs({ [SETTINGS]: JSON.stringify({}) });
    await installActivityHooks(fs, SETTINGS, STORAGE, 'linux', ACTIVITY);
    await installActivityHooks(fs, SETTINGS, STORAGE, 'linux', ACTIVITY);
    const settings = JSON.parse(fs.files.get(SETTINGS)!);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('uninstall removes only our own entry, preserving a user hook on the same event', async () => {
    const scriptPath = hookScriptPathFor(STORAGE, 'linux');
    const fs = memoryFs({
      [SETTINGS]: JSON.stringify({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'node ' + scriptPath }] },
            {
              matcher: '',
              hooks: [{ type: 'command', command: '/usr/local/bin/my-own-stop-hook' }],
            },
          ],
        },
      }),
    });
    const result = await uninstallActivityHooks(fs, SETTINGS, STORAGE, 'linux');
    expect(result.ok).toBe(true);
    const settings = JSON.parse(fs.files.get(SETTINGS)!);
    expect(settings.hooks.Stop).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/my-own-stop-hook' }] },
    ]);
  });

  it('uninstall removes the whole event key once it becomes empty, and drops "hooks" entirely once nothing remains', async () => {
    const fs = memoryFs({ [SETTINGS]: JSON.stringify({ other: true }) });
    await installActivityHooks(fs, SETTINGS, STORAGE, 'linux', ACTIVITY);
    await uninstallActivityHooks(fs, SETTINGS, STORAGE, 'linux');
    const settings = JSON.parse(fs.files.get(SETTINGS)!);
    expect(settings.hooks).toBeUndefined();
    expect(settings.other).toBe(true);
  });
});
