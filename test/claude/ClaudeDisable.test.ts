import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disableClaudeIntegration,
  enableClaudeIntegration,
  type ClaudeIntegrationDeps,
} from '../../src/providers/claude/ClaudeIntegrationTransaction';
import { isEnabled } from '../../src/providers/claude/ClaudeRecoveryStore';
import { readSettings } from '../../src/providers/claude/ClaudeSettingsFile';
import type { RunResult } from '../../src/providers/claude/ClaudeWrapperRunner';
import { fakeConfirm, fakeGlobalState, fakeSecrets, makeTempDir, realFs } from './fixtures';

const OK: RunResult = { stdout: 'ok', exitCode: 0, timedOut: false };

describe('disableClaudeIntegration', () => {
  let dir: string;
  let settingsPath: string;
  let globalStorageDir: string;
  let snapshotPath: string;

  function baseDeps(overrides: Partial<ClaudeIntegrationDeps> = {}): ClaudeIntegrationDeps {
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
      onIntegrationChanged: () => undefined,
      ...overrides,
    };
  }

  beforeEach(async () => {
    dir = await makeTempDir('ai-limit-ledger-disable-');
    settingsPath = path.join(dir, 'settings.json');
    globalStorageDir = path.join(dir, 'global-storage');
    snapshotPath = path.join(dir, 'snapshot.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when the statusLine is not managed by AI Limit Ledger', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'x' } }),
      'utf8',
    );
    const deps = baseDeps();
    const outcome = await disableClaudeIntegration(deps);
    expect(outcome).toEqual({ kind: 'not-managed' });
  });

  it('restores the original chained statusLine and removes the wrapper', async () => {
    const original = {
      type: 'command',
      command: 'node C:\\tools\\my-status.js',
      padding: 4,
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: original, unrelated: 'kept' }),
      'utf8',
    );

    const enableDeps = baseDeps({
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
    });
    await enableClaudeIntegration(enableDeps);
    const afterEnable = await readSettings(realFs(), settingsPath);
    const wrapperPath = (
      afterEnable.parsed.statusLine as Record<string, unknown> as { command: string }
    ).command;
    expect(wrapperPath).not.toContain('my-status.js');

    const disableDeps = baseDeps({
      globalState: enableDeps.globalState,
      secrets: enableDeps.secrets,
    });
    const outcome = await disableClaudeIntegration(disableDeps);
    expect(outcome).toEqual({ kind: 'disabled' });

    const after = await readSettings(realFs(), settingsPath);
    expect(after.parsed.statusLine).toEqual(original);
    expect(after.parsed.unrelated).toBe('kept');
    expect(isEnabled(disableDeps.globalState)).toBe(false);
    expect(disableDeps.globalState.get('aiLimitLedger.claudeExplicitlyDisabled', false)).toBe(true);
  });

  it('only restores statusLine — unrelated settings keys are untouched', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: 'command', command: 'x' },
        permissions: { allow: ['Bash'] },
      }),
      'utf8',
    );
    const enableDeps = baseDeps();
    await enableClaudeIntegration(enableDeps);
    const disableDeps = baseDeps({
      globalState: enableDeps.globalState,
      secrets: enableDeps.secrets,
    });
    await disableClaudeIntegration(disableDeps);
    const after = await readSettings(realFs(), settingsPath);
    expect(after.parsed.permissions).toEqual({ allow: ['Bash'] });
  });

  it('removes the statusLine key entirely when there was no original (fresh standalone install)', async () => {
    const enableDeps = baseDeps();
    await enableClaudeIntegration(enableDeps);
    const afterEnable = await readSettings(realFs(), settingsPath);
    expect(afterEnable.parsed.statusLine).toBeDefined();

    const disableDeps = baseDeps({
      globalState: enableDeps.globalState,
      secrets: enableDeps.secrets,
    });
    const outcome = await disableClaudeIntegration(disableDeps);
    expect(outcome).toEqual({ kind: 'disabled' });

    const after = await readSettings(realFs(), settingsPath);
    expect(after.parsed.statusLine).toBeUndefined();
    expect(isEnabled(disableDeps.globalState)).toBe(false);
  });

  it('refuses to overwrite when the statusLine changed externally after enable', async () => {
    const enableDeps = baseDeps();
    await enableClaudeIntegration(enableDeps);

    const current = await readSettings(realFs(), settingsPath);
    (current.parsed.statusLine as Record<string, unknown>).command = 'something-else-now';
    await fs.writeFile(settingsPath, JSON.stringify(current.parsed), 'utf8');

    const disableDeps = baseDeps({
      globalState: enableDeps.globalState,
      secrets: enableDeps.secrets,
    });
    const outcome = await disableClaudeIntegration(disableDeps);
    expect(outcome.kind).toBe('conflict');
    const after = await readSettings(realFs(), settingsPath);
    expect((after.parsed.statusLine as Record<string, unknown>).command).toBe('something-else-now');
  });
});
