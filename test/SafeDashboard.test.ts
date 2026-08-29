import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  __closeTextEditors,
  __createdWebviewPanels,
  __registeredTextDocumentContentProviders,
  __resetWindowMocks,
  __visibleTextEditors,
} from 'vscode';
import type { ProviderSnapshot } from '../src/providers/types';
import {
  buildSafeDashboardDocumentModel,
  dashboardModeFromConfiguration,
  SafeDashboardContentProvider,
  SafeDashboardController,
  renderSafeDashboard,
} from '../src/ui/SafeDashboard';
import { buildCodexUsageInsights } from '../src/providers/UsageInsights';

function snapshot(providerId: string, overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId,
    providerName: providerId,
    availability: 'ready',
    connected: true,
    plan: 'Plus',
    cliVersion: '1.0.0',
    usageWindows: [
      {
        id: 'five-hour',
        label: '5-hour',
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: 1_900_000_000,
        windowDurationMinutes: 300,
      },
    ],
    source: 'Official Codex App Server',
    observedAt: 1_900_000_000_000,
    checkedAt: 1_900_000_000_000,
    lastSuccessfulDataUpdate: 1_900_000_000_000,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
    ...overrides,
  };
}

describe('Safe Dashboard', () => {
  afterEach(() => {
    __closeTextEditors();
    __resetWindowMocks();
    vi.useRealTimers();
  });

  it('uses the canonical read-only virtual document and never creates a Webview', async () => {
    const controller = new SafeDashboardController({
      modelSource: () =>
        buildSafeDashboardDocumentModel([snapshot('codex')], { now: 1_900_000_000_000 }),
    });
    controller.register();
    expect(__registeredTextDocumentContentProviders()).toHaveProperty('size', 1);
    await controller.open();
    await controller.open();
    expect(__registeredTextDocumentContentProviders()).toHaveProperty('size', 1);
    expect(__createdWebviewPanels()).toHaveLength(0);
    expect(__visibleTextEditors()).toHaveLength(1);
    expect(__visibleTextEditors()[0]?.document.uri.toString()).toBe(
      'ai-limit-ledger:/dashboard.md',
    );
    expect(__visibleTextEditors()[0]?.document.isDirty).toBe(false);
    controller.dispose();
  });

  it('coalesces no provider refresh into document refresh events and renders countdowns from cached data', async () => {
    vi.useFakeTimers();
    const provider = new SafeDashboardContentProvider(() =>
      buildSafeDashboardDocumentModel([snapshot('codex')], { now: Date.now() }),
    );
    const seen: string[] = [];
    provider.onDidChange((uri) => seen.push(uri.toString()));
    provider.refresh();
    expect(seen).toEqual(['ai-limit-ledger:/dashboard.md']);

    const controller = new SafeDashboardController({
      modelSource: () => buildSafeDashboardDocumentModel([snapshot('codex')]),
      timerIntervalMs: 1_000,
    });
    controller.register();
    const registered = __registeredTextDocumentContentProviders().get('ai-limit-ledger');
    let ticks = 0;
    const providerEvent =
      registered &&
      (
        registered as unknown as {
          onDidChange: (listener: (uri: vscode.Uri) => void) => vscode.Disposable;
        }
      ).onDidChange?.(() => ticks++);
    await controller.open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toBeGreaterThanOrEqual(1);
    providerEvent?.dispose();
    controller.dispose();
  });

  it('uses the presentation resolver for active/available placement and omits hidden providers', () => {
    const model = buildSafeDashboardDocumentModel([
      snapshot('codex'),
      snapshot('copilot', {
        availability: 'not-selected',
        connected: false,
        usageWindows: [],
        source: 'Not connected',
        plan: null,
        cliVersion: null,
      }),
      snapshot('unknown-provider', { providerName: 'secret@example.com' }),
    ]);
    expect(model.activeProviders.map((provider) => provider.providerId)).toEqual(['codex']);
    expect(model.availableProviders.map((provider) => provider.providerId)).toEqual(['copilot']);
    expect(renderSafeDashboard(model)).not.toContain('unknown-provider');
  });

  it('does not fabricate Copilot or Grok progress when numeric denominators/data are absent', () => {
    const model = buildSafeDashboardDocumentModel([
      snapshot('copilot', {
        providerName: 'GitHub Copilot',
        source: 'Official GitHub Billing REST API',
        usageWindows: [],
        credits: { used: 4, allowance: null },
      }),
      snapshot('grok', {
        providerName: 'Grok',
        plan: 'Free',
        source: 'Experimental — Grok Build billing extension',
        usageWindows: [],
        availability: 'connected-no-billing-method',
      }),
    ]);
    const rendered = renderSafeDashboard(model);
    expect(rendered).toContain('Monthly allowance is not provided');
    expect(rendered).toContain('Numeric usage is not exposed by this source.');
    expect(rendered).not.toContain('% remaining');
  });

  it('renders fixed registry links and Grok usage instructions as plain native text', () => {
    const model = buildSafeDashboardDocumentModel([
      snapshot('grok', {
        providerName: 'Grok',
        source: 'Experimental — Grok Build billing extension',
        usageWindows: [],
      }),
    ]);
    const rendered = renderSafeDashboard(model);
    expect(rendered).toContain('Open Grok billing: https://grok.com/?_s=billing');
    expect(rendered).toContain(
      'Open Grok Build installation guide: https://docs.x.ai/build/overview',
    );
    expect(rendered).toContain('Use /usage inside Grok Build for the official account view.');
    expect(rendered).not.toContain('command:');
  });

  it('preserves zero, rejects NaN bars, shows stale state, and redacts dynamic text', () => {
    const model = buildSafeDashboardDocumentModel([
      snapshot('claude', {
        providerName: 'Claude\n# injected',
        plan: 'Plus email@example.com 550e8400-e29b-41d4-a716-446655440000',
        source: 'Experimental — undocumented Anthropic usage endpoint',
        usageWindows: [
          {
            id: 'five-hour',
            label: '5h [unsafe](command:evil)',
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: null,
            windowDurationMinutes: 300,
          },
          {
            id: 'seven-day',
            label: '7d',
            usedPercent: Number.NaN,
            remainingPercent: Number.NaN,
            resetsAt: null,
            windowDurationMinutes: 10080,
          },
        ],
        stale: true,
      }),
    ]);
    const rendered = renderSafeDashboard(model);
    expect(rendered).toContain('100% remaining');
    expect(rendered).toContain('Numeric usage is not available from this source.');
    expect(rendered).toContain('Stale / last known good');
    expect(rendered).not.toContain('email@example.com');
    expect(rendered).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(rendered).not.toContain('command:evil');
    expect(rendered).not.toContain('NaN');
  });

  it('normalizes unknown dashboard mode values to auto', () => {
    expect(dashboardModeFromConfiguration(undefined)).toBe('auto');
    expect(dashboardModeFromConfiguration('safe-native')).toBe('safe-native');
    expect(dashboardModeFromConfiguration('other')).toBe('auto');
  });

  it('renders summary, detailed, and hidden insight modes from the same typed snapshot', () => {
    const usageInsights = buildCodexUsageInsights({
      planType: 'pro',
      usage: {
        lifetimeTokens: 100,
        peakDailyTokens: 20,
        longestRunningTurnSec: 4,
        currentStreakDays: 2,
        longestStreakDays: 3,
        dailyUsageBuckets: [{ startDate: '2026-08-26', tokens: 10 }],
      },
      checkedAt: 1_900_000_000_000,
    });
    const withInsights = snapshot('codex', { usageInsights });
    const summary = renderSafeDashboard(
      buildSafeDashboardDocumentModel([withInsights], {
        now: 1_900_000_000_000,
        insightsMode: 'summary',
        language: 'en',
      }),
    );
    const detailed = renderSafeDashboard(
      buildSafeDashboardDocumentModel([withInsights], {
        now: 1_900_000_000_000,
        insightsMode: 'detailed',
        language: 'en',
      }),
    );
    const hidden = renderSafeDashboard(
      buildSafeDashboardDocumentModel([withInsights], {
        now: 1_900_000_000_000,
        insightsMode: 'hidden',
        language: 'en',
      }),
    );
    expect(summary).toContain('Usage insights');
    expect(summary).not.toContain('2026-08-26');
    expect(detailed).toContain('2026-08-26');
    expect(hidden).not.toContain('Usage insights');
    expect(hidden).toContain('90% remaining');
  });

  it('renders provenance in the Safe Dashboard without raw provider payload fields', () => {
    const usageInsights = buildCodexUsageInsights({
      usage: {
        lifetimeTokens: 1,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
        dailyUsageBuckets: [],
      },
      checkedAt: 1_900_000_000_000,
    });
    const rendered = renderSafeDashboard(
      buildSafeDashboardDocumentModel(
        [snapshot('codex', { usageInsights, metadata: { rawPayload: 'secret' } })],
        { now: 1_900_000_000_000, insightsMode: 'summary', language: 'en' },
      ),
    );
    expect(rendered).toContain('Official Codex App Server');
    expect(rendered).not.toContain('rawPayload');
    expect(rendered).not.toContain('secret');
  });
});
