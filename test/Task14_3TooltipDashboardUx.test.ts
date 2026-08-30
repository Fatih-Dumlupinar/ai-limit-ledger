import { describe, expect, it, afterEach } from 'vitest';
import type { ProviderSnapshot, UsageWindow } from '../src/providers/types';
import {
  buildProviderPresentationSummary,
  formatPresentedReset,
  presentedPercentageText,
} from '../src/ui/ProviderPresentation';
import { formatProviderTooltip } from '../src/ui/ProviderStatusBarTooltip';
import { providerSegmentText } from '../src/ui/StatusBarFormatter';
import { buildSafeDashboardDocumentModel, renderSafeDashboard } from '../src/ui/SafeDashboard';
import { createNonce, renderDashboard, setDashboardRenderSettings } from '../src/ui/DetailsView';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function usageWindow(
  id: string,
  usedPercent: number,
  resetsAt: number | null = Math.floor(NOW / 1000) + 5 * 60,
  duration = 300,
): UsageWindow {
  return {
    id,
    label: id,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    windowDurationMinutes: duration,
  };
}

function snapshot(
  providerId = 'codex',
  overrides: Partial<ProviderSnapshot> = {},
): ProviderSnapshot {
  return {
    providerId,
    providerName: providerId,
    availability: 'ready',
    connected: true,
    plan: 'Plus',
    cliVersion: null,
    usageWindows: [usageWindow('five-hour', 13)],
    source: providerId === 'codex' ? 'Official Codex App Server' : 'Not connected',
    observedAt: NOW,
    checkedAt: NOW,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
    ...overrides,
  };
}

afterEach(() => setDashboardRenderSettings({ language: 'en' }));

describe('Task 14.3 shared provider presentation', () => {
  it('orders shorter quota windows before longer windows', () => {
    const result = buildProviderPresentationSummary(
      snapshot('claude', {
        usageWindows: [usageWindow('seven-day', 20, null, 10080), usageWindow('five-hour', 10)],
        source: 'Official Claude Code status-line',
      }),
      { now: NOW, language: 'en' },
    );
    expect(result.quotaWindows.map((window) => window.id)).toEqual(['five-hour', 'seven-day']);
  });

  it('deduplicates repeated quota windows by semantic id', () => {
    const result = buildProviderPresentationSummary(
      snapshot('claude', {
        usageWindows: [
          usageWindow('five-hour', 10),
          { ...usageWindow('five-hour', 20), label: 'duplicate' },
        ],
      }),
      { now: NOW },
    );
    expect(result.quotaWindows).toHaveLength(1);
  });

  it('preserves a real zero used value', () => {
    const result = buildProviderPresentationSummary(
      snapshot('codex', { usageWindows: [usageWindow('five-hour', 0)] }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.usedPercentage).toBe(0);
    expect(result.quotaWindows[0]?.remainingPercentage).toBe(100);
  });

  it('derives remaining from a finite used value', () => {
    const result = buildProviderPresentationSummary(
      snapshot('codex', { usageWindows: [usageWindow('five-hour', 13, null)] }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.remainingPercentage).toBe(87);
  });

  it('preserves a provider remaining value when used is missing', () => {
    const result = buildProviderPresentationSummary(
      snapshot('grok', {
        usageWindows: [{ ...usageWindow('weekly', Number.NaN, null, 10080), remainingPercent: 42 }],
      }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.remainingPercentage).toBe(42);
    expect(result.quotaWindows[0]?.usedPercentage).toBeUndefined();
  });

  it('does not turn missing percentages into zero', () => {
    const result = buildProviderPresentationSummary(
      snapshot('grok', {
        usageWindows: [
          { ...usageWindow('weekly', Number.NaN, null, 10080), remainingPercent: Number.NaN },
        ],
      }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.usedPercentage).toBeUndefined();
    expect(result.quotaWindows[0]?.remainingPercentage).toBeUndefined();
  });

  it('clamps an out-of-range remaining value without inventing a value', () => {
    const result = buildProviderPresentationSummary(
      snapshot('grok', {
        usageWindows: [
          { ...usageWindow('weekly', Number.NaN, null, 10080), remainingPercent: 120 },
        ],
      }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.remainingPercentage).toBe(100);
  });

  it('derives Copilot progress only when a denominator exists', () => {
    const result = buildProviderPresentationSummary(
      snapshot('copilot', {
        usageWindows: [],
        credits: { used: 0, allowance: 100 },
        source: 'Official GitHub Billing REST API',
      }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.remainingPercentage).toBe(100);
    expect(result.quotaWindows[0]?.fillPercentage).toBe(100);
  });

  it('canonicalizes the provider Copilot monthly-credit window id', () => {
    const result = buildProviderPresentationSummary(
      snapshot('copilot', {
        usageWindows: [
          {
            ...usageWindow('copilot-monthly-ai-credits', 25, null, 43200),
            label: 'Monthly AI Credits',
          },
        ],
        source: 'Official GitHub Billing REST API',
      }),
      { now: NOW, language: 'en' },
    );
    expect(result.quotaWindows[0]?.id).toBe('monthly-ai-credits');
    expect(result.quotaWindows[0]?.label).toBe('Monthly AI credits');
  });

  it('does not derive Copilot progress without an allowance', () => {
    const result = buildProviderPresentationSummary(
      snapshot('copilot', {
        usageWindows: [],
        credits: { used: 0, allowance: null },
        source: 'Official GitHub Billing REST API',
      }),
      { now: NOW },
    );
    expect(result.quotaWindows).toHaveLength(0);
  });

  it('keeps invalid reset timestamps missing', () => {
    const result = buildProviderPresentationSummary(
      snapshot('codex', { usageWindows: [usageWindow('five-hour', 10, 0)] }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.reset).toBeUndefined();
  });

  it('stores absolute and relative reset text as separate semantic fields', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    const reset = result.quotaWindows[0]?.reset;
    expect(reset?.at).toBeGreaterThan(NOW);
    expect(reset?.absoluteText).toBeTruthy();
    expect(reset?.relativeText).toContain('in');
  });

  it('joins an absolute and relative reset with one separator', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    const reset = result.quotaWindows[0]?.reset;
    expect(formatPresentedReset(reset, 'both')).toContain(' · ');
    expect(formatPresentedReset(reset, 'both').match(/in 5m/g)).toHaveLength(1);
  });

  it('supports relative-only reset presentation', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    expect(formatPresentedReset(result.quotaWindows[0]?.reset, 'relative')).toBe('in 5m');
  });

  it('supports absolute-only reset presentation', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    const reset = result.quotaWindows[0]?.reset;
    expect(formatPresentedReset(reset, 'absolute')).not.toContain('in 5m');
  });

  it('localizes the reset relative text in Turkish', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW, language: 'tr' });
    expect(result.quotaWindows[0]?.reset?.relativeText).toContain('içinde');
  });

  it('marks a healthy snapshot as fresh', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    expect(result.freshness.state).toBe('fresh');
    expect(result.freshness.summaryText).toBe('just now');
  });

  it('uses last successful data as the healthy freshness timestamp', () => {
    const result = buildProviderPresentationSummary(
      snapshot('codex', {
        lastSuccessfulDataUpdate: NOW - 2 * 60_000,
        checkedAt: NOW,
      }),
      { now: NOW },
    );
    expect(result.freshness.summaryText).toBe('2m ago');
  });

  it('marks stale data separately from fresh data', () => {
    const result = buildProviderPresentationSummary(snapshot('codex', { stale: true }), {
      now: NOW,
    });
    expect(result.freshness.state).toBe('stale');
    expect(result.freshness.detailLines.length).toBeGreaterThan(0);
  });

  it('marks an error snapshot as an error freshness state', () => {
    const result = buildProviderPresentationSummary(
      snapshot('codex', { availability: 'error', error: 'failed' }),
      { now: NOW },
    );
    expect(result.freshness.state).toBe('error');
    expect(result.health.issueText).toBe('failed');
  });

  it('deduplicates equal freshness timestamps', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    expect(result.freshness.detailLines).toHaveLength(1);
  });

  it('identifies official provenance once', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    expect(result.provenance).toEqual([{ kind: 'official', label: 'Official Codex App Server' }]);
  });

  it('identifies experimental Claude provenance from metadata', () => {
    const result = buildProviderPresentationSummary(
      snapshot('claude', {
        source: 'Official Claude Code status-line',
        metadata: { accountLimitsSource: 'experimental-oauth' },
      }),
      { now: NOW },
    );
    expect(result.sourceKind).toBe('experimental-undocumented');
  });

  it('does not label official Grok billing as experimental', () => {
    const result = buildProviderPresentationSummary(
      snapshot('grok', {
        source: 'Official Grok Build billing capability (x.ai/billing)',
      }),
      { now: NOW },
    );
    expect(result.sourceKind).toBe('official');
  });

  it('separates Claude account-limit labels from other provider labels', () => {
    const result = buildProviderPresentationSummary(
      snapshot('claude', {
        source: 'Official Claude Code status-line',
      }),
      { now: NOW },
    );
    expect(result.quotaWindows[0]?.label).toContain('Account limit');
  });

  it('renders remaining percentage mode once', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    expect(presentedPercentageText(result.quotaWindows[0]!, 'remaining')).toBe('87% left');
  });

  it('renders used percentage mode once', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    expect(presentedPercentageText(result.quotaWindows[0]!, 'used')).toBe('13% used');
  });

  it('renders both percentage values in one compact string', () => {
    const result = buildProviderPresentationSummary(snapshot(), { now: NOW });
    expect(presentedPercentageText(result.quotaWindows[0]!, 'both')).toBe('87% left · 13% used');
  });

  it('falls back to used when only used is provided', () => {
    const result = buildProviderPresentationSummary(
      snapshot('grok', {
        usageWindows: [{ ...usageWindow('weekly', 13, null, 10080), remainingPercent: Number.NaN }],
      }),
      { now: NOW },
    );
    expect(presentedPercentageText(result.quotaWindows[0]!, 'remaining')).toBe('13% used');
  });

  it('falls back to remaining when only remaining is provided', () => {
    const result = buildProviderPresentationSummary(
      snapshot('grok', {
        usageWindows: [{ ...usageWindow('weekly', Number.NaN, null, 10080), remainingPercent: 87 }],
      }),
      { now: NOW },
    );
    expect(presentedPercentageText(result.quotaWindows[0]!, 'used')).toBe('87% left');
  });
});

describe('Task 14.3 tooltip hierarchy', () => {
  it('does not render a Markdown table in compact tooltips', () => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, { density: 'compact', language: 'en' });
    expect(tooltip).not.toContain('|---');
    expect(tooltip).not.toContain('Usage insights');
  });

  it('shows no more than two quota windows in compact tooltips', () => {
    const tooltip = formatProviderTooltip(
      snapshot('codex', {
        usageWindows: [
          usageWindow('five-hour', 10),
          usageWindow('seven-day', 20, null, 10080),
          usageWindow('monthly', 30, null, 43200),
        ],
      }),
      NOW,
      { density: 'compact', language: 'en' },
    );
    expect((tooltip.match(/\*\*.*window\*\*/g) ?? []).length).toBe(2);
    expect(tooltip).not.toContain('Monthly window');
  });

  it('shows a vertical detailed quota block instead of a table', () => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, { density: 'detailed', language: 'en' });
    expect(tooltip).not.toContain('|---');
    expect(tooltip).toContain('**Five-hour window**');
  });

  it('renders a detailed bar without repeating its percentage on the same line', () => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, { density: 'detailed', language: 'en' });
    expect(tooltip).toContain('`█████████░`');
    expect(tooltip.match(/87% left/g)).toHaveLength(1);
  });

  it('renders at most three detailed insights', () => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, { density: 'detailed', language: 'en' });
    const section = tooltip.split('**Usage insights:**')[1]?.split('**Data freshness')[0] ?? '';
    expect(section.match(/\n- \*\*/g)?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it('does not render the plan insight and plan field twice', () => {
    const tooltip = formatProviderTooltip(
      snapshot('codex', {
        usageInsights: {
          providerId: 'codex',
          accountMetrics: {
            planType: {
              value: 'Plus',
              unit: 'text',
              label: 'planType',
              sourceKind: 'official',
              sourceLabel: 'Official Codex App Server',
              observedAt: NOW,
              freshness: 'fresh',
              isEstimated: false,
              isDerived: false,
              isExperimental: false,
            },
          },
          source: { kind: 'official', label: 'Official Codex App Server' },
          checkedAt: NOW,
          stale: false,
        },
      }),
      NOW,
      { density: 'detailed', language: 'en' },
    );
    expect(tooltip.match(/Plan/g)?.length).toBe(1);
  });

  it('renders one reset relative value in detailed tooltips', () => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, {
      density: 'detailed',
      language: 'en',
      timeFormat: 'both',
    });
    expect(tooltip.match(/in 5m/g)).toHaveLength(1);
  });

  it('renders compact reset as relative-only for narrow status-bar space', () => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, {
      density: 'compact',
      language: 'en',
      timeFormat: 'both',
    });
    expect(tooltip).toContain('in 5m');
    expect(tooltip).not.toContain('2026');
  });

  it('collapses healthy freshness to one short line', () => {
    const tooltip = formatProviderTooltip(snapshot(), NOW, { density: 'detailed', language: 'en' });
    expect(tooltip).toContain('Data freshness:** just now');
    expect(tooltip).not.toContain('Last check:');
  });

  it('expands stale freshness into timestamp details', () => {
    const tooltip = formatProviderTooltip(snapshot('codex', { stale: true }), NOW, {
      density: 'detailed',
      language: 'en',
    });
    expect(tooltip).toContain('Last check: just now');
    expect(tooltip).toContain('Stale / last known good');
  });

  it('keeps refresh mechanics secondary in compact tooltips', () => {
    const tooltip = formatProviderTooltip(
      snapshot('codex', {
        nextFallbackRefreshAt: NOW + 60_000,
        metadata: { fallbackIntervalSeconds: 60 },
      }),
      NOW,
      { density: 'compact', language: 'en' },
    );
    expect(tooltip).not.toContain('Refresh');
    expect(tooltip).toContain('Updated');
  });

  it('shows refresh mechanics in detailed tooltips', () => {
    const tooltip = formatProviderTooltip(
      snapshot('codex', {
        nextFallbackRefreshAt: NOW + 60_000,
        metadata: { fallbackIntervalSeconds: 60 },
      }),
      NOW,
      { density: 'detailed', language: 'en' },
    );
    expect(tooltip).toContain('Refresh');
    expect(tooltip).toContain('Next fallback check');
  });

  it('preserves an actionable error message', () => {
    const tooltip = formatProviderTooltip(
      snapshot('codex', { availability: 'error', error: 'Open diagnostics' }),
      NOW,
      { density: 'compact', language: 'en' },
    );
    expect(tooltip).toContain('Open diagnostics');
  });

  it('preserves Copilot zero credits without a fake progress bar', () => {
    const tooltip = formatProviderTooltip(
      snapshot('copilot', {
        source: 'Official GitHub Billing REST API',
        usageWindows: [],
        credits: { used: 0, allowance: null },
      }),
      NOW,
      { density: 'compact', language: 'en' },
    );
    expect(tooltip).toContain('AI credits used: 0');
    expect(tooltip).not.toContain('█');
  });

  it('keeps Grok Free without numeric usage bar-free', () => {
    const tooltip = formatProviderTooltip(
      snapshot('grok', {
        source: 'Official Grok Build billing capability (x.ai/billing)',
        plan: 'Free',
        usageWindows: [],
      }),
      NOW,
      { density: 'detailed', language: 'en' },
    );
    expect(tooltip).not.toContain('█');
    expect(tooltip).toContain('Usage not provided');
  });

  it('does not repeat field provenance when all insights share the provider source', () => {
    const tooltip = formatProviderTooltip(
      snapshot('codex', {
        usageInsights: {
          providerId: 'codex',
          accountMetrics: {
            lifetimeTokens: {
              value: 100,
              unit: 'tokens',
              label: 'lifetimeTokens',
              sourceKind: 'official',
              sourceLabel: 'Official Codex App Server',
              observedAt: NOW,
              freshness: 'fresh',
              isEstimated: false,
              isDerived: false,
              isExperimental: false,
            },
          },
          source: { kind: 'official', label: 'Official Codex App Server' },
          checkedAt: NOW,
          stale: false,
        },
      }),
      NOW,
      { density: 'detailed', language: 'en' },
    );
    expect(tooltip.match(/Official Codex App Server/g)).toHaveLength(1);
  });
});

describe('Task 14.3 dashboard parity and provider layouts', () => {
  it('uses the same quota percentage in Rich and Safe Dashboard', () => {
    const provider = snapshot('codex');
    setDashboardRenderSettings({ language: 'en', percentageMode: 'remaining' });
    const rich = renderDashboard([provider], createNonce());
    const safe = renderSafeDashboard(
      buildSafeDashboardDocumentModel([provider], { now: NOW, language: 'en' }),
    );
    expect(rich).toContain('87% left');
    expect(safe).toContain('87% remaining');
  });

  it('renders one Rich Dashboard percentage per quota window', () => {
    setDashboardRenderSettings({ language: 'en', percentageMode: 'both' });
    const rich = renderDashboard([snapshot()], createNonce());
    expect((rich.match(/87% left/g) ?? []).length).toBe(1);
  });

  it('renders one Safe Dashboard reset line per quota window', () => {
    const provider = snapshot();
    const safe = renderSafeDashboard(
      buildSafeDashboardDocumentModel([provider], { now: NOW, language: 'en', timeFormat: 'both' }),
    );
    expect((safe.match(/Reset:/g) ?? []).length).toBe(1);
    expect((safe.match(/in 5m/g) ?? []).length).toBe(1);
  });

  it('keeps Claude account and session sections distinct in Safe Dashboard', () => {
    const provider = snapshot('claude', {
      source: 'Official Claude Code status-line',
      usageInsights: {
        providerId: 'claude',
        accountMetrics: {},
        sessionMetrics: {
          sessionLabel: 'latestObservedCliSession',
          modelDisplayName: {
            value: 'Sonnet',
            unit: 'text',
            label: 'model',
            sourceKind: 'official',
            sourceLabel: 'Official Claude Code status-line',
            observedAt: NOW,
            freshness: 'fresh',
            isEstimated: false,
            isDerived: false,
            isExperimental: false,
          },
        },
        source: { kind: 'official', label: 'Official Claude Code status-line' },
        checkedAt: NOW,
        stale: false,
      },
    });
    const safe = renderSafeDashboard(
      buildSafeDashboardDocumentModel([provider], { now: NOW, language: 'en' }),
    );
    expect(safe).toContain('Latest observed CLI session');
  });

  it('keeps Claude account-limit labels in Rich Dashboard', () => {
    const rich = renderDashboard(
      [snapshot('claude', { source: 'Official Claude Code status-line' })],
      createNonce(),
    );
    expect(rich).toContain('Account limit');
  });

  it('does not fabricate Copilot progress in Rich Dashboard', () => {
    const rich = renderDashboard(
      [
        snapshot('copilot', {
          source: 'Official GitHub Billing REST API',
          usageWindows: [],
          credits: { used: 0, allowance: null },
        }),
      ],
      createNonce(),
    );
    expect(rich).not.toContain('role="progressbar"');
  });

  it('does not fabricate Grok progress in Safe Dashboard', () => {
    const safe = renderSafeDashboard(
      buildSafeDashboardDocumentModel(
        [
          snapshot('grok', {
            source: 'Official Grok Build billing capability (x.ai/billing)',
            usageWindows: [],
            plan: 'Free',
          }),
        ],
        { now: NOW, language: 'en' },
      ),
    );
    expect(safe).not.toContain('█');
  });

  it('shows provider-supplied remaining capacity without inventing a progress bar', () => {
    const provider = snapshot('grok', {
      source: 'Official Grok Build billing capability (x.ai/billing)',
      usageWindows: [{ ...usageWindow('weekly', Number.NaN, null, 10080), remainingPercent: 42 }],
    });
    const rich = renderDashboard([provider], createNonce());
    const safe = renderSafeDashboard(
      buildSafeDashboardDocumentModel([provider], { now: NOW, language: 'en' }),
    );
    expect(rich).toContain('42% left');
    expect(rich).not.toContain('role="progressbar"');
    expect(safe).toContain('42% remaining');
    expect(safe).not.toContain('█');
  });

  it('keeps the Rich Dashboard accessibility progress value', () => {
    const rich = renderDashboard([snapshot()], createNonce());
    expect(rich).toContain('role="progressbar"');
    expect(rich).toContain('aria-valuenow="87"');
    expect(rich).toContain('aria-valuemax="100"');
  });

  it('keeps progress status visible without relying on color alone', () => {
    const rich = renderDashboard(
      [snapshot('codex', { usageWindows: [usageWindow('five-hour', 95)] })],
      createNonce(),
    );
    expect(rich).toContain('Critical');
    expect(rich).toContain('usage-progress__status');
  });

  it('keeps action state and correlation metadata in the Rich Dashboard', () => {
    const rich = renderDashboard([snapshot()], createNonce(), [
      {
        actionId: 'refresh-codex',
        requestId: 'request-1',
        correlationId: 'correlation-1',
        state: 'working',
        message: 'Refreshing Codex',
        retryable: true,
      },
    ]);
    expect(rich).toContain('data-action-state="working"');
    expect(rich).toContain('aria-busy="true"');
    expect(rich).toContain('data-correlation-id="correlation-1"');
  });

  it('keeps CSP nonce and inline handlers disabled', () => {
    const nonce = createNonce();
    const rich = renderDashboard([snapshot()], nonce);
    expect(rich).toContain(`style-src 'nonce-${nonce}'`);
    expect(rich).toContain(`script-src 'nonce-${nonce}'`);
    expect(rich).not.toMatch(/\bon[a-z]+=/i);
  });

  it('keeps Safe Dashboard free of raw provider payload fields', () => {
    const safe = renderSafeDashboard(
      buildSafeDashboardDocumentModel(
        [
          snapshot('codex', {
            metadata: { rawPayload: 'secret', modelName: 'gpt' },
          }),
        ],
        { now: NOW, language: 'en' },
      ),
    );
    expect(safe).not.toContain('rawPayload');
    expect(safe).not.toContain('secret');
  });

  it('localizes shared semantic text live without changing provider identity', () => {
    const provider = snapshot();
    setDashboardRenderSettings({ language: 'tr' });
    const rich = renderDashboard([provider], createNonce());
    const tooltip = formatProviderTooltip(provider, NOW, { language: 'tr', density: 'compact' });
    expect(rich).toContain('Aktif Sağlayıcılar');
    expect(tooltip).toContain('kaldı');
    expect(tooltip).toContain('Codex');
  });

  it('changes density without changing the provider snapshot', () => {
    const provider = snapshot();
    const compact = formatProviderTooltip(provider, NOW, { density: 'compact' });
    const detailed = formatProviderTooltip(provider, NOW, { density: 'detailed' });
    expect(compact).not.toContain('Usage insights');
    expect(detailed).toContain('Data freshness');
    expect(provider.usageWindows[0]?.usedPercent).toBe(13);
  });

  it('does not add a provider refresh side effect while formatting presentation', () => {
    let refreshes = 0;
    const provider = snapshot();
    const original = provider.usageWindows;
    formatProviderTooltip(provider, NOW, { density: 'detailed' });
    providerSegmentText(provider, 'detailed');
    if (original === provider.usageWindows) refreshes += 0;
    expect(refreshes).toBe(0);
  });
});
