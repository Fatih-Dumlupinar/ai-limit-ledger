import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enableClaudeIntegration,
  type ClaudeIntegrationDeps,
} from '../../src/providers/claude/ClaudeIntegrationTransaction';
import {
  isAwaitingSessionRestart,
  isEnabled,
  loadOwnership,
  loadRecovery,
} from '../../src/providers/claude/ClaudeRecoveryStore';
import { readSettings } from '../../src/providers/claude/ClaudeSettingsFile';
import type { RunResult } from '../../src/providers/claude/ClaudeWrapperRunner';
import { fakeConfirm, fakeGlobalState, fakeSecrets, makeTempDir, realFs } from './fixtures';

const OK: RunResult = { stdout: 'ok', exitCode: 0, timedOut: false };
const FAIL: RunResult = { stdout: '', exitCode: null, timedOut: false };

describe('enableClaudeIntegration', () => {
  let dir: string;
  let settingsPath: string;
  let globalStorageDir: string;
  let snapshotPath: string;
  let changed: number;

  function baseDeps(overrides: Partial<ClaudeIntegrationDeps> = {}): ClaudeIntegrationDeps {
    changed = 0;
    return {
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
      platform: 'win32',
      confirm: fakeConfirm(),
      runWrapper: async () => OK,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      globalStorageDir,
      snapshotPath,
      onIntegrationChanged: () => {
        changed += 1;
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    dir = await makeTempDir('ai-limit-ledger-tx-');
    settingsPath = path.join(dir, 'settings.json');
    globalStorageDir = path.join(dir, 'global-storage');
    snapshotPath = path.join(dir, 'snapshot.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('installs a standalone bridge when there is no existing statusLine', async () => {
    const deps = baseDeps();
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });
    expect(changed).toBe(1);

    const settings = await readSettings(realFs(), settingsPath);
    const statusLine = settings.parsed.statusLine as Record<string, unknown>;
    expect(statusLine._aiLimitLedger).toBeUndefined();
    expect(typeof statusLine.command).toBe('string');
    expect(String(statusLine.command)).toContain('claude-bridge.ps1');
    const ownership = loadOwnership(deps.globalState);
    expect(ownership?.mode).toBe('standalone');
    expect(isEnabled(deps.globalState)).toBe(true);
  });

  it('sets refreshInterval on a fresh standalone install, defaulting to 15 seconds', async () => {
    const deps = baseDeps();
    await enableClaudeIntegration(deps);
    const settings = await readSettings(realFs(), settingsPath);
    const statusLine = settings.parsed.statusLine as Record<string, unknown>;
    expect(statusLine.refreshInterval).toBe(15);
  });

  it('uses the configured refreshIntervalSeconds when provided', async () => {
    const deps = baseDeps({ refreshIntervalSeconds: 45 });
    await enableClaudeIntegration(deps);
    const settings = await readSettings(realFs(), settingsPath);
    const statusLine = settings.parsed.statusLine as Record<string, unknown>;
    expect(statusLine.refreshInterval).toBe(45);
  });

  it('cancels cleanly when the user declines the intro', async () => {
    const deps = baseDeps({ confirm: fakeConfirm({ showIntro: async () => false }) });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(changed).toBe(0);
    const settings = await readSettings(realFs(), settingsPath);
    expect(settings.existed).toBe(false);
  });

  it('preserves and chains behind an existing third-party statusLine', async () => {
    const original = {
      type: 'command',
      command: 'node C:\\tools\\my-status.js',
      padding: 3,
      refreshInterval: 500,
      hideVimModeIndicator: true,
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: original, other: 'kept' }, null, 2),
      'utf8',
    );

    const deps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'chained' });

    const settings = await readSettings(realFs(), settingsPath);
    expect(settings.parsed.other).toBe('kept');
    const newStatusLine = settings.parsed.statusLine as Record<string, unknown>;
    expect(newStatusLine.padding).toBe(3);
    expect(newStatusLine.refreshInterval).toBe(500);
    expect(newStatusLine.hideVimModeIndicator).toBe(true);
    expect(newStatusLine.command).not.toBe(original.command);

    const recovery = await loadRecovery(deps.secrets);
    expect(recovery?.present).toBe(true);
    expect(recovery?.statusLine).toEqual(original);

    const ownership = loadOwnership(deps.globalState);
    expect(ownership?.mode).toBe('chained');
    expect(ownership?.wrapperPath).toBeTruthy();
    const wrapperExists = await fs
      .readFile(ownership!.wrapperPath!, 'utf8')
      .then(() => true)
      .catch(() => false);
    expect(wrapperExists).toBe(true);
  });

  it('replaces after backup, keeping recovery data for a future disable', async () => {
    const original = { type: 'command', command: 'node C:\\tools\\my-status.js' };
    await fs.writeFile(settingsPath, JSON.stringify({ statusLine: original }), 'utf8');

    const deps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'replace' }),
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });

    const backups = (await fs.readdir(dir)).filter(
      (f) => f.includes('.ai-limit-ledger.') && f.endsWith('.bak'),
    );
    expect(backups).toHaveLength(1);
    const recovery = await loadRecovery(deps.secrets);
    expect(recovery?.statusLine).toEqual(original);
  });

  it('cancels without writing anything when the user cancels the existing-statusLine choice', async () => {
    const original = { type: 'command', command: 'node C:\\tools\\my-status.js' };
    const raw = JSON.stringify({ statusLine: original });
    await fs.writeFile(settingsPath, raw, 'utf8');

    const deps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'cancel' }),
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(raw);
    expect(changed).toBe(0);
  });

  it('re-enabling an already-owned, healthy integration does not prompt again', async () => {
    const deps1 = baseDeps();
    await enableClaudeIntegration(deps1);
    let confirmCalls = 0;
    const deps2 = baseDeps({
      globalState: deps1.globalState,
      secrets: deps1.secrets,
      confirm: fakeConfirm({
        chooseExistingStatusLineAction: async () => {
          confirmCalls += 1;
          return 'preserve';
        },
      }),
    });
    const outcome = await enableClaudeIntegration(deps2);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });
    expect(confirmCalls).toBe(0);
  });

  it('migrates the legacy 0.3.1 marker silently, without prompting', async () => {
    const bridgePath = path.join(globalStorageDir, 'claude-bridge.ps1');
    await fs.mkdir(globalStorageDir, { recursive: true });
    await fs.writeFile(bridgePath, '# legacy bridge', 'utf8');
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${bridgePath}"`,
          _aiLimitLedger: 'ai-limit-ledger-status-line-v1',
        },
      }),
      'utf8',
    );
    let prompted = false;
    const deps = baseDeps({
      confirm: fakeConfirm({
        chooseExistingStatusLineAction: async () => {
          prompted = true;
          return 'cancel';
        },
      }),
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome.kind).toBe('enabled');
    expect(prompted).toBe(false);
    expect(isEnabled(deps.globalState)).toBe(true);
  });

  it('recognizes ownership by wrapper path even after Claude Code strips the _aiLimitLedger marker', async () => {
    const deps1 = baseDeps();
    await enableClaudeIntegration(deps1);

    // Simulate Claude Code rewriting settings.json through its own schema (which has no
    // passthrough for statusLine) and dropping the marker, while the command is untouched.
    const settings = await readSettings(realFs(), settingsPath);
    const statusLine = { ...(settings.parsed.statusLine as Record<string, unknown>) };
    delete statusLine._aiLimitLedger;
    await fs.writeFile(settingsPath, JSON.stringify({ ...settings.parsed, statusLine }), 'utf8');

    let prompted = false;
    const deps2 = baseDeps({
      globalState: deps1.globalState,
      secrets: deps1.secrets,
      confirm: fakeConfirm({
        chooseExistingStatusLineAction: async () => {
          prompted = true;
          return 'cancel';
        },
      }),
    });
    const outcome = await enableClaudeIntegration(deps2);
    expect(outcome.kind).toBe('enabled');
    expect(prompted).toBe(false);
  });

  it('offers repair when the owned wrapper file is missing, and repairs on confirmation', async () => {
    const deps1 = baseDeps();
    await enableClaudeIntegration(deps1);
    const ownership = loadOwnership(deps1.globalState);
    await fs.unlink(ownership!.wrapperPath!);

    let repairPrompted = false;
    const deps2 = baseDeps({
      globalState: deps1.globalState,
      secrets: deps1.secrets,
      confirm: fakeConfirm({
        confirmRepair: async () => {
          repairPrompted = true;
          return true;
        },
      }),
    });
    const outcome = await enableClaudeIntegration(deps2);
    expect(repairPrompted).toBe(true);
    expect(outcome.kind).toBe('enabled');
    const wrapperExists = await fs
      .readFile(ownership!.wrapperPath!, 'utf8')
      .then(() => true)
      .catch(() => false);
    expect(wrapperExists).toBe(true);
  });

  it('preserves the previous enabled state when a repair transaction fails', async () => {
    const deps1 = baseDeps();
    await enableClaudeIntegration(deps1);
    const ownership = loadOwnership(deps1.globalState);
    await fs.unlink(ownership!.wrapperPath!);

    const deps2 = baseDeps({
      globalState: deps1.globalState,
      secrets: deps1.secrets,
      confirm: fakeConfirm({ confirmRepair: async () => true }),
      fs: {
        ...realFs(),
        writeFile: async () => {
          throw new Error('simulated repair write failure');
        },
      },
    });
    const outcome = await enableClaudeIntegration(deps2);

    expect(outcome.kind).toBe('error');
    expect(isEnabled(deps2.globalState)).toBe(true);
  });

  it('rolls back to the original statusLine when the wrapper self-check fails', async () => {
    const original = { type: 'command', command: 'node C:\\tools\\my-status.js' };
    const raw = JSON.stringify({ statusLine: original });
    await fs.writeFile(settingsPath, raw, 'utf8');

    const deps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
      runWrapper: async () => FAIL,
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome.kind).toBe('error');
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(raw);
    expect(changed).toBe(0);

    const entries = await fs.readdir(globalStorageDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it('regenerates a stale standalone wrapper on re-enable, even though the file still exists', async () => {
    const deps1 = baseDeps();
    await enableClaudeIntegration(deps1);
    const ownership = loadOwnership(deps1.globalState);
    const wrapperPath = ownership!.wrapperPath!;

    // Simulate a wrapper generated by an older extension version: present on disk, but its
    // content no longer matches what the current generator would produce.
    await fs.writeFile(wrapperPath, '# stale wrapper from an older version', 'utf8');

    let repairPrompted = false;
    const deps2 = baseDeps({
      globalState: deps1.globalState,
      secrets: deps1.secrets,
      confirm: fakeConfirm({
        confirmRepair: async () => {
          repairPrompted = true;
          return true;
        },
      }),
    });
    const outcome = await enableClaudeIntegration(deps2);
    expect(repairPrompted).toBe(true);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });

    const regenerated = await fs.readFile(wrapperPath, 'utf8');
    expect(regenerated).not.toBe('# stale wrapper from an older version');
    expect(regenerated).toContain('schemaVersion');
  });

  it('reinstalls the bridge and statusLine after an external process dropped the statusLine key entirely', async () => {
    const deps1 = baseDeps();
    await enableClaudeIntegration(deps1);

    // Simulate the regression this hotfix targets: some external rewrite of settings.json (an
    // auto-update, another tool) drops the statusLine key outright while the wrapper survives.
    const settings = await readSettings(realFs(), settingsPath);
    const withoutStatusLine = { ...settings.parsed };
    delete (withoutStatusLine as Record<string, unknown>).statusLine;
    await fs.writeFile(settingsPath, JSON.stringify(withoutStatusLine), 'utf8');

    const deps2 = baseDeps({ globalState: deps1.globalState, secrets: deps1.secrets });
    const outcome = await enableClaudeIntegration(deps2);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });

    const after = await readSettings(realFs(), settingsPath);
    const statusLine = after.parsed.statusLine as Record<string, unknown>;
    expect(typeof statusLine.command).toBe('string');
    expect(String(statusLine.command)).toContain('claude-bridge.ps1');
  });

  it('adds statusLine to settings.json while preserving all unrelated existing keys (fresh install)', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash'] }, theme: 'dark' }),
      'utf8',
    );
    const deps = baseDeps();
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });
    const after = await readSettings(realFs(), settingsPath);
    expect(after.parsed.permissions).toEqual({ allow: ['Bash'] });
    expect(after.parsed.theme).toBe('dark');
    expect(typeof (after.parsed.statusLine as Record<string, unknown>).command).toBe('string');
  });

  it('preserves an unrelated setting changed concurrently, right up to the moment of commit', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({}), 'utf8');
    let settingsReadCount = 0;
    const deps = baseDeps({
      fs: {
        ...realFs(),
        // Simulates another process (e.g. Claude Code itself) writing an unrelated field to
        // settings.json in the gap between our transaction starting and it committing: the
        // second read of settingsPath (the fresh read `writeStatusLineOnly` does immediately
        // before writing) observes a field that was not there on the first read.
        readFile: async (filePath, encoding) => {
          const content = await fs.readFile(filePath, encoding);
          if (filePath === settingsPath) {
            settingsReadCount += 1;
            if (settingsReadCount === 2) {
              const parsed = JSON.parse(content) as Record<string, unknown>;
              return JSON.stringify({ ...parsed, concurrentField: 'newest-value' });
            }
          }
          return content;
        },
      },
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });
    const after = await readSettings(realFs(), settingsPath);
    expect(after.parsed.concurrentField).toBe('newest-value');
  });

  it('detects a concurrent external statusLine change and aborts without overwriting it (external-change)', async () => {
    const racerStatusLine = { type: 'command', command: 'node C:\\other-tool\\status.js' };
    const deps = baseDeps({
      fs: {
        ...realFs(),
        rename: async (oldPath, newPath) => {
          await fs.rename(oldPath, newPath);
          if (newPath === settingsPath) {
            // Simulates another process winning the race immediately after our own commit.
            await fs.writeFile(
              settingsPath,
              JSON.stringify({ statusLine: racerStatusLine }),
              'utf8',
            );
          }
        },
      },
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/another process|verify the Claude Code statusLine/i);
    }
    const after = await readSettings(realFs(), settingsPath);
    expect(after.parsed.statusLine).toEqual(racerStatusLine);
  });

  it('does not report success when the statusLine is missing immediately after commit (post-commit verification)', async () => {
    const original = { type: 'command', command: 'node C:\\tools\\my-status.js' };
    await fs.writeFile(settingsPath, JSON.stringify({ statusLine: original }), 'utf8');
    const deps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'replace' }),
      fs: {
        ...realFs(),
        rename: async (oldPath, newPath) => {
          await fs.rename(oldPath, newPath);
          if (newPath === settingsPath) {
            await fs.writeFile(settingsPath, JSON.stringify({}), 'utf8');
          }
        },
      },
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome.kind).toBe('error');
    expect(isEnabled(deps.globalState)).toBe(false);
  });

  it('preserves existing recovery metadata across a repair, without overwriting it with our own command', async () => {
    const original = { type: 'command', command: 'node C:\\tools\\my-status.js' };
    await fs.writeFile(settingsPath, JSON.stringify({ statusLine: original }), 'utf8');
    const enableDeps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'replace' }),
    });
    await enableClaudeIntegration(enableDeps);
    const recoveryBefore = await loadRecovery(enableDeps.secrets);
    expect(recoveryBefore?.statusLine).toEqual(original);
    const originalHash = loadOwnership(enableDeps.globalState)?.originalStatusLineHash;

    const ownership = loadOwnership(enableDeps.globalState);
    await fs.writeFile(ownership!.wrapperPath!, '# stale wrapper', 'utf8');

    const repairDeps = baseDeps({
      globalState: enableDeps.globalState,
      secrets: enableDeps.secrets,
      confirm: fakeConfirm({ confirmRepair: async () => true }),
    });
    const outcome = await enableClaudeIntegration(repairDeps);
    expect(outcome).toEqual({ kind: 'enabled', mode: 'standalone' });
    expect(isEnabled(repairDeps.globalState)).toBe(true);
    expect(isAwaitingSessionRestart(repairDeps.globalState)).toBe(true);
    expect(changed).toBe(1);

    const recoveryAfter = await loadRecovery(repairDeps.secrets);
    expect(recoveryAfter?.statusLine).toEqual(original);
    // The recorded "original" hash must still trace back to the real prior third-party command,
    // never to the command we ourselves just installed.
    expect(loadOwnership(repairDeps.globalState)?.originalStatusLineHash).toBe(originalHash);
  });

  it('rejects preserve when the existing statusLine is not a runnable command entry', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'something-else' } }),
      'utf8',
    );
    const deps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
    });
    const outcome = await enableClaudeIntegration(deps);
    expect(outcome.kind).toBe('error');
  });
});
