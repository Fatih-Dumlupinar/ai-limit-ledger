import { describe, expect, it } from 'vitest';
import { deriveAccessMode } from '../../src/providers/claude/ClaudeAccessMode';

describe('deriveAccessMode', () => {
  it('maps vscode-sidebar host to vscode-extension access mode', () => {
    expect(deriveAccessMode('vscode-sidebar')).toBe('vscode-extension');
  });
  it('maps standalone-cli host to standalone-cli access mode', () => {
    expect(deriveAccessMode('standalone-cli')).toBe('standalone-cli');
  });
  it('maps both to hybrid', () => {
    expect(deriveAccessMode('both')).toBe('hybrid');
  });
  it('maps unknown to unavailable', () => {
    expect(deriveAccessMode('unknown')).toBe('unavailable');
  });
});
