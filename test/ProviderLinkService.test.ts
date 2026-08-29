import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  getProviderLinkDiagnosticsSnapshot,
  ProviderLinkService,
} from '../src/links/ProviderLinkService';

function logger() {
  return {
    createCorrelationId: vi.fn(() => 'correlation-123'),
    logRecord: vi.fn(),
  };
}

describe('ProviderLinkService', () => {
  it('opens a known registry link and preserves the invocation correlation ID', async () => {
    const fakeLogger = logger();
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const service = new ProviderLinkService(fakeLogger);

    const result = await service.open('codex-usage', {
      source: 'dashboard',
      correlationId: 'correlation-123',
    });

    expect(result).toEqual({ status: 'success', linkId: 'codex-usage' });
    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
      }),
    );
    expect(fakeLogger.logRecord).toHaveBeenCalledWith(
      'info',
      expect.objectContaining({
        correlationId: 'correlation-123',
        providerId: 'codex',
        action: 'provider-link.open',
        message: expect.stringContaining('codex-usage'),
      }),
    );
    openExternal.mockRestore();
  });

  it('treats false and exceptions as safe errors', async () => {
    const fakeLogger = logger();
    const openExternal = vi
      .spyOn(vscode.env, 'openExternal')
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('browser unavailable'));
    const service = new ProviderLinkService(fakeLogger);

    await expect(
      service.open('claude-usage', { source: 'command-palette' }),
    ).resolves.toMatchObject({
      status: 'error',
      linkId: 'claude-usage',
      safeErrorCategory: 'upstream-unavailable',
    });
    await expect(
      service.open('grok-billing', { source: 'command-palette' }),
    ).resolves.toMatchObject({
      status: 'error',
      linkId: 'grok-billing',
    });
    expect(getProviderLinkDiagnosticsSnapshot().lastLinkOpenResult).toBe('error');
    openExternal.mockRestore();
  });

  it('does not call the external opener for an unknown ID', async () => {
    const fakeLogger = logger();
    const openExternal = vi.fn().mockResolvedValue(true);
    const service = new ProviderLinkService(fakeLogger, openExternal);

    const result = await service.open('unknown-link' as never, { source: 'dashboard' });

    expect(result.status).toBe('error');
    expect(result.safeErrorCategory).toBe('security-validation-failed');
    expect(openExternal).not.toHaveBeenCalled();
  });
});
