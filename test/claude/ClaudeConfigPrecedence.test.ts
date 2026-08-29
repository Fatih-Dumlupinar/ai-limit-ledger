import { describe, expect, it } from 'vitest';
import { resolveEffectiveStatusLine } from '../../src/providers/claude/ClaudeConfigPrecedence';

describe('resolveEffectiveStatusLine', () => {
  it('falls back to user scope when no project settings exist', () => {
    const result = resolveEffectiveStatusLine({ command: 'user' }, undefined, undefined);
    expect(result).toEqual({ effectiveStatusLine: { command: 'user' }, winningScope: 'user' });
  });

  it('project shared statusLine shadows user statusLine', () => {
    const result = resolveEffectiveStatusLine(
      { command: 'user' },
      { command: 'project-shared' },
      undefined,
    );
    expect(result).toEqual({
      effectiveStatusLine: { command: 'project-shared' },
      winningScope: 'project-shared',
    });
  });

  it('project local statusLine shadows both project shared and user statusLine', () => {
    const result = resolveEffectiveStatusLine(
      { command: 'user' },
      { command: 'project-shared' },
      { command: 'project-local' },
    );
    expect(result).toEqual({
      effectiveStatusLine: { command: 'project-local' },
      winningScope: 'project-local',
    });
  });

  it('reports no effective statusLine when nothing is configured anywhere', () => {
    expect(resolveEffectiveStatusLine(undefined, undefined, undefined)).toEqual({
      effectiveStatusLine: undefined,
      winningScope: 'none',
    });
  });
});
