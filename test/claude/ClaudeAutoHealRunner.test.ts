import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetAutoHealRunnerStateForTests,
  runAutoHeal,
  type AutoHealDeps,
} from '../../src/providers/claude/ClaudeAutoHealRunner';
import {
  standaloneScriptPathFor,
  standaloneWrapperExpectedContent,
} from '../../src/providers/claude/ClaudeIntegrationTransaction';
import {
  loadAutoHealAttempt,
  loadOwnership,
  saveConsent,
  saveOwnership,
  setEnabled,
  setExplicitlyDisabled,
  CONSENT_VERSION,
} from '../../src/providers/claude/ClaudeRecoveryStore';
import { readSettings } from '../../src/providers/claude/ClaudeSettingsFile';
import { CURRENT_WRAPPER_VERSION } from '../../src/providers/claude/types';
import type { RunResult } from '../../src/providers/claude/ClaudeWrapperRunner';
import { fakeGlobalState, fakeSecrets, makeTempDir, realFs } from './fixtures';

const OK: RunResult = { stdout: 'ok', exitCode: 0, timedOut: false };
const FAIL: RunResult = { stdout: '', exitCode: null, timedOut: true };

describe('runAutoHeal', () => {
  let dir: string;
  let settingsPath: string;
  let globalStorageDir: string;
  let snapshotPath: string;
  let notifications: string[];
  let changed: number;

  function baseDeps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
    notifications = [];
    changed = 0;
    return {
      fs: realFs(),
      clock: () => new Date('2026-08-24T00:00:00.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      snapshotPath,
      globalStorageDir,
      runWrapper: async () => OK,
      hostKind: 'standalone-cli',
      refreshIntervalSeconds: 15,
      autoRepairEnabled: true,
      platformSupported: true,
      snapshotStaleAfterSeconds: 86_400,
      concurrentChangeDetected: false,
      onIntegrationChanged: () => {
        changed += 1;
      },
      notify: (message) => notifications.push(message),
      ...overrides,
    };
  }

  async function grantConsent(globalState: ReturnType<typeof fakeGlobalState>): Promise<void> {
    await saveConsent(globalState, {
      consentVersion: CONSENT_VERSION,
      consentTimestamp: '2026-08-01T00:00:00.000Z',
      integrationMode: 'standalone',
      expectedWrapperVersion: CURRENT_WRAPPER_VERSION,
    });
  }

  async function installHealthyStandalone(
    deps: AutoHealDeps,
  ): Promise<{ wrapperPath: string; command: string }> {
    const wrapperPath = standaloneScriptPathFor(deps.globalStorageDir, deps.platform);
    const content = standaloneWrapperExpectedContent(deps.platform, deps.snapshotPath);
    await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
    await fs.writeFile(wrapperPath, content, 'utf8');
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${wrapperPath}"`;
    await fs.writeFile(
      deps.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command, refreshInterval: 15 } }, null, 2),
      'utf8',
    );
    await saveOwnership(deps.globalState, {
      schemaVersion: 2,
      mode: 'standalone',
      wrapperPath,
      wrapperVersion: CURRENT_WRAPPER_VERSION,
      originalStatusLineHash: null,
      enabledAt: '2026-08-01T00:00:00.000Z',
      ownerMarker: 'ai-limit-ledger',
    });
    await setEnabled(deps.globalState, true);
    return { wrapperPath, command };
  }

  beforeEach(async () => {
    dir = await makeTempDir('ai-limit-ledger-autoheal-');
    settingsPath = path.join(dir, 'settings.json');
    globalStorageDir = path.join(dir, 'global-storage');
    snapshotPath = path.join(dir, 'snapshot.json');
    resetAutoHealRunnerStateForTests();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does nothing when no consent has ever been granted', async () => {
    const deps = baseDeps();
    await setEnabled(deps.globalState, true);
    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('consent-missing');
    expect(result.ran).toBe(false);
    expect(changed).toBe(0);
  });

  it('does nothing when Claude Code integration is disabled', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    // setEnabled left false — integration was never turned on.
    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('integration-disabled');
    expect(result.ran).toBe(false);
  });

  it('does nothing when autoRepair is disabled, even with consent and enabled integration', async () => {
    const deps = baseDeps({ autoRepairEnabled: false });
    await grantConsent(deps.globalState);
    await installHealthyStandalone(deps);
    await fs.unlink(standaloneScriptPathFor(deps.globalStorageDir, deps.platform));
    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('wrapper-missing');
    expect(result.assessment.autoRepairable).toBe(false);
    expect(result.ran).toBe(false);
  });

  it('reinstalls a missing wrapper automatically', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    const { wrapperPath } = await installHealthyStandalone(deps);
    await fs.unlink(wrapperPath);

    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('wrapper-missing');
    expect(result.outcome?.kind).toBe('enabled');
    const restored = await fs.readFile(wrapperPath, 'utf8').catch(() => null);
    expect(restored).not.toBeNull();
    expect(changed).toBe(1);
    expect(notifications).toHaveLength(1);
  });

  it('upgrades an outdated (hash-mismatched) wrapper automatically', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    const { wrapperPath } = await installHealthyStandalone(deps);
    await fs.writeFile(wrapperPath, '# stale wrapper content, schemaVersion 1 only', 'utf8');

    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('wrapper-outdated');
    expect(result.outcome?.kind).toBe('enabled');
    const content = await fs.readFile(wrapperPath, 'utf8');
    expect(content).toContain('schemaVersion');
    expect(content).not.toBe('# stale wrapper content, schemaVersion 1 only');
  });

  it('leaves the wrapper untouched when validation/self-check fails', async () => {
    const deps = baseDeps({ runWrapper: async () => FAIL });
    await grantConsent(deps.globalState);
    const { wrapperPath } = await installHealthyStandalone(deps);
    await fs.writeFile(wrapperPath, '# stale wrapper content', 'utf8');

    const result = await runAutoHeal(deps);
    expect(result.outcome?.kind).toBe('error');
    const content = await fs.readFile(wrapperPath, 'utf8');
    expect(content).toBe('# stale wrapper content');
  });

  it('reinstalls a completely missing owned statusLine', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    await installHealthyStandalone(deps);
    await fs.writeFile(deps.settingsPath, JSON.stringify({ other: 'kept' }, null, 2), 'utf8');

    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('statusline-missing');
    expect(result.outcome?.kind).toBe('enabled');
    const settings = await readSettings(realFs(), deps.settingsPath);
    expect(settings.parsed.other).toBe('kept');
    expect(settings.parsed.statusLine).toBeDefined();
  });

  it('never touches a foreign (unowned) statusLine', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    await setEnabled(deps.globalState, true);
    await fs.writeFile(
      deps.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node other-tool.js' } }, null, 2),
      'utf8',
    );

    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('external-statusline');
    expect(result.ran).toBe(false);
    const settings = await readSettings(realFs(), deps.settingsPath);
    expect((settings.parsed.statusLine as Record<string, unknown>).command).toBe(
      'node other-tool.js',
    );
  });

  it('preserves unrelated settings fields when repairing', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    await installHealthyStandalone(deps);
    const { wrapperPath } = await installHealthyStandalone(deps);
    const current = await readSettings(realFs(), deps.settingsPath);
    await fs.writeFile(
      deps.settingsPath,
      JSON.stringify({ ...current.parsed, unrelatedTool: { keep: true } }, null, 2),
      'utf8',
    );
    await fs.unlink(wrapperPath);

    await runAutoHeal(deps);
    const settings = await readSettings(realFs(), deps.settingsPath);
    expect(settings.parsed.unrelatedTool).toEqual({ keep: true });
  });

  it('safely fixes a stale refreshInterval, preserving other statusLine fields', async () => {
    const deps = baseDeps({ refreshIntervalSeconds: 45 });
    await grantConsent(deps.globalState);
    await installHealthyStandalone(deps);
    const current = await readSettings(realFs(), deps.settingsPath);
    const statusLine = current.parsed.statusLine as Record<string, unknown>;
    await fs.writeFile(
      deps.settingsPath,
      JSON.stringify({ statusLine: { ...statusLine, refreshInterval: 15, padding: 2 } }, null, 2),
      'utf8',
    );

    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('refresh-interval-mismatch');
    expect(result.outcome?.kind).toBe('enabled');
    const settings = await readSettings(realFs(), deps.settingsPath);
    const next = settings.parsed.statusLine as Record<string, unknown>;
    expect(next.refreshInterval).toBe(45);
    expect(next.padding).toBe(2);
    expect(next.command).toBe(statusLine.command);
  });

  it('stops retrying after three failed attempts for the same reason', async () => {
    const deps = baseDeps({
      runWrapper: async () => FAIL,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    await grantConsent(deps.globalState);
    const { wrapperPath } = await installHealthyStandalone(deps);
    await fs.writeFile(wrapperPath, '# stale', 'utf8');

    await runAutoHeal(deps);
    await runAutoHeal(deps);
    const third = await runAutoHeal(deps);
    expect(third.ran).toBe(true);
    const fourth = await runAutoHeal(deps);
    expect(fourth.ran).toBe(false);
    const attempt = loadAutoHealAttempt(deps.globalState);
    expect(attempt?.attemptCount).toBe(3);
  });

  it('re-verifies to healthy after a successful repair, so a watcher re-fire is a no-op', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    const { wrapperPath } = await installHealthyStandalone(deps);
    await fs.unlink(wrapperPath);

    const first = await runAutoHeal(deps);
    expect(first.outcome?.kind).toBe('enabled');
    const second = await runAutoHeal(deps);
    expect(second.assessment.state).toBe('healthy');
    expect(second.ran).toBe(false);
    expect(notifications).toHaveLength(1);
  });

  it('does nothing once the integration has been explicitly disabled', async () => {
    const deps = baseDeps();
    await grantConsent(deps.globalState);
    await installHealthyStandalone(deps);
    await setEnabled(deps.globalState, false);
    await setExplicitlyDisabled(deps.globalState, true);

    const result = await runAutoHeal(deps);
    expect(result.assessment.state).toBe('integration-disabled');
    expect(result.ran).toBe(false);
    expect(loadOwnership(deps.globalState)).toBeDefined();
  });
});
