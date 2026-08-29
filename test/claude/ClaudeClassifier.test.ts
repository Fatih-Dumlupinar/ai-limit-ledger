import { describe, expect, it } from 'vitest';
import { computeClassification } from '../../src/providers/claude/ClaudeClassifier';

const chainedPath = 'C:/storage/claude-bridge-chained.ps1';
const standalonePath = 'C:/storage/claude-bridge.ps1';
const ourUserStatusLine = { type: 'command', command: `powershell -File "${standalonePath}"` };

const baseInputs = {
  userStatusLine: ourUserStatusLine,
  projectSharedStatusLine: undefined,
  projectLocalStatusLine: undefined,
  ownershipWrapperPath: standalonePath,
  chainedPath,
  standalonePath,
  wrapperFileExists: true,
  cliVersionCompatible: true as boolean | null,
  awaitingSessionRestart: false,
  enabledAt: '2026-08-23T00:00:00.000Z',
  now: Date.parse('2026-08-23T00:05:00.000Z'),
  hostKind: 'standalone-cli' as const,
};

describe('computeClassification', () => {
  it('is owned and not shadowed when only the user-level entry exists and targets our wrapper', () => {
    const result = computeClassification(baseInputs);
    expect(result.ownedEffective).toBe(true);
    expect(result.shadowedByProject).toBe(false);
  });

  it('project-local statusLine shadows the user statusLine we manage', () => {
    const result = computeClassification({
      ...baseInputs,
      projectLocalStatusLine: { type: 'command', command: 'node other-tool.js' },
    });
    expect(result.ownedEffective).toBe(false);
    expect(result.shadowedByProject).toBe(true);
  });

  it('project-shared statusLine shadows the user statusLine we manage', () => {
    const result = computeClassification({
      ...baseInputs,
      projectSharedStatusLine: { type: 'command', command: 'node other-tool.js' },
    });
    expect(result.ownedEffective).toBe(false);
    expect(result.shadowedByProject).toBe(true);
  });

  it('is not "shadowed" when the winning project statusLine also happens to target our wrapper', () => {
    const result = computeClassification({
      ...baseInputs,
      projectSharedStatusLine: { type: 'command', command: `powershell -File "${standalonePath}"` },
    });
    expect(result.ownedEffective).toBe(true);
    expect(result.shadowedByProject).toBe(false);
  });

  it('computes msSinceEnabled from enabledAt and passes hostKind through unchanged', () => {
    const result = computeClassification(baseInputs);
    expect(result.msSinceEnabled).toBe(5 * 60_000);
    expect(result.hostKind).toBe('standalone-cli');
  });

  it('msSinceEnabled is null when enabledAt is unknown', () => {
    const result = computeClassification({ ...baseInputs, enabledAt: null });
    expect(result.msSinceEnabled).toBeNull();
  });

  it('is not owned or shadowed when nothing we manage is anywhere in the precedence chain', () => {
    const result = computeClassification({
      ...baseInputs,
      userStatusLine: { type: 'command', command: 'node someone-elses-tool.js' },
      ownershipWrapperPath: null,
    });
    expect(result.ownedEffective).toBe(false);
    expect(result.shadowedByProject).toBe(false);
  });
});
