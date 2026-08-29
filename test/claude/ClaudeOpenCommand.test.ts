import { describe, expect, it } from 'vitest';
import {
  OPEN_CLAUDE_COMMAND_CANDIDATES,
  pickOpenClaudeCommand,
  USAGE_COMMAND_TEXT,
} from '../../src/providers/ClaudeIntegration';

describe('pickOpenClaudeCommand', () => {
  it('prefers the verified public sidebar-open command contributed by anthropic.claude-code', () => {
    expect(OPEN_CLAUDE_COMMAND_CANDIDATES[0]).toBe('claude-vscode.sidebar.open');
    expect(
      pickOpenClaudeCommand(['claude-vscode.sidebar.open', 'claude-vscode.editor.openLast']),
    ).toBe('claude-vscode.sidebar.open');
  });

  it('falls back to the documented editor.openLast command when sidebar.open is not registered', () => {
    expect(pickOpenClaudeCommand(['some.other.command', 'claude-vscode.editor.openLast'])).toBe(
      'claude-vscode.editor.openLast',
    );
  });

  it('returns null (safe fallback) when neither public command is registered', () => {
    expect(pickOpenClaudeCommand(['unrelated.command'])).toBeNull();
    expect(pickOpenClaudeCommand([])).toBeNull();
  });
});

describe('USAGE_COMMAND_TEXT', () => {
  it('is exactly "/usage"', () => {
    expect(USAGE_COMMAND_TEXT).toBe('/usage');
  });
});
