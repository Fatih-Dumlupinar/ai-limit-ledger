import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSnapshot } from '../src/providers/types';
import { LocalizationService, localization } from '../src/localization/LocalizationService';
import { setDashboardRenderSettings, renderDashboard } from '../src/ui/DetailsView';
import {
  buildSafeDashboardDocumentModel,
  SafeDashboardContentProvider,
  renderSafeDashboard,
} from '../src/ui/SafeDashboard';
import { providerSegmentText } from '../src/ui/StatusBarFormatter';
import { formatProviderTooltip } from '../src/ui/ProviderStatusBarTooltip';
import { safeActionMessage } from '../src/infrastructure/SafeErrorPresenter';
import { DashboardActionRunner } from '../src/ui/DashboardActionRunner';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function snapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: 'codex',
    providerName: 'Codex',
    availability: 'ready',
    connected: true,
    plan: 'Plus',
    cliVersion: '1.0.0',
    usageWindows: [
      {
        id: 'five-hour',
        label: '5h',
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: Math.floor(NOW / 1000) + 300,
        windowDurationMinutes: 300,
      },
    ],
    source: 'Official Codex App Server',
    observedAt: NOW,
    checkedAt: NOW,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
    ...overrides,
  };
}

afterEach(() => {
  setDashboardRenderSettings({ language: 'en' });
  localization.setLanguage('en', 'en-US');
  vi.useRealTimers();
});

describe('live runtime localization surfaces', () => {
  it('renders the Rich Dashboard from the same cached snapshot in English and Turkish', () => {
    setDashboardRenderSettings({ language: 'en' });
    const english = renderDashboard([snapshot()], 'nonce');
    setDashboardRenderSettings({ language: 'tr' });
    const turkish = renderDashboard([snapshot()], 'nonce');
    expect(english).toContain('Active Providers');
    expect(turkish).toContain('Aktif Sağlayıcılar');
    expect(turkish).toContain('Codex');
    expect(turkish).not.toContain('Active Providers');
  });

  it('renders Safe Native with the same semantic state as Rich Dashboard', () => {
    const model = buildSafeDashboardDocumentModel([snapshot()], { now: NOW, language: 'tr' });
    const safe = renderSafeDashboard(model);
    setDashboardRenderSettings({ language: 'tr' });
    const rich = renderDashboard([snapshot()], 'nonce');
    expect(safe).toContain('Aktif Sağlayıcılar');
    expect(safe).toContain('Hazır');
    expect(rich).toContain('Hazır');
    expect(rich).toContain('kaldı');
  });

  it('re-renders status-bar text without changing provider names or snapshots', () => {
    const cached = snapshot({ availability: 'rate-limited', stale: true, usageWindows: [] });
    const english = providerSegmentText(cached, 'detailed', { language: 'en' });
    const turkish = providerSegmentText(cached, 'detailed', { language: 'tr' });
    expect(english).toContain('Codex');
    expect(english).toContain('rate limited');
    expect(turkish).toContain('Codex');
    expect(turkish).toContain('hız sınırına ulaşıldı');
    expect(cached.usageWindows).toHaveLength(0);
  });

  it.each([
    ['compact', 'kullanılan'],
    ['detailed', 'Son kontrol'],
  ] as const)('rebuilds the %s tooltip from cached data in Turkish', (density, expected) => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, { language: 'tr', density });
    expect(tooltip).toContain(expected);
    expect(tooltip).toContain('Codex');
    expect(tooltip).not.toContain('<script');
  });

  it('localizes notifications while preserving provider and action context', () => {
    localization.setLanguage('en', 'en-US');
    const english = safeActionMessage({
      providerName: 'Codex',
      action: 'refresh',
      category: 'rate-limited',
    });
    localization.setLanguage('tr', 'en-US');
    const turkish = safeActionMessage({
      providerName: 'Codex',
      action: 'refresh',
      category: 'rate-limited',
    });
    expect(english).toContain('rate limited');
    expect(turkish).toContain('hız sınırına');
    expect(turkish).toContain('Codex');
  });

  it('fires the Safe Dashboard content change event without fetching', () => {
    let sourceReads = 0;
    const provider = new SafeDashboardContentProvider(() => {
      sourceReads += 1;
      return buildSafeDashboardDocumentModel([snapshot()], { language: localization.language });
    });
    const changed: string[] = [];
    provider.onDidChange((uri) => changed.push(uri.toString()));
    provider.refresh();
    expect(changed).toEqual(['ai-limit-ledger:/dashboard.md']);
    expect(sourceReads).toBe(0);
    provider.provideTextDocumentContent({} as never);
    expect(sourceReads).toBe(1);
    provider.dispose();
  });

  it('changes the singleton runtime language once and does not start a timer', () => {
    const service = new LocalizationService('en', 'en-US');
    const events: string[] = [];
    service.onDidChange((event) => events.push(`${event.previousLanguage}->${event.language}`));
    expect(service.setLanguage('tr', 'en-US')).toBe(true);
    expect(service.setLanguage('tr', 'en-US')).toBe(false);
    expect(events).toEqual(['en->tr']);
    service.dispose();
  });

  it('keeps an action request and correlation id while translating its working/result state', async () => {
    let finish!: (value: unknown) => void;
    const execution = new Promise<unknown>((resolve) => (finish = resolve));
    const runner = new DashboardActionRunner({
      logger: {
        createCorrelationId: () => 'correlation-1',
        logRecord: () => undefined,
        redact: (value) => value,
      },
      execute: async () => execution,
    });
    localization.setLanguage('en', 'en-US');
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'request-1',
      actionId: 'refresh-all',
    });
    await Promise.resolve();
    const working = runner.getActionStates()[0];
    expect(working?.state).toBe('working');
    expect(working?.message).toBe('Refreshing…');
    localization.setLanguage('tr', 'en-US');
    const translated = runner.getActionStates()[0];
    expect(translated?.message).toBe('Yenileniyor…');
    expect(translated?.requestId).toBe('request-1');
    expect(translated?.correlationId).toBe('correlation-1');
    finish({ status: 'success' });
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.getActionStates()[0]?.message).toBe('Güncellendi');
    runner.dispose();
  });
});
