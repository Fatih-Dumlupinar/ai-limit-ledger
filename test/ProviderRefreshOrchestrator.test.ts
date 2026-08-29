import { describe, expect, it, vi } from 'vitest';
import { ProviderCoordinator } from '../src/providers/ProviderCoordinator';
import { ProviderRefreshOrchestrator } from '../src/providers/ProviderRefreshOrchestrator';
import { RefreshGovernor, ThrottledError } from '../src/providers/RefreshGovernor';
import type { ProviderAdapter, ProviderSnapshot } from '../src/providers/types';

function snapshot(providerId: string): ProviderSnapshot {
  return {
    providerId,
    providerName: providerId,
    availability: 'ready',
    connected: true,
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Not connected',
    observedAt: Date.now(),
    checkedAt: Date.now(),
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
  };
}

function adapter(
  providerId: string,
  calls: string[],
  refresh: () => Promise<ProviderSnapshot | undefined> = async () => snapshot(providerId),
): ProviderAdapter {
  return {
    id: providerId,
    displayName: providerId,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
    detect: async () => true,
    start: async () => undefined,
    stop: () => undefined,
    refresh: async () => {
      calls.push(providerId);
      return refresh();
    },
    getSnapshot: () => snapshot(providerId),
    onDidChange: () => ({ dispose: () => undefined }),
    getDiagnostics: () => ({ state: 'ready' }),
  };
}

function memento(): {
  get: <T>(key: string) => T | undefined;
  update: (key: string, value: unknown) => Promise<void>;
} {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

describe('ProviderRefreshOrchestrator', () => {
  it('refreshes only the requested Codex provider', async () => {
    const calls: string[] = [];
    const coordinator = new ProviderCoordinator([
      adapter('codex', calls),
      adapter('claude', calls),
      adapter('copilot', calls),
      adapter('grok', calls),
    ]);
    const oauth = vi.fn(async () => undefined);
    const orchestrator = new ProviderRefreshOrchestrator({
      coordinator,
      globalState: memento(),
      refreshClaudeOAuth: oauth,
    });

    const result = await orchestrator.refreshProvider('codex', {
      source: 'dashboard',
      force: true,
    });

    expect(result.status).toBe('success');
    expect(calls).toEqual(['codex']);
    expect(oauth).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('refreshes Claude and its enabled OAuth capability without touching other providers', async () => {
    const calls: string[] = [];
    const coordinator = new ProviderCoordinator([
      adapter('codex', calls),
      adapter('claude', calls),
      adapter('copilot', calls),
      adapter('grok', calls),
    ]);
    const oauth = vi.fn(async () => undefined);
    const orchestrator = new ProviderRefreshOrchestrator({
      coordinator,
      refreshClaudeOAuth: oauth,
    });

    await orchestrator.refreshProvider('claude', { source: 'command-palette', force: true });

    expect(calls).toEqual(['claude']);
    expect(oauth).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('uses all selected provider paths and isolates a provider failure', async () => {
    const calls: string[] = [];
    const coordinator = new ProviderCoordinator([
      adapter('codex', calls, async () => {
        throw new Error('codex transport failed');
      }),
      adapter('claude', calls),
      adapter('copilot', calls),
      adapter('grok', calls),
    ]);
    const orchestrator = new ProviderRefreshOrchestrator({ coordinator });

    const results = await orchestrator.refreshAll({ source: 'command-palette', force: true });

    expect(calls).toEqual(['codex', 'claude', 'copilot', 'grok']);
    expect(results).toHaveLength(4);
    expect(results.find((result) => result.providerId === 'codex')?.status).toBe('error');
    expect(results.filter((result) => result.status === 'success')).toHaveLength(3);
    coordinator.dispose();
  });

  it('does not call providers excluded by selection and single-flights duplicate requests', async () => {
    const calls: string[] = [];
    let release!: (value: ProviderSnapshot) => void;
    const pending = new Promise<ProviderSnapshot>((resolve) => {
      release = resolve;
    });
    const coordinator = new ProviderCoordinator(
      [adapter('codex', calls, () => pending), adapter('claude', calls), adapter('copilot', calls)],
      undefined,
      { selectedProviderIds: ['codex', 'claude'] },
    );
    const orchestrator = new ProviderRefreshOrchestrator({ coordinator });

    const first = orchestrator.refreshProvider('codex', { source: 'dashboard', force: true });
    const second = orchestrator.refreshProvider('codex', { source: 'dashboard', force: true });
    expect(calls).toEqual(['codex']);
    release(snapshot('codex'));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(
      (await orchestrator.refreshAll({ source: 'internal' })).map((item) => item.providerId),
    ).toEqual(['codex', 'claude']);
    expect(calls).not.toContain('copilot');
    coordinator.dispose();
  });

  it('uses a provider-specific cross-window lease without blocking another provider', async () => {
    const calls: string[] = [];
    let release!: (value: ProviderSnapshot) => void;
    const pending = new Promise<ProviderSnapshot>((resolve) => {
      release = resolve;
    });
    const coordinator = new ProviderCoordinator([
      adapter('codex', calls, () => pending),
      adapter('claude', calls),
    ]);
    const sharedState = memento();
    const firstWindow = new ProviderRefreshOrchestrator({
      coordinator,
      globalState: sharedState,
      windowId: 'window-a',
    });
    const secondWindow = new ProviderRefreshOrchestrator({
      coordinator,
      globalState: sharedState,
      windowId: 'window-b',
    });

    const first = firstWindow.refreshProvider('codex', { source: 'internal', force: true });
    const duplicate = await secondWindow.refreshProvider('codex', {
      source: 'internal',
      force: true,
    });
    const other = await secondWindow.refreshProvider('claude', { source: 'internal', force: true });

    expect(duplicate.status).toBe('throttled');
    expect(other.status).toBe('success');
    expect(calls).toEqual(['codex', 'claude']);
    release(snapshot('codex'));
    await expect(first).resolves.toMatchObject({ status: 'success' });
    coordinator.dispose();
  });
});

describe('RefreshGovernor backoff', () => {
  it('does not let a forced refresh bypass a retry pause', async () => {
    const governor = new RefreshGovernor(60_000);
    await expect(
      governor.run(async () => {
        throw new Error('429 retry-after: 30');
      }, true),
    ).rejects.toThrow('429');
    await expect(governor.run(async () => 'must not run', true)).rejects.toBeInstanceOf(
      ThrottledError,
    );
  });
});
