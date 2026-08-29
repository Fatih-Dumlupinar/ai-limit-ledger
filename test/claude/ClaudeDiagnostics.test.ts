import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diagnoseClaudeIntegration,
  formatDiagnosticsReport,
} from '../../src/providers/claude/ClaudeDiagnostics';
import {
  enableClaudeIntegration,
  type ClaudeIntegrationDeps,
} from '../../src/providers/claude/ClaudeIntegrationTransaction';
import { loadOwnership } from '../../src/providers/claude/ClaudeRecoveryStore';
import type { RunResult } from '../../src/providers/claude/ClaudeWrapperRunner';
import { fakeConfirm, fakeGlobalState, fakeSecrets, makeTempDir, realFs } from './fixtures';

const OK: RunResult = { stdout: 'ok', exitCode: 0, timedOut: false };

describe('diagnoseClaudeIntegration', () => {
  let dir: string;
  let settingsPath: string;
  let globalStorageDir: string;
  let snapshotPath: string;

  beforeEach(async () => {
    dir = await makeTempDir('ai-limit-ledger-diag-');
    settingsPath = path.join(dir, 'settings.json');
    globalStorageDir = path.join(dir, 'global-storage');
    snapshotPath = path.join(dir, 'snapshot.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports disabled/absent state cleanly with no CLI found', async () => {
    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date(),
      platform: 'win32',
      cliAvailable: () => false,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      snapshotPath,
      globalStorageDir,
      hostKind: 'standalone-cli',
    });
    expect(report.claudeCliFound).toBe(false);
    expect(report.integrationMode).toBe('disabled');
    expect(report.wrapperPresent).toBe(false);
    expect(report.snapshotPresent).toBe(false);
  });

  it('reports a healthy chained integration', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node x.js' } }),
      'utf8',
    );
    const enableDeps: ClaudeIntegrationDeps = {
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
      platform: 'win32',
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
      runWrapper: async () => OK,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      globalStorageDir,
      snapshotPath,
      onIntegrationChanged: () => undefined,
    };
    await enableClaudeIntegration(enableDeps);
    await fs.writeFile(
      snapshotPath,
      JSON.stringify({ schemaVersion: 1, observedAt: '2026-08-23T00:00:00.000Z' }),
      'utf8',
    );

    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:01:00.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      hostKind: 'standalone-cli',
    });
    expect(report.integrationMode).toBe('chained');
    expect(report.wrapperPresent).toBe(true);
    expect(report.settingsOwnershipOk).toBe(true);
    expect(report.recoveryMetadataPresent).toBe(true);
    expect(report.snapshotPresent).toBe(true);
    expect(report.snapshotAgeSeconds).toBe(60);
    expect(report.restorePossible).toBe(true);
    expect(report.chainingSupportedOnPlatform).toBe(true);
  });

  it('detects project-level shadowing of the user-level entry AI Limit Ledger manages', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node x.js' } }),
      'utf8',
    );
    const enableDeps: ClaudeIntegrationDeps = {
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
      platform: 'win32',
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
      runWrapper: async () => OK,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      globalStorageDir,
      snapshotPath,
      onIntegrationChanged: () => undefined,
    };
    await enableClaudeIntegration(enableDeps);

    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date(),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      projectSharedStatusLine: { type: 'command', command: 'node someone-elses-tool.js' },
      hostKind: 'standalone-cli',
    });
    expect(report.winningStatusLineScope).toBe('project-shared');
    expect(report.shadowedByHigherPrecedence).toBe(true);
    expect(report.recommendedNextAction).toMatch(/project-level/i);
  });

  it('classifies as upstream-statusline-not-invoked only once the wrapper self-check passes, config is confirmed effective, and the wait timeout has elapsed with no snapshot', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node x.js' } }),
      'utf8',
    );
    const enableDeps: ClaudeIntegrationDeps = {
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
      platform: 'win32',
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
      runWrapper: async () => OK,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      globalStorageDir,
      snapshotPath,
      onIntegrationChanged: () => undefined,
    };
    await enableClaudeIntegration(enableDeps);

    // Before the wait timeout elapses, even with a healthy self-check and no snapshot, the
    // report must not yet claim upstream is at fault.
    const early = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:05:00.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      runWrapper: async () => OK,
      hostKind: 'standalone-cli',
    });
    expect(early.upstreamStatusLineNotInvoked).toBe(false);

    // After the timeout, with the same healthy self-check and still no snapshot, it should.
    const late = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date('2026-08-23T01:00:00.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      runWrapper: async () => OK,
      hostKind: 'standalone-cli',
    });
    expect(late.wrapperSelfCheck).toBe('passed');
    expect(late.upstreamStatusLineNotInvoked).toBe(true);
    expect(late.recommendedNextAction).toMatch(/do not reconfigure/i);
  });

  it('recommends the sidebar-specific message when there is no standalone CLI', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node x.js' } }),
      'utf8',
    );
    const enableDeps: ClaudeIntegrationDeps = {
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
      platform: 'win32',
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
      runWrapper: async () => OK,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      globalStorageDir,
      snapshotPath,
      onIntegrationChanged: () => undefined,
    };
    await enableClaudeIntegration(enableDeps);

    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date('2026-08-23T01:00:00.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      runWrapper: async () => OK,
      hostKind: 'vscode-sidebar',
    });
    expect(report.upstreamStatusLineNotInvoked).toBe(true);
    expect(report.recommendedNextAction).toMatch(/standalone Claude Code CLI/i);
  });

  it('reports a real successful snapshot and does not claim upstream is at fault', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node x.js' } }),
      'utf8',
    );
    const enableDeps: ClaudeIntegrationDeps = {
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
      platform: 'win32',
      confirm: fakeConfirm({ chooseExistingStatusLineAction: async () => 'preserve' }),
      runWrapper: async () => OK,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState(),
      settingsPath,
      globalStorageDir,
      snapshotPath,
      onIntegrationChanged: () => undefined,
    };
    await enableClaudeIntegration(enableDeps);
    await fs.writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        observedAt: '2026-08-23T01:00:00.000Z',
        rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_800_000_000 } },
      }),
      'utf8',
    );

    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date('2026-08-23T01:00:05.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      runWrapper: async () => OK,
      hostKind: 'standalone-cli',
    });
    expect(report.snapshotPresent).toBe(true);
    expect(report.upstreamStatusLineNotInvoked).toBe(false);
    expect(report.fiveHourFieldsPresent).toBe(true);
  });

  it('reports repair-required with statusline-missing and wrapper-outdated for the real-world regression', async () => {
    const enableDeps: ClaudeIntegrationDeps = {
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
    };
    await enableClaudeIntegration(enableDeps);
    const ownership = loadOwnership(enableDeps.globalState);

    // Reproduces the confirmed regression: a prior, now-stale wrapper survives on disk, but the
    // effective statusLine key has since been dropped from settings.json entirely (e.g. by an
    // external rewrite), even though AI Limit Ledger still believes it is enabled.
    await fs.writeFile(ownership!.wrapperPath!, '# stale wrapper from an older version', 'utf8');
    await fs.writeFile(settingsPath, JSON.stringify({}), 'utf8');

    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date('2026-08-23T01:00:00.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      hostKind: 'standalone-cli',
    });

    expect(report.effectiveStatusLinePresent).toBe(false);
    expect(report.wrapperPresent).toBe(true);
    expect(report.wrapperHashMatches).toBe(false);
    expect(report.integrationHealth).toBe('repair-required');
    expect(report.repairReasons).toContain('statusline-missing');
    expect(report.repairReasons).toContain('wrapper-outdated');
    expect(report.recommendedNextAction).toMatch(/Enable Claude Code Integration/);

    const text = formatDiagnosticsReport(report, 'C:\\Users\\anyone');
    expect(text).toContain('Integration state: repair-required');
    expect(text).toContain('statusline-missing');
    expect(text).toContain('wrapper-outdated');
  });

  it('reports ready with no repair reasons for a freshly enabled, healthy standalone integration', async () => {
    const enableDeps: ClaudeIntegrationDeps = {
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
    };
    await enableClaudeIntegration(enableDeps);

    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date('2026-08-23T00:00:10.000Z'),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: enableDeps.secrets,
      globalState: enableDeps.globalState,
      settingsPath,
      snapshotPath,
      globalStorageDir,
      hostKind: 'standalone-cli',
    });

    expect(report.effectiveStatusLinePresent).toBe(true);
    expect(report.wrapperHashMatches).toBe(true);
    expect(report.integrationHealth).toBe('ready');
    expect(report.repairReasons).toEqual([]);
  });

  it('never includes command text, raw JSON, or the full user home directory in the formatted report', async () => {
    const home = 'C:\\Users\\secretuser';
    const report = await diagnoseClaudeIntegration({
      fs: realFs(),
      clock: () => new Date(),
      platform: 'win32',
      cliAvailable: () => true,
      secrets: fakeSecrets(),
      globalState: fakeGlobalState({
        'aiLimitLedger.claude.lastError': `Could not update ${home}\\.claude\\settings.json`,
      }),
      settingsPath,
      snapshotPath,
      globalStorageDir,
      hostKind: 'standalone-cli',
    });
    const text = formatDiagnosticsReport(report, home);
    expect(text).not.toContain(home);
    expect(text).toContain('%USERPROFILE%');
    expect(text).not.toContain('powershell');
    expect(text).not.toMatch(/"version"\s*:/);
  });
});
