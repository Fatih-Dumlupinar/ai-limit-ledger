import * as path from 'node:path';
import { commandTargetsPath } from '../ClaudeOwnership';
import {
  asJsonObject,
  atomicWriteFile,
  readSettings,
  writeKeyOnly,
  type FsLike,
  type Json,
} from '../ClaudeSettingsFile';
import { generatePosixHookScript, generateWindowsHookScript } from './ClaudeHookScriptGenerator';

/** Documented Claude Code hook events this bridge listens to — activity signal only, never a limit source. */
export const HOOK_EVENTS = ['Stop', 'StopFailure', 'SessionStart'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export function hookScriptPathFor(globalStorageDir: string, platform: NodeJS.Platform): string {
  return path.join(
    globalStorageDir,
    platform === 'win32' ? 'claude-hook-bridge.ps1' : 'claude-hook-bridge.js',
  );
}

function hookCommandFor(scriptPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
    : `node "${scriptPath}"`;
}

interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command?: string; async?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

const isHookGroup = (value: unknown): value is HookGroup =>
  Boolean(asJsonObject(value) && Array.isArray((value as Json).hooks));

/** Whether this event's group array already contains our own hook entry, structurally recognized by command path. */
function hasOwnEntry(groups: unknown, scriptPath: string): boolean {
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (group) =>
      isHookGroup(group) && group.hooks.some((h) => commandTargetsPath(h.command, scriptPath)),
  );
}

/** Removes only our own hook entries from an event's group array; groups/entries belonging to the user are untouched. */
function withoutOwnEntries(groups: unknown, scriptPath: string): unknown {
  if (!Array.isArray(groups)) return groups;
  return groups
    .map((group) => {
      if (!isHookGroup(group)) return group;
      const remaining = group.hooks.filter((h) => !commandTargetsPath(h.command, scriptPath));
      if (remaining.length === group.hooks.length) return group;
      return remaining.length ? { ...group, hooks: remaining } : null;
    })
    .filter((group) => group !== null);
}

export interface InstallHooksResult {
  ok: boolean;
  message?: string;
}

/**
 * Installs the activity-only Stop/StopFailure/SessionStart hook bridge, additive and idempotent:
 * every existing hook (ours or a user's own) in `~/.claude/settings.json` is preserved untouched;
 * only a missing AI Limit Ledger entry is appended to each event's group array. Never installed
 * unless the experimental OAuth usage feature has been separately, explicitly consented to.
 */
export async function installActivityHooks(
  fs: FsLike,
  settingsPath: string,
  globalStorageDir: string,
  platform: NodeJS.Platform,
  activityPath: string,
): Promise<InstallHooksResult> {
  const scriptPath = hookScriptPathFor(globalStorageDir, platform);
  const script =
    platform === 'win32'
      ? generateWindowsHookScript(activityPath)
      : generatePosixHookScript(activityPath);
  try {
    const stagingPath = `${scriptPath}.staging`;
    await atomicWriteFile(fs, stagingPath, script, platform === 'win32' ? undefined : 0o700);
    await fs.rename(stagingPath, scriptPath);
  } catch {
    return { ok: false, message: 'Could not install the AI Limit Ledger activity hook script.' };
  }

  try {
    const settings = await readSettings(fs, settingsPath);
    const hooks: Json = { ...(asJsonObject(settings.parsed.hooks) ?? {}) };
    for (const event of HOOK_EVENTS) {
      const existingGroups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      if (hasOwnEntry(existingGroups, scriptPath)) continue;
      hooks[event] = [
        ...existingGroups,
        {
          matcher: '',
          hooks: [{ type: 'command', command: hookCommandFor(scriptPath, platform), async: true }],
        },
      ];
    }
    await writeKeyOnly(fs, settingsPath, 'hooks', hooks);
  } catch {
    return { ok: false, message: 'Could not update Claude Code hooks settings.' };
  }
  return { ok: true };
}

/**
 * Removes only AI Limit Ledger's own hook entries (structurally recognized by command path),
 * leaving every other hook — any event, any tool — exactly as the user configured it. If an
 * event's array or the whole `hooks` object becomes empty as a result, that now-empty key is
 * removed too, rather than leaving `"Stop": []` behind.
 */
export async function uninstallActivityHooks(
  fs: FsLike,
  settingsPath: string,
  globalStorageDir: string,
  platform: NodeJS.Platform,
): Promise<InstallHooksResult> {
  const scriptPath = hookScriptPathFor(globalStorageDir, platform);
  try {
    const settings = await readSettings(fs, settingsPath);
    const hooksObject = asJsonObject(settings.parsed.hooks);
    if (hooksObject) {
      const hooks: Json = { ...hooksObject };
      for (const event of HOOK_EVENTS) {
        if (!(event in hooks)) continue;
        const filtered = withoutOwnEntries(hooks[event], scriptPath);
        if (Array.isArray(filtered) && filtered.length === 0) delete hooks[event];
        else hooks[event] = filtered;
      }
      await writeKeyOnly(fs, settingsPath, 'hooks', Object.keys(hooks).length ? hooks : undefined);
    }
  } catch {
    return { ok: false, message: 'Could not update Claude Code hooks settings.' };
  }
  try {
    await fs.unlink(scriptPath);
  } catch {
    /* best-effort cleanup only */
  }
  return { ok: true };
}
