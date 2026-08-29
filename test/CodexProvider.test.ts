import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '../src/appServer/CodexAppServerClient';
import { SafeDiagnosticError } from '../src/infrastructure/ProviderDiagnostics';
import { formatCodexDiagnostics } from '../src/providers/CodexDiagnostics';
import { CodexProvider } from '../src/providers/CodexProvider';

function fakeClient(overrides: Record<string, unknown> = {}): CodexAppServerClient {
  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    on: vi.fn(),
    readAccount: vi.fn(async () => ({ account: { planType: 'pro' } })),
    readRateLimits: vi.fn(async () => ({
      rateLimits: {
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      },
    })),
    readUsage: vi.fn(async () => ({ summary: { lifetimeTokens: 12_345, peakDailyTokens: 900 } })),
    version: vi.fn(async () => 'codex-cli 0.3.7'),
    getDiagnostics: vi.fn(() => ({
      executablePath: 'C:\\Users\\fixture\\codex.exe',
      executableExists: true,
      cliVersion: 'codex-cli 0.3.7',
      processState: 'running',
      processStartedAt: Date.now(),
      processExitCode: null,
      initialized: true,
      protocolVersion: '1',
      requestStatus: {},
      lastDiagnostic: null,
    })),
    ...overrides,
  } as unknown as CodexAppServerClient;
  return client;
}

describe('CodexProvider notification-driven refresh', () => {
  function fakeClientWithNotify(): {
    client: CodexAppServerClient;
    readRateLimits: ReturnType<typeof vi.fn>;
    emitNotification: (params: unknown) => void;
  } {
    let handler: ((method: string, params: unknown) => void) | undefined;
    const readRateLimits = vi.fn(async () => ({
      rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } },
    }));
    const client = fakeClient({
      readRateLimits,
      on: vi.fn((event: string, cb: (method: string, params: unknown) => void) => {
        if (event === 'notification') handler = cb;
      }),
    });
    return {
      client,
      readRateLimits,
      emitNotification: (params: unknown) => handler?.('account/rateLimits/updated', params),
    };
  }

  it('applies a validated push notification directly, without an extra rateLimits/read call', async () => {
    const { client, readRateLimits, emitNotification } = fakeClientWithNotify();
    const provider = new CodexProvider(client, { error: vi.fn() });
    await provider.start();
    await provider.refresh(true);
    const callsAfterInitialRefresh = readRateLimits.mock.calls.length;

    emitNotification({ rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300 } } });
    // Notification handling is synchronous state application, not an async RPC round trip.
    await Promise.resolve();

    expect(provider.getSnapshot()?.usageWindows[0]?.usedPercent).toBe(55);
    expect(readRateLimits.mock.calls.length).toBe(callsAfterInitialRefresh);
  });

  it('falls back to a governed read when the notification payload is not validly shaped', async () => {
    const { client, readRateLimits, emitNotification } = fakeClientWithNotify();
    const provider = new CodexProvider(client, { error: vi.fn() });
    await provider.start();
    await provider.refresh(true);
    const callsAfterInitialRefresh = readRateLimits.mock.calls.length;

    emitNotification({ notAShapeWeRecognize: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readRateLimits.mock.calls.length).toBeGreaterThan(callsAfterInitialRefresh);
  });

  it('shows primary, secondary, and extra rateLimitsByLimitId windows together', async () => {
    const client = fakeClient({
      readRateLimits: vi.fn(async () => ({
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 10, windowDurationMins: 300 },
            secondary: { usedPercent: 20, windowDurationMins: 10080 },
          },
          other: { primary: { usedPercent: 30, windowDurationMins: 300 } },
        },
      })),
    });
    const provider = new CodexProvider(client, { error: vi.fn() });
    await provider.start();
    const snapshot = await provider.refresh(true);
    expect(snapshot?.usageWindows).toHaveLength(3);
  });

  it('exposes fallback interval, notification time, and single-flight state in diagnostics', async () => {
    const { client, emitNotification } = fakeClientWithNotify();
    const provider = new CodexProvider(client, { error: vi.fn() }, 45_000);
    await provider.start();
    await provider.refresh(true);
    emitNotification({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } });
    await Promise.resolve();

    const diagnostics = await provider.getCodexDiagnostics();
    expect(diagnostics.fallbackIntervalMs).toBe(45_000);
    expect(diagnostics.lastNotificationTime).toEqual(expect.any(Number));
    expect(diagnostics.rateLimitsSubscriptionActive).toBe(true);
    expect(diagnostics.parsedWindowCount).toBe(1);
  });
});

describe('CodexProvider recovery', () => {
  it('publishes an unavailable snapshot when App Server initialization fails', async () => {
    const client = fakeClient({
      start: vi.fn(async () => {
        throw new SafeDiagnosticError('initialize-failed');
      }),
    });
    const provider = new CodexProvider(client, { error: vi.fn() });

    await expect(provider.start()).rejects.toThrow();
    expect(provider.getSnapshot()?.availability).toBe('unavailable');
    expect(provider.getSnapshot()?.errorCategory).toBe('initialize-failed');
  });

  it('publishes a partial snapshot when one optional read fails', async () => {
    const log = vi.fn();
    const client = fakeClient({
      readUsage: vi.fn(async () => {
        throw new Error('RAW_RPC_SECRET token=secret');
      }),
    });
    const provider = new CodexProvider(client, { error: log });

    await provider.start();
    const snapshot = await provider.refresh(true);

    expect(snapshot?.availability).toBe('ready');
    expect(snapshot?.plan).toBe('pro');
    expect(snapshot?.usageWindows).toHaveLength(1);
    expect(snapshot?.tokens?.lifetimeTokens).toBeNull();
    expect(snapshot?.checkedAt).toEqual(expect.any(Number));
    expect(snapshot?.lastSuccessfulDataUpdate).toEqual(expect.any(Number));
    expect(snapshot?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'account/usage/read', category: 'usage-read-failed' }),
      ]),
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('RAW_RPC_SECRET');
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret');
  });

  it('preserves account and usage data when the rate-limits read fails', async () => {
    const client = fakeClient({
      readRateLimits: vi.fn(async () => {
        throw new Error('rate limits unavailable');
      }),
    });
    const provider = new CodexProvider(client, { error: vi.fn() });

    await provider.start();
    const snapshot = await provider.refresh(true);

    expect(snapshot?.availability).toBe('ready');
    expect(snapshot?.plan).toBe('pro');
    expect(snapshot?.tokens?.lifetimeTokens).toBe(12_345);
    expect(snapshot?.usageWindows).toHaveLength(0);
    expect(snapshot?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'rate-limits-read-failed' })]),
    );
  });

  it('categorizes an account failure without exposing the raw error', async () => {
    const client = fakeClient({
      readAccount: vi.fn(async () => {
        throw new SafeDiagnosticError('not-authenticated', 'sensitive account payload');
      }),
    });
    const log = vi.fn();
    const provider = new CodexProvider(client, { error: log });

    await provider.start();
    const snapshot = await provider.refresh(true);

    expect(snapshot?.availability).toBe('unavailable');
    expect(snapshot?.errorCategory).toBe('not-authenticated');
    expect(log.mock.calls.flat().join('\n')).not.toContain('sensitive account payload');
  });

  it('redacts the Codex diagnostic report path', async () => {
    const provider = new CodexProvider(fakeClient());
    const report = await provider.getCodexDiagnostics();
    const formatted = formatCodexDiagnostics(report);

    expect(formatted).toContain('<USER_HOME>');
    expect(formatted).not.toContain('C:\\Users\\fixture');
  });

  it('keeps a selected provider visible when the first refresh has no usable data', async () => {
    const client = fakeClient({
      readAccount: vi.fn(async () => {
        throw new Error('account unavailable');
      }),
      readRateLimits: vi.fn(async () => {
        throw new Error('limits unavailable');
      }),
      readUsage: vi.fn(async () => {
        throw new Error('usage unavailable');
      }),
    });
    const provider = new CodexProvider(client, { error: vi.fn() });

    await provider.start();
    const snapshot = await provider.refresh(true);

    expect(snapshot?.providerId).toBe('codex');
    expect(snapshot?.availability).toBe('unavailable');
    expect(snapshot?.stale).toBe(false);
    expect(snapshot?.checkedAt).toEqual(expect.any(Number));
    expect(snapshot?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'account/read', category: 'account-read-failed' }),
        expect.objectContaining({
          method: 'account/rateLimits/read',
          category: 'rate-limits-read-failed',
        }),
        expect.objectContaining({ method: 'account/usage/read', category: 'usage-read-failed' }),
      ]),
    );
  });

  it('preserves a good snapshot as stale during a later failure and clears stale on recovery', async () => {
    let healthy = true;
    const client = fakeClient({
      readAccount: vi.fn(async () => {
        if (!healthy) throw new Error('account unavailable');
        return { account: { planType: 'pro' } };
      }),
      readRateLimits: vi.fn(async () => {
        if (!healthy) throw new Error('limits unavailable');
        return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } };
      }),
      readUsage: vi.fn(async () => {
        if (!healthy) throw new Error('usage unavailable');
        return { summary: { lifetimeTokens: 10 } };
      }),
    });
    const provider = new CodexProvider(client, { error: vi.fn() });

    await provider.start();
    const good = await provider.refresh(true);
    healthy = false;
    const stale = await provider.refresh(true);

    expect(good?.availability).toBe('ready');
    expect(stale?.availability).toBe('stale');
    expect(stale?.stale).toBe(true);
    expect(stale?.lastSuccessfulDataUpdate).toBe(good?.lastSuccessfulDataUpdate);
    expect(stale?.checkedAt).toEqual(expect.any(Number));

    healthy = true;
    const recovered = await provider.refresh(true);
    expect(recovered?.availability).toBe('ready');
    expect(recovered?.stale).toBe(false);
    expect(recovered?.error).toBeUndefined();
    expect(recovered?.errorCategory).toBeUndefined();
  });
});

describe('CodexProvider throttled-refresh handling (governor no-op, not a failure)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not flip a fresh, successful snapshot to stale when a second non-forced refresh arrives too soon', async () => {
    const client = fakeClient();
    const provider = new CodexProvider(client, { error: vi.fn() }, 60_000);
    await provider.start();
    const good = await provider.refresh(true);
    expect(good?.availability).toBe('ready');

    // A non-forced refresh immediately after a success is throttled by RefreshGovernor — this
    // must be a silent no-op, not a failure that degrades the snapshot to `stale`.
    const throttled = await provider.refresh(false);
    expect(throttled?.availability).toBe('ready');
    expect(throttled?.stale).toBe(false);
    expect(throttled).toEqual(good);
  });

  it('still reports unavailable, never stale, for a genuine failure with no prior snapshot', async () => {
    const client = fakeClient({
      readAccount: vi.fn(async () => {
        throw new Error('account unavailable');
      }),
      readRateLimits: vi.fn(async () => {
        throw new Error('limits unavailable');
      }),
      readUsage: vi.fn(async () => {
        throw new Error('usage unavailable');
      }),
    });
    const provider = new CodexProvider(client, { error: vi.fn() });
    await provider.start();
    const snapshot = await provider.refresh(true);
    expect(snapshot?.availability).toBe('unavailable');
    expect(snapshot?.stale).toBe(false);
  });

  it('treats a notification-driven update as a successful data update, not stale', async () => {
    let handler: ((method: string, params: unknown) => void) | undefined;
    const client = fakeClient({
      on: vi.fn((event: string, cb: (method: string, params: unknown) => void) => {
        if (event === 'notification') handler = cb;
      }),
    });
    const provider = new CodexProvider(client, { error: vi.fn() });
    await provider.start();
    const good = await provider.refresh(true);
    expect(good?.availability).toBe('ready');

    handler?.('account/rateLimits/updated', {
      rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } },
    });
    await Promise.resolve();

    const snapshot = provider.getSnapshot();
    expect(snapshot?.availability).toBe('ready');
    expect(snapshot?.stale).toBe(false);
    expect(snapshot?.lastSuccessfulDataUpdate).toBeGreaterThanOrEqual(
      good!.lastSuccessfulDataUpdate!,
    );
  });
});
