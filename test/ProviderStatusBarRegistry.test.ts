import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetWindowMocks, __statusBarItems, MarkdownString, type ThemeColor } from './vscode';
import { ProviderStatusBarRegistry } from '../src/ui/ProviderStatusBarRegistry';
import type { ProviderSnapshot } from '../src/providers/types';

const capabilities = { rateLimits: true, usage: true, statusLine: true };

function snapshot(
  providerId: string,
  availability: ProviderSnapshot['availability'],
  overrides: Partial<ProviderSnapshot> = {},
): ProviderSnapshot {
  return {
    providerId,
    providerName: providerId,
    availability,
    connected: false,
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Not connected',
    observedAt: 1000,
    checkedAt: 1000,
    stale: false,
    capabilities,
    ...overrides,
  };
}

function numericSnapshot(
  providerId: string,
  overrides: Partial<ProviderSnapshot> = {},
): ProviderSnapshot {
  return snapshot(providerId, 'ready', {
    connected: true,
    usageWindows: [
      {
        id: 'current',
        label: '5h',
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: null,
        windowDurationMinutes: 300,
      },
    ],
    source: providerId === 'codex' ? 'Official Codex App Server' : 'Not connected',
    ...overrides,
  });
}

describe('ProviderStatusBarRegistry', () => {
  beforeEach(() => __resetWindowMocks());

  it('uses one item per canonical provider and isolates severity', () => {
    const registry = new ProviderStatusBarRegistry();
    registry.render(
      [
        numericSnapshot('codex'),
        snapshot('grok', 'error', { connected: true, errorCategory: 'unknown' }),
      ],
      'remaining',
    );
    const items = __statusBarItems();
    expect(items).toHaveLength(4);
    expect(items[0].visible).toBe(true);
    expect(items[0].backgroundColor).toBeUndefined();
    expect((items[3].backgroundColor as ThemeColor).id).toBe('statusBarItem.errorBackground');
    registry.dispose();
    expect(items.every((item) => item.disposed)).toBe(true);
  });

  it('normalizes aliases without creating duplicate items and clears stale colors', () => {
    const registry = new ProviderStatusBarRegistry();
    registry.render([numericSnapshot('github-copilot')], 'compact');
    expect(__statusBarItems()).toHaveLength(4);
    expect(__statusBarItems()[2].visible).toBe(true);
    registry.render(
      [numericSnapshot('copilot', { stale: true, availability: 'stale' })],
      'compact',
    );
    expect((__statusBarItems()[2].backgroundColor as ThemeColor).id).toBe(
      'statusBarItem.warningBackground',
    );
    registry.render([numericSnapshot('copilot')], 'compact');
    expect(__statusBarItems()[2].backgroundColor).toBeUndefined();
    registry.dispose();
  });

  it('shows a warning for stale data and an error after active authentication loss', () => {
    const registry = new ProviderStatusBarRegistry();
    registry.render(
      [
        numericSnapshot('claude', {
          providerName: 'Claude Code',
          stale: true,
          availability: 'stale',
        }),
      ],
      'remaining',
    );
    expect((__statusBarItems()[1].backgroundColor as ThemeColor).id).toBe(
      'statusBarItem.warningBackground',
    );
    registry.render(
      [snapshot('claude', 'authentication-required', { providerName: 'Claude Code' })],
      'remaining',
    );
    expect(__statusBarItems()[1].visible).toBe(true);
    expect((__statusBarItems()[1].backgroundColor as ThemeColor).id).toBe(
      'statusBarItem.errorBackground',
    );
    registry.dispose();
  });

  it('hides setup-only, CLI-only and no-numeric free states', () => {
    const registry = new ProviderStatusBarRegistry();
    registry.render(
      [
        snapshot('codex', 'cli-not-installed'),
        snapshot('claude', 'setup-required' as ProviderSnapshot['availability']),
        snapshot('grok', 'connected-no-billing-method', { connected: true }),
      ],
      'compact',
    );
    expect(__statusBarItems().every((item) => !item.visible)).toBe(true);
    registry.dispose();
  });

  it('updates only the local tooltip countdown and disposes its single timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'));
    const registry = new ProviderStatusBarRegistry({ presentationTimerMs: 1_000 });
    registry.render(
      [
        numericSnapshot('codex', {
          checkedAt: Date.now(),
          lastSuccessfulDataUpdate: Date.now(),
          nextFallbackRefreshAt: Date.now() + 60_000,
          metadata: { fallbackIntervalSeconds: 60 },
        }),
      ],
      'remaining',
    );
    const item = __statusBarItems()[0];
    const before = (item.tooltip as MarkdownString).value;
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    const after = (item.tooltip as MarkdownString).value;
    expect(after).not.toBe(before);
    expect(after).toContain('Next fallback check: in 59s');
    expect((item.tooltip as MarkdownString).isTrusted).toBe(false);

    registry.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
