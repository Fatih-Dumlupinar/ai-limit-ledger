import { describe, expect, it } from 'vitest';
import {
  ClaudeOAuthUsageService,
  type ClaudeOAuthUsageServiceDeps,
} from '../src/providers/claude/oauth/ClaudeOAuthUsageService';
import { saveOAuthUsageConsent } from '../src/providers/claude/ClaudeRecoveryStore';
import type { FetchLike } from '../src/providers/claude/oauth/ClaudeOAuthUsageTransport';
import type { CredentialFsLike } from '../src/providers/claude/oauth/ClaudeCredentialReader';

function fakeMemento(): ClaudeOAuthUsageServiceDeps['globalState'] {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T) =>
      (store.has(key) ? store.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as ClaudeOAuthUsageServiceDeps['globalState'];
}

function credentialFixture(accessToken = 'fixture-token'): CredentialFsLike {
  return { readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken } }) };
}

function okFetch(usedPercent = 10): FetchLike {
  return async () =>
    ({
      status: 200,
      ok: true,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      type: 'basic',
      text: async () => JSON.stringify({ five_hour: { used_percentage: usedPercent } }),
    }) as Awaited<ReturnType<FetchLike>>;
}

function makeService(overrides: Partial<ClaudeOAuthUsageServiceDeps> = {}): {
  service: ClaudeOAuthUsageService;
  globalState: ClaudeOAuthUsageServiceDeps['globalState'];
} {
  const globalState = overrides.globalState ?? fakeMemento();
  const service = new ClaudeOAuthUsageService({
    fs: credentialFixture(),
    homeDir: '/fixture',
    fetchImpl: okFetch(),
    globalState,
    enabled: () => true,
    refreshSecondsProvider: () => 120,
    windowId: 'window-a',
    now: () => 1_000_000,
    ...overrides,
  });
  return { service, globalState };
}

describe('ClaudeOAuthUsageService gating', () => {
  it('never reads the credential file when the feature is disabled', async () => {
    let readCalled = false;
    const { service } = makeService({
      enabled: () => false,
      fs: {
        readFile: async () => {
          readCalled = true;
          return '{}';
        },
      },
    });
    const snapshot = await service.requestRefresh('timer');
    expect(snapshot.availability).toBe('disabled');
    expect(readCalled).toBe(false);
  });

  it('does not start the transport without consent, even when the setting is enabled', async () => {
    const { service } = makeService();
    const snapshot = await service.requestRefresh('manual');
    expect(snapshot.availability).toBe('consent-required');
  });

  it('reports authentication-required for an expired credential', async () => {
    const globalState = fakeMemento();
    await saveOAuthUsageConsent(globalState, {
      consentVersion: 1,
      acceptedAt: 'now',
      transportVersion: 1,
    });
    const { service } = makeService({
      globalState,
      fs: {
        readFile: async () =>
          JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: 500_000 } }),
      },
    });
    const snapshot = await service.requestRefresh('manual');
    expect(snapshot.availability).toBe('authentication-required');
  });

  it('succeeds and produces a ready snapshot once consent + credential + a good response are present', async () => {
    const globalState = fakeMemento();
    await saveOAuthUsageConsent(globalState, {
      consentVersion: 1,
      acceptedAt: 'now',
      transportVersion: 1,
    });
    const { service } = makeService({ globalState });
    const snapshot = await service.requestRefresh('manual');
    expect(snapshot.availability).toBe('ready');
    expect(snapshot.fiveHour?.usedPercent).toBe(10);
  });
});

describe('ClaudeOAuthUsageService refresh gating', () => {
  async function consentedService(overrides: Partial<ClaudeOAuthUsageServiceDeps> = {}) {
    const globalState = fakeMemento();
    await saveOAuthUsageConsent(globalState, {
      consentVersion: 1,
      acceptedAt: 'now',
      transportVersion: 1,
    });
    return makeService({ globalState, ...overrides });
  }

  it('never issues a new network request within the 120-second minimum interval', async () => {
    let calls = 0;
    const countingFetch: FetchLike = async (...args) => {
      calls += 1;
      return okFetch()(...args);
    };
    let now = 1_000_000;
    const { service } = await consentedService({ fetchImpl: countingFetch, now: () => now });
    await service.requestRefresh('manual');
    now += 60_000; // only 60s later — still inside the 120s floor
    await service.requestRefresh('activity');
    expect(calls).toBe(1);
  });

  it('a manual refresh is subject to the same minimum-interval gate as any other trigger', async () => {
    let calls = 0;
    const countingFetch: FetchLike = async (...args) => {
      calls += 1;
      return okFetch()(...args);
    };
    let now = 1_000_000;
    const { service } = await consentedService({ fetchImpl: countingFetch, now: () => now });
    await service.requestRefresh('timer');
    now += 1_000;
    await service.requestRefresh('manual');
    expect(calls).toBe(1);
  });

  it('a second window is denied the lease and does not also hit the network', async () => {
    let calls = 0;
    const countingFetch: FetchLike = async (...args) => {
      calls += 1;
      return okFetch()(...args);
    };
    const globalState = fakeMemento();
    await saveOAuthUsageConsent(globalState, {
      consentVersion: 1,
      acceptedAt: 'now',
      transportVersion: 1,
    });
    const { service: serviceA } = makeService({
      globalState,
      fetchImpl: countingFetch,
      windowId: 'window-a',
    });
    const { service: serviceB } = makeService({
      globalState,
      fetchImpl: countingFetch,
      windowId: 'window-b',
    });
    // Both windows attempt to refresh "at the same time" (same shared globalState/lease).
    await serviceA.requestRefresh('timer');
    await serviceB.requestRefresh('timer');
    expect(calls).toBe(1);
  });

  it('concurrent requestRefresh calls on the same service are coalesced into one in-flight request (single-flight)', async () => {
    let calls = 0;
    const slowFetch: FetchLike = async (...args) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return okFetch()(...args);
    };
    const { service } = await consentedService({ fetchImpl: slowFetch });
    const [a, b] = await Promise.all([
      service.requestRefresh('timer'),
      service.requestRefresh('manual'),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('preserves the last-known-good snapshot through a 429 rather than discarding it', async () => {
    let now = 1_000_000;
    const globalState = fakeMemento();
    await saveOAuthUsageConsent(globalState, {
      consentVersion: 1,
      acceptedAt: 'now',
      transportVersion: 1,
    });
    let mode: 'ok' | '429' = 'ok';
    const toggledFetch: FetchLike = async (...args) =>
      mode === 'ok'
        ? okFetch(55)(...args)
        : ({
            status: 429,
            ok: false,
            headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '5' : null) },
            type: 'basic',
            text: async () => '',
          } as Awaited<ReturnType<FetchLike>>);
    const { service } = makeService({ globalState, fetchImpl: toggledFetch, now: () => now });
    const first = await service.requestRefresh('manual');
    expect(first.fiveHour?.usedPercent).toBe(55);

    mode = '429';
    now += 200_000; // past the 120s minimum interval so a real request is attempted
    const second = await service.requestRefresh('manual');
    expect(second.availability).toBe('rate-limited');
    expect(second.fiveHour?.usedPercent).toBe(55);
    expect(second.stale).toBe(true);
  });
});
