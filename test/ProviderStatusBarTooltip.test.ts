import { describe, expect, it } from 'vitest';
import { formatProviderTooltip } from '../src/ui/ProviderStatusBarTooltip';
import type { ProviderSnapshot } from '../src/providers/types';
import { buildCodexUsageInsights } from '../src/providers/UsageInsights';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function base(providerId: string, overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId,
    providerName: providerId,
    availability: 'ready',
    connected: true,
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Not connected',
    observedAt: NOW,
    checkedAt: NOW,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
    ...overrides,
  };
}

function window(
  id: string,
  label: string,
  usedPercent: number,
  resetsAt: number | null,
  duration: number,
) {
  return {
    id,
    label,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    windowDurationMinutes: duration,
  };
}

describe('ProviderStatusBarTooltip', () => {
  it('keeps Codex usage, reset countdown, freshness and fallback check distinct', () => {
    const tooltip = formatProviderTooltip(
      base('codex', {
        usageWindows: [window('primary', 'Primary', 14, Math.floor(NOW / 1000) + 5 * 86400, 300)],
        lastSuccessfulDataUpdate: NOW,
        lastProviderEventAt: NOW - 14_000,
        nextFallbackRefreshAt: NOW + 38_000,
        metadata: { fallbackIntervalSeconds: 60 },
      }),
      NOW,
    );

    expect(tooltip).toContain('86% left');
    expect(tooltip).toContain('14% used');
    expect(tooltip).toContain('█████████░');
    expect(tooltip).toContain('`█████████░` 86% left · 14% used');
    expect(tooltip).toContain('Next fallback check: in 38s');
    expect(tooltip).toContain('Last provider event: just now');
    expect(tooltip).toContain('Resets');
    expect(tooltip).toContain('in 5d');
    expect(tooltip).not.toContain('Next refresh:');
  });

  it('renders separate Claude 5-hour and 7-day rows and marks experimental source safely', () => {
    const tooltip = formatProviderTooltip(
      base('claude', {
        providerName: 'untrusted [name](command:evil)',
        usageWindows: [
          window('seven-day', '7d', 27, Math.floor(NOW / 1000) + 4 * 86400, 10080),
          window('five-hour', '5h', 15, Math.floor(NOW / 1000) + 3 * 3600, 300),
        ],
        source: 'Experimental — undocumented Anthropic usage endpoint',
        metadata: {
          accountLimitsSource: 'experimental-oauth',
          oauthNextEligibleAt: NOW + 82_000,
          oauthRefreshSeconds: 120,
          modelName: 'model [x](command:evil)',
        },
      }),
      NOW,
    );

    expect(tooltip.indexOf('5h')).toBeLessThan(tooltip.indexOf('7d'));
    expect(tooltip).toContain('Experimental Claude OAuth usage');
    expect(tooltip).toContain('Next automatic check: in 1m 22s');
    expect(tooltip).toContain('model \\[x\\]\\(command:evil\\)');
    expect(tooltip).not.toContain('untrusted [name]');
  });

  it('preserves Copilot zero and does not fabricate percentages for missing Grok usage', () => {
    const copilot = formatProviderTooltip(
      base('copilot', {
        credits: { used: 0, allowance: null, remaining: null },
        metadata: { nextRefreshAt: NOW + 180_000, refreshIntervalSeconds: 300 },
      }),
      NOW,
    );
    const grok = formatProviderTooltip(
      base('grok', {
        usageWindows: [
          {
            ...window('weekly', 'Weekly', Number.NaN, null, 10080),
            remainingPercent: Number.NaN,
          },
        ],
        metadata: { nextRefreshAt: NOW + 180_000 },
      }),
      NOW,
    );

    expect(copilot).toContain('AI credits used: 0');
    expect(copilot).not.toContain('NaN');
    expect(grok).toContain('Usage not provided');
    expect(grok).not.toContain('NaN%');
  });

  it('rejects invalid reset timestamps and sensitive dynamic values', () => {
    const tooltip = formatProviderTooltip(
      base('codex', {
        plan: 'C:\\Users\\fixture\\secret',
        usageWindows: [window('bad', 'bad|window', 0, 0, 300)],
        metadata: { modelName: 'account@example.com 123e4567-e89b-12d3-a456-426614174000' },
      }),
      NOW,
    );

    expect(tooltip).toContain('0% used');
    expect(tooltip).toContain('Not provided');
    expect(tooltip).not.toContain('1970');
    expect(tooltip).not.toContain('C:\\Users');
    expect(tooltip).not.toContain('account@example.com');
    expect(tooltip).not.toContain('123e4567-e89b-12d3-a456-426614174000');
  });

  it('marks stale/backoff state with text and never uses a negative countdown', () => {
    const tooltip = formatProviderTooltip(
      base('grok', {
        availability: 'rate-limited',
        stale: true,
        retryAt: NOW + 8 * 60_000,
        usageWindows: [window('weekly', 'Weekly', 25, Math.floor(NOW / 1000) - 60, 10080)],
      }),
      NOW,
    );

    expect(tooltip).toContain('Retry paused until');
    expect(tooltip).toContain('in 8m');
    expect(tooltip).toContain('Stale / last known good');
    expect(tooltip).not.toContain('in -');
  });

  it('adds at most three typed insights to detailed tooltips and leaves compact mode unchanged', () => {
    const usageInsights = buildCodexUsageInsights({
      usage: {
        lifetimeTokens: 100,
        peakDailyTokens: 20,
        longestRunningTurnSec: 4,
        currentStreakDays: 2,
        longestStreakDays: 3,
        dailyUsageBuckets: [],
      },
      checkedAt: NOW,
    });
    const snapshot = base('codex', { usageInsights });
    const detailed = formatProviderTooltip(snapshot, NOW, { density: 'detailed', language: 'en' });
    const section = detailed.split('**Usage insights:**')[1]?.split('**Data freshness**')[0] ?? '';
    expect(section.match(/\n- \*\*/g)).toHaveLength(3);
    expect(
      formatProviderTooltip(snapshot, NOW, { density: 'compact', language: 'en' }),
    ).not.toContain('Usage insights');
  });
});
