import { describe, expect, it } from 'vitest';
import {
  computeClaudeState,
  EXTENSION_ONLY_GRACE_MS,
  RESTART_GRACE_MS,
  WAITING_TIMEOUT_MS,
  type ClaudeStateInputs,
} from '../../src/providers/claude/ClaudeStateMachine';

const cliBase: ClaudeStateInputs = {
  cliFound: true,
  cliVersionCompatible: true,
  enabled: true,
  ownedEffective: true,
  effectiveStatusLinePresent: true,
  shadowedByProject: false,
  wrapperExists: true,
  hasValidSnapshot: false,
  snapshotStale: false,
  awaitingSessionRestart: false,
  msSinceEnabled: RESTART_GRACE_MS + 1000,
  hostKind: 'standalone-cli',
  accessMode: 'standalone-cli',
};

const extBase: ClaudeStateInputs = {
  ...cliBase,
  hostKind: 'vscode-sidebar',
  accessMode: 'vscode-extension',
};

describe('computeClaudeState (CLI-capable host: standalone-cli/hybrid — unchanged 0.3.4 behavior)', () => {
  it('is unavailable when access mode is unavailable, before any other check', () => {
    expect(
      computeClaudeState({
        ...cliBase,
        cliFound: false,
        accessMode: 'unavailable',
        hostKind: 'unknown',
      }).availability,
    ).toBe('unavailable');
  });

  it('is incompatible-cli only when compatibility is known false, never on unknown', () => {
    expect(computeClaudeState({ ...cliBase, cliVersionCompatible: false }).availability).toBe(
      'incompatible-cli',
    );
    expect(computeClaudeState({ ...cliBase, cliVersionCompatible: null }).availability).not.toBe(
      'incompatible-cli',
    );
  });

  it('is external-change when enabled but the effective statusLine no longer targets our wrapper', () => {
    expect(computeClaudeState({ ...cliBase, ownedEffective: false }).availability).toBe(
      'external-change',
    );
  });

  it('is configuration-shadowed when a project-level statusLine outranks ours', () => {
    expect(computeClaudeState({ ...cliBase, shadowedByProject: true }).availability).toBe(
      'configuration-shadowed',
    );
  });

  it('is repair-required when the effective config targets our wrapper but the file is missing or stale', () => {
    expect(computeClaudeState({ ...cliBase, wrapperExists: false }).availability).toBe(
      'repair-required',
    );
  });

  it('is repair-required (not external-change) when enabled but no statusLine exists at any scope', () => {
    expect(
      computeClaudeState({
        ...cliBase,
        ownedEffective: false,
        effectiveStatusLinePresent: false,
      }).availability,
    ).toBe('repair-required');
  });

  it('is restart-required immediately after enable, before the grace period elapses', () => {
    expect(computeClaudeState({ ...cliBase, msSinceEnabled: 1000 }).availability).toBe(
      'restart-required',
    );
  });

  it('is waiting-for-first-response once the grace period has passed, with automatic-checking capability', () => {
    const state = computeClaudeState(cliBase);
    expect(state.availability).toBe('waiting-for-first-response');
    expect(state.capability).toBe('automatic-checking');
  });

  it('is ready/automatic-live once a valid snapshot exists', () => {
    expect(computeClaudeState({ ...cliBase, hasValidSnapshot: true })).toEqual({
      availability: 'ready',
      capability: 'automatic-live',
    });
  });

  it('is stale/automatic-checking when the snapshot is valid but old', () => {
    expect(computeClaudeState({ ...cliBase, hasValidSnapshot: true, snapshotStale: true })).toEqual(
      {
        availability: 'stale',
        capability: 'automatic-checking',
      },
    );
  });

  it('escalates to upstream-statusline-not-invoked (manual-only capability) once the full timeout elapses', () => {
    expect(computeClaudeState({ ...cliBase, msSinceEnabled: WAITING_TIMEOUT_MS + 1000 })).toEqual({
      availability: 'upstream-statusline-not-invoked',
      capability: 'manual-only',
    });
  });

  it('a real snapshot arriving after the timeout still reports ready, not the diagnostic state', () => {
    expect(
      computeClaudeState({
        ...cliBase,
        msSinceEnabled: WAITING_TIMEOUT_MS + 1000,
        hasValidSnapshot: true,
      }).availability,
    ).toBe('ready');
  });
});

describe('computeClaudeState (extension-only host, 0.3.5 core fix)', () => {
  it('is manual-only (not integration-required) when automatic tracking was never enabled', () => {
    expect(computeClaudeState({ ...extBase, enabled: false })).toEqual({
      availability: 'manual-only',
      capability: 'manual-only',
    });
  });

  it('distinguishes an explicit Disable from a host that never opted into tracking', () => {
    expect(
      computeClaudeState({ ...extBase, enabled: false, explicitlyDisabled: true }).availability,
    ).toBe('integration-disabled');
  });

  it('is connected/available, never unavailable or unsupported, purely because the CLI is absent', () => {
    const state = computeClaudeState({ ...extBase, enabled: false });
    expect(state.availability).not.toBe('unavailable');
    expect(state.availability).not.toBe('unsupported-surface');
    expect(state.availability).not.toBe('integration-required');
  });

  it('shows a short restart-required/checking window right after opting in', () => {
    expect(computeClaudeState({ ...extBase, msSinceEnabled: 1000 }).availability).toBe(
      'restart-required',
    );
  });

  it('never waits 15 minutes: falls back to manual-only shortly after the short extension-only grace period, well before WAITING_TIMEOUT_MS', () => {
    expect(EXTENSION_ONLY_GRACE_MS).toBeLessThan(WAITING_TIMEOUT_MS);
    const state = computeClaudeState({
      ...extBase,
      msSinceEnabled: EXTENSION_ONLY_GRACE_MS + 1000,
    });
    expect(state).toEqual({ availability: 'manual-only', capability: 'manual-only' });
  });

  it('does not instruct the user to keep completing responses (no waiting-for-first-response) in extension-only mode', () => {
    const state = computeClaudeState({
      ...extBase,
      msSinceEnabled: EXTENSION_ONLY_GRACE_MS + 1000,
    });
    expect(state.availability).not.toBe('waiting-for-first-response');
  });

  it('a later valid snapshot promotes extension-only mode straight to ready/automatic-live', () => {
    expect(
      computeClaudeState({
        ...extBase,
        msSinceEnabled: EXTENSION_ONLY_GRACE_MS + 1000,
        hasValidSnapshot: true,
      }),
    ).toEqual({ availability: 'ready', capability: 'automatic-live' });
  });

  it('still reports real, fixable configuration problems (shadowing/external-change/missing wrapper) distinctly, not folded into manual-only', () => {
    expect(computeClaudeState({ ...extBase, shadowedByProject: true }).availability).toBe(
      'configuration-shadowed',
    );
    expect(computeClaudeState({ ...extBase, ownedEffective: false }).availability).toBe(
      'external-change',
    );
    expect(
      computeClaudeState({
        ...extBase,
        ownedEffective: false,
        effectiveStatusLinePresent: false,
      }).availability,
    ).toBe('repair-required');
    expect(computeClaudeState({ ...extBase, wrapperExists: false }).availability).toBe(
      'repair-required',
    );
  });
});
