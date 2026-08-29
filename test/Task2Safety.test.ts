import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/infrastructure/Logger';
import { classifyErrorCategory, safeCategoryOf } from '../src/infrastructure/ProviderDiagnostics';
import { SafeErrorPresenter, safeActionMessage } from '../src/infrastructure/SafeErrorPresenter';
import { SafeLogRedactor, safeErrorMessage } from '../src/infrastructure/redact';

describe('Task 2 safe logging', () => {
  it('redacts credentials, identity, paths, query secrets and UUIDs', () => {
    const text = new SafeLogRedactor({ homeDirectories: ['C:\\Users\\fixture'] }).redact(
      'Bearer abc123 ghp_1234567890 email=person@example.com ' +
        'C:\\Users\\fixture\\workspace /home/fixture/project ' +
        'https://example.test?a=1&token=secret-value&id=123e4567-e89b-12d3-a456-426614174000',
    );
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('ghp_1234567890');
    expect(text).not.toContain('person@example.com');
    expect(text).not.toContain('C:\\Users\\fixture');
    expect(text).not.toContain('/home/fixture');
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('123e4567-e89b-12d3-a456-426614174000');
  });

  it('does not serialise unknown exception objects', () => {
    expect(safeErrorMessage({ secret: 'do-not-log', response: { token: 'hidden' } })).toBe(
      '[unknown error]',
    );
  });

  it('keeps a bounded structured memory buffer with correlation IDs', () => {
    const logger = new Logger();
    const correlationId = logger.createCorrelationId();
    for (let index = 0; index < 205; index += 1) {
      logger.logRecord('info', {
        correlationId,
        action: 'test-operation',
        providerId: 'github-copilot',
        message: `safe ${index}`,
      });
    }
    expect(logger.getRecentRecords()).toHaveLength(200);
    expect(logger.getRecentRecords().every((record) => record.action === 'test-operation')).toBe(
      true,
    );
    expect(
      logger.getRecentRecords().every((record) => record.correlationId === correlationId),
    ).toBe(true);
    logger.dispose();
  });

  it('classifies HTTP and validation failures without exposing the message', () => {
    expect(classifyErrorCategory({ status: 401 })).toBe('authentication-required');
    expect(classifyErrorCategory({ statusCode: 403 })).toBe('authorization-failed');
    expect(classifyErrorCategory({ status: 429 })).toBe('rate-limited');
    expect(safeCategoryOf(new Error('redirect rejected by validation'))).toBe(
      'security-validation-failed',
    );
    expect(safeCategoryOf(new Error('response validation failed'))).toBe('invalid-response');
    expect(safeCategoryOf({ message: 'Bearer should never be shown' })).toBe('unknown');
  });

  it('suppresses cancellation/rate-limit popups and bounds duplicates', async () => {
    const notify = vi.fn(async () => 'Show Logs' as const);
    const showLogs = vi.fn();
    let now = 1000;
    const presenter = new SafeErrorPresenter({ notify, showLogs, now: () => now });
    await presenter.present({
      providerName: 'Grok',
      action: 'refresh usage',
      category: 'cancelled',
    });
    await presenter.present({
      providerName: 'Grok',
      action: 'refresh usage',
      category: 'rate-limited',
    });
    await presenter.present({ providerName: 'Grok', action: 'refresh usage', category: 'unknown' });
    await presenter.present({ providerName: 'Grok', action: 'refresh usage', category: 'unknown' });
    now += 31_000;
    await presenter.present({ providerName: 'Grok', action: 'refresh usage', category: 'unknown' });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(showLogs).toHaveBeenCalledTimes(2);
    expect(
      safeActionMessage({ providerName: 'Grok', action: 'refresh usage', category: 'unknown' }),
    ).not.toContain('Bearer');
  });
});
