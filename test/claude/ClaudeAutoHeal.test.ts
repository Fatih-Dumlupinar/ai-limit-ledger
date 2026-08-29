import { describe, expect, it } from 'vitest';
import {
  classifyAutoHealth,
  type AutoHealContext,
} from '../../src/providers/claude/ClaudeAutoHeal';
import type { DiagnosticsReport } from '../../src/providers/claude/types';

function baseReport(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    claudeCliFound: true,
    integrationMode: 'standalone',
    wrapperPresent: true,
    wrapperVersion: 2,
    wrapperHashMatches: true,
    settingsOwnershipOk: true,
    effectiveStatusLinePresent: true,
    integrationHealth: 'ready',
    repairReasons: [],
    recoveryMetadataPresent: true,
    snapshotPresent: true,
    snapshotSchemaVersion: 1,
    snapshotAgeSeconds: 10,
    lastSafeBridgeError: null,
    restorePossible: true,
    chainingSupportedOnPlatform: true,
    resolvedConfigDir: 'C:/fake',
    winningStatusLineScope: 'user',
    shadowedByHigherPrecedence: false,
    wrapperSelfCheck: 'passed',
    fiveHourFieldsPresent: true,
    sevenDayFieldsPresent: true,
    effectiveRefreshInterval: 15,
    sourceUpdatedAt: null,
    fiveHourRawPercentage: null,
    sevenDayRawPercentage: null,
    contextRawPercentage: null,
    lastWrapperErrorCategory: 'none',
    recommendedNextAction: 'No action needed.',
    hostKind: 'standalone-cli',
    msSinceEnabled: 100_000,
    upstreamStatusLineNotInvoked: false,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<AutoHealContext> = {}): AutoHealContext {
  return {
    claudeEnabled: true,
    consentPresent: true,
    autoRepairEnabled: true,
    platformSupported: true,
    configuredRefreshIntervalSeconds: 15,
    snapshotStaleAfterSeconds: 86_400,
    concurrentChangeDetected: false,
    ...overrides,
  };
}

describe('classifyAutoHealth', () => {
  it('reports healthy when everything checks out', () => {
    const result = classifyAutoHealth(baseReport(), baseCtx());
    expect(result.state).toBe('healthy');
    expect(result.autoRepairable).toBe(false);
    expect(result.requiresUserAction).toBe(false);
  });

  it('reports unsupported-platform and never autoRepairable', () => {
    const result = classifyAutoHealth(baseReport(), baseCtx({ platformSupported: false }));
    expect(result.state).toBe('unsupported-platform');
    expect(result.autoRepairable).toBe(false);
    expect(result.requiresUserAction).toBe(true);
  });

  it('reports integration-disabled and never autoRepairable', () => {
    const result = classifyAutoHealth(
      baseReport({ integrationMode: 'disabled' }),
      baseCtx({ claudeEnabled: false }),
    );
    expect(result.state).toBe('integration-disabled');
    expect(result.autoRepairable).toBe(false);
    expect(result.requiresUserAction).toBe(false);
  });

  it('reports consent-missing and requires user action', () => {
    const result = classifyAutoHealth(baseReport(), baseCtx({ consentPresent: false }));
    expect(result.state).toBe('consent-missing');
    expect(result.autoRepairable).toBe(false);
    expect(result.requiresUserAction).toBe(true);
  });

  it('reports concurrent-change from a fresh external-change repair reason', () => {
    const result = classifyAutoHealth(
      baseReport({ repairReasons: ['external-change'] }),
      baseCtx(),
    );
    expect(result.state).toBe('concurrent-change');
    expect(result.autoRepairable).toBe(false);
  });

  it('reports concurrent-change from a watcher-observed concurrent change', () => {
    const result = classifyAutoHealth(baseReport(), baseCtx({ concurrentChangeDetected: true }));
    expect(result.state).toBe('concurrent-change');
    expect(result.autoRepairable).toBe(false);
  });

  it('reports configuration-shadowed and never autoRepairable', () => {
    const result = classifyAutoHealth(baseReport({ shadowedByHigherPrecedence: true }), baseCtx());
    expect(result.state).toBe('configuration-shadowed');
    expect(result.autoRepairable).toBe(false);
  });

  it('reports external-statusline and never autoRepairable', () => {
    const result = classifyAutoHealth(
      baseReport({ settingsOwnershipOk: false, effectiveStatusLinePresent: true }),
      baseCtx(),
    );
    expect(result.state).toBe('external-statusline');
    expect(result.autoRepairable).toBe(false);
  });

  it('reports wrapper-corrupt when present but self-check failed, and is autoRepairable', () => {
    const result = classifyAutoHealth(baseReport({ wrapperSelfCheck: 'failed' }), baseCtx());
    expect(result.state).toBe('wrapper-corrupt');
    expect(result.autoRepairable).toBe(true);
  });

  it('reports wrapper-missing and is autoRepairable', () => {
    const result = classifyAutoHealth(
      baseReport({ wrapperPresent: false, repairReasons: ['wrapper-missing'] }),
      baseCtx(),
    );
    expect(result.state).toBe('wrapper-missing');
    expect(result.autoRepairable).toBe(true);
  });

  it('wrapper-missing is not autoRepairable when consent is absent', () => {
    const result = classifyAutoHealth(
      baseReport({ wrapperPresent: false, repairReasons: ['wrapper-missing'] }),
      baseCtx({ consentPresent: false }),
    );
    expect(result.state).toBe('consent-missing');
    expect(result.autoRepairable).toBe(false);
  });

  it('reports wrapper-outdated and is autoRepairable', () => {
    const result = classifyAutoHealth(baseReport({ wrapperHashMatches: false }), baseCtx());
    expect(result.state).toBe('wrapper-outdated');
    expect(result.autoRepairable).toBe(true);
  });

  it('wrapper-outdated is not autoRepairable when autoRepair is disabled', () => {
    const result = classifyAutoHealth(
      baseReport({ wrapperHashMatches: false }),
      baseCtx({ autoRepairEnabled: false }),
    );
    expect(result.state).toBe('wrapper-outdated');
    expect(result.autoRepairable).toBe(false);
    expect(result.requiresUserAction).toBe(true);
  });

  it('reports statusline-missing and is autoRepairable', () => {
    const result = classifyAutoHealth(
      baseReport({ effectiveStatusLinePresent: false, settingsOwnershipOk: null }),
      baseCtx(),
    );
    expect(result.state).toBe('statusline-missing');
    expect(result.autoRepairable).toBe(true);
  });

  it('reports refresh-interval-mismatch and is autoRepairable', () => {
    const result = classifyAutoHealth(
      baseReport({ effectiveRefreshInterval: 30 }),
      baseCtx({ configuredRefreshIntervalSeconds: 15 }),
    );
    expect(result.state).toBe('refresh-interval-mismatch');
    expect(result.autoRepairable).toBe(true);
  });

  it('reports snapshot-stale as informational only, never autoRepairable', () => {
    const result = classifyAutoHealth(
      baseReport({ snapshotAgeSeconds: 999_999 }),
      baseCtx({ snapshotStaleAfterSeconds: 86_400 }),
    );
    expect(result.state).toBe('snapshot-stale');
    expect(result.autoRepairable).toBe(false);
    expect(result.requiresUserAction).toBe(false);
  });

  it('reports recovery-unavailable for a missing chained wrapper with no recovery metadata', () => {
    const result = classifyAutoHealth(
      baseReport({
        integrationMode: 'chained',
        wrapperPresent: false,
        repairReasons: ['wrapper-missing'],
        recoveryMetadataPresent: false,
      }),
      baseCtx(),
    );
    expect(result.state).toBe('recovery-unavailable');
    expect(result.autoRepairable).toBe(false);
    expect(result.requiresUserAction).toBe(true);
  });

  it('still auto-repairs a missing chained wrapper when recovery metadata is present', () => {
    const result = classifyAutoHealth(
      baseReport({
        integrationMode: 'chained',
        wrapperPresent: false,
        repairReasons: ['wrapper-missing'],
        recoveryMetadataPresent: true,
      }),
      baseCtx(),
    );
    expect(result.state).toBe('wrapper-missing');
    expect(result.autoRepairable).toBe(true);
  });
});
