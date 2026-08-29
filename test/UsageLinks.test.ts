import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  CLAUDE_USAGE_PAGE_URL,
  CODEX_USAGE_PAGE_URL,
  openClaudeUsagePage,
  openCodexUsagePage,
  isAllowedUsagePageUrl,
} from '../src/ui/UsageLinks';

describe('official usage links', () => {
  it('opens the exact official Codex URL only when invoked', async () => {
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    await openCodexUsagePage();
    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ value: CODEX_USAGE_PAGE_URL }),
    );
    openExternal.mockRestore();
  });

  it('opens the exact official Claude URL only when invoked', async () => {
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    await openClaudeUsagePage();
    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ value: CLAUDE_USAGE_PAGE_URL }),
    );
    openExternal.mockRestore();
  });

  it('rejects non-HTTPS or wrong-host URLs before opening anything', () => {
    expect(
      isAllowedUsagePageUrl(
        'http://chatgpt.com/codex/cloud/settings/analytics#usage',
        'chatgpt.com',
      ),
    ).toBe(false);
    expect(isAllowedUsagePageUrl('https://example.com/usage', 'chatgpt.com')).toBe(false);
  });

  it('reports safe feedback when external navigation returns false or throws', async () => {
    const openExternal = vi.spyOn(vscode.env, 'openExternal');
    const errorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    openExternal.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('host rejected'));

    await openCodexUsagePage();
    await openClaudeUsagePage();

    expect(errorMessage).toHaveBeenCalledTimes(2);
    openExternal.mockRestore();
    errorMessage.mockRestore();
  });
});
