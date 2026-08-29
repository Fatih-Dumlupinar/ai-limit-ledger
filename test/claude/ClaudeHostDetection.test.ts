import { describe, expect, it } from 'vitest';
import { detectHostKind } from '../../src/providers/claude/ClaudeHostDetection';

describe('detectHostKind', () => {
  it('is standalone-cli when only the terminal CLI is found', () => {
    expect(detectHostKind(true, false)).toBe('standalone-cli');
  });

  it('is vscode-sidebar for a sidebar-only installation with no standalone CLI', () => {
    expect(detectHostKind(false, true)).toBe('vscode-sidebar');
  });

  it('is both when the CLI and the VS Code extension are both present', () => {
    expect(detectHostKind(true, true)).toBe('both');
  });

  it('is unknown when neither is detectable', () => {
    expect(detectHostKind(false, false)).toBe('unknown');
  });
});
