import { describe, expect, it } from 'vitest';
import {
  buildClaudeUsageInsights,
  buildCodexUsageInsights,
  buildCopilotEntitlementInsights,
  buildCopilotOrganizationInsights,
  buildCopilotUsageInsights,
  buildGrokUsageInsights,
  insightsFromSnapshot,
  isSafeMetricNumber,
  isSafeTimestamp,
  makeArrayInsight,
  makeInsight,
  mergeUsageInsights,
  normalizeDailyTokenUsage,
  type ProviderUsageInsights,
  type UsageInsightSource,
} from '../src/providers/UsageInsights';
import { parseUsage, parseRateLimits } from '../src/limits/RateLimitParser';
import { parseClaudeStatusLine } from '../src/providers/ClaudeStatusLine';
import { parseCopilotEntitlement } from '../src/providers/copilot/experimental/CopilotEntitlementTransport';
import { parseCopilotUsage } from '../src/providers/copilot/CopilotUsageParser';
import { parseGrokBilling } from '../src/providers/grok/GrokUsageParser';
import { normalizeSettings } from '../src/configuration/EffectiveSettings';
import { SETTING_KEYS } from '../src/configuration/SettingsKeys';
import type { ProviderSnapshot } from '../src/providers/types';
import type { CopilotUsageSummary } from '../src/providers/copilot/types';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const official: UsageInsightSource = { kind: 'official', label: 'Official test source' };
const experimental: UsageInsightSource = {
  kind: 'experimental-undocumented',
  label: 'Experimental test source',
};

function insight<T>(value: T, unit: Parameters<typeof makeInsight>[1], label = 'test') {
  return makeInsight<T>(value, unit, label, official, NOW)!;
}

function codexUsage() {
  return {
    lifetimeTokens: 1000,
    peakDailyTokens: 200,
    longestRunningTurnSec: 30,
    currentStreakDays: 2,
    longestStreakDays: 5,
    dailyUsageBuckets: [
      { startDate: '2026-08-25', tokens: 100 },
      { startDate: '2026-08-26', tokens: 120 },
    ],
  };
}

function claudeSnapshot(): ProviderSnapshot {
  return {
    providerId: 'claude',
    providerName: 'Claude Code',
    availability: 'ready',
    connected: true,
    plan: null,
    cliVersion: '2.1.241',
    usageWindows: [
      {
        id: 'five-hour',
        label: '5h',
        usedPercent: 40,
        remainingPercent: 60,
        resetsAt: 1_800_000_000,
        windowDurationMinutes: 300,
      },
    ],
    source: 'Official Claude Code status-line',
    observedAt: NOW,
    checkedAt: NOW,
    sourceUpdatedAt: NOW,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: true },
    tokens: {
      contextWindowSize: 200_000,
      contextUsedPercent: 30,
      contextRemainingPercent: 70,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 25,
      totalCostUsd: 1.25,
      totalDurationMs: 4000,
      totalApiDurationMs: 2500,
      totalLinesAdded: 12,
      totalLinesRemoved: 3,
    },
    metadata: {
      modelId: 'claude-sonnet-test',
      modelName: 'Sonnet Test',
      version: '2.1.241',
      fastMode: false,
      effort: 'high',
      thinking: true,
      exceeds200kTokens: false,
      outputStyle: 'default',
    },
  };
}

function copilotSummary(overrides: Partial<CopilotUsageSummary> = {}): CopilotUsageSummary {
  return {
    timePeriod: '2026-08',
    usedCredits: 20,
    includedCredits: 10,
    additionalCredits: 10,
    cost: 2,
    modelBreakdown: [{ model: 'gpt-test', quantity: 20, cost: 2 }],
    nextResetAt: NOW + 86_400_000,
    credits: { used: 20, allowance: null, remaining: null },
    ...overrides,
  };
}

describe('Task 8 typed usage insights safety contract', () => {
  it('accepts finite non-negative metrics only', () => {
    expect(isSafeMetricNumber(0)).toBe(true);
    expect(isSafeMetricNumber(Number.NaN)).toBe(false);
    expect(isSafeMetricNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeMetricNumber(-1)).toBe(false);
  });

  it('accepts plausible timestamps and rejects zero or infinity', () => {
    expect(isSafeTimestamp(NOW)).toBe(true);
    expect(isSafeTimestamp(0)).toBe(false);
    expect(isSafeTimestamp(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('preserves a real zero value', () => {
    expect(insight(0, 'credits').value).toBe(0);
  });

  it('preserves false instead of treating it as absent', () => {
    expect(insight(false, 'boolean').value).toBe(false);
  });

  it('rejects negative, non-finite, empty, and invalid-timestamp scalar values', () => {
    expect(makeInsight(-1, 'tokens', 'x', official, NOW)).toBeUndefined();
    expect(makeInsight(Number.NaN, 'tokens', 'x', official, NOW)).toBeUndefined();
    expect(makeInsight('', 'text', 'x', official, NOW)).toBeUndefined();
    expect(makeInsight(1, 'tokens', 'x', official, 0)).toBeUndefined();
  });

  it('retains source provenance and experimental classification', () => {
    const value = makeInsight(1, 'count', 'x', experimental, NOW)!;
    expect(value.sourceKind).toBe('experimental-undocumented');
    expect(value.sourceLabel).toContain('Experimental');
    expect(value.isExperimental).toBe(true);
  });

  it('supports derived and user-configured source classifications', () => {
    const derived = makeInsight(
      2,
      'credits',
      'x',
      { kind: 'derived', label: 'Derived' },
      NOW,
      false,
      { isDerived: true },
    )!;
    const configured = makeInsight(
      3,
      'credits',
      'x',
      { kind: 'user-configured', label: 'Configured' },
      NOW,
    )!;
    expect(derived.isDerived).toBe(true);
    expect(configured.sourceKind).toBe('user-configured');
  });

  it('marks stale values as stale freshness', () => {
    expect(makeInsight(1, 'count', 'x', official, NOW, true)!.freshness).toBe('stale');
  });

  it('validates calendar dates strictly', () => {
    const valid = normalizeDailyTokenUsage([{ startDate: '2026-02-28', tokens: 1 }]);
    const invalid = normalizeDailyTokenUsage([{ startDate: '2026-02-30', tokens: 1 }]);
    expect(valid).toHaveLength(1);
    expect(invalid).toEqual([]);
  });

  it('creates validated arrays without losing zero entries', () => {
    const values = makeArrayInsight([0, 1], 'credits', 'x', official, NOW)!;
    expect(values.value).toEqual([0, 1]);
    expect(makeArrayInsight([-1], 'credits', 'x', official, NOW)).toBeUndefined();
  });

  it('sorts daily usage deterministically', () => {
    expect(
      normalizeDailyTokenUsage([
        { startDate: '2026-08-26', tokens: 2 },
        { startDate: '2026-08-24', tokens: 1 },
      ]),
    ).toEqual([
      { date: '2026-08-24', tokens: 1 },
      { date: '2026-08-26', tokens: 2 },
    ]);
  });

  it('merges duplicate daily dates but not different dates', () => {
    expect(
      normalizeDailyTokenUsage([
        { startDate: '2026-08-25', tokens: 2 },
        { startDate: '2026-08-25', tokens: 3 },
        { startDate: '2026-08-26', tokens: 4 },
      ]),
    ).toEqual([
      { date: '2026-08-25', tokens: 5 },
      { date: '2026-08-26', tokens: 4 },
    ]);
  });

  it('drops malformed daily rows and negative token values', () => {
    expect(
      normalizeDailyTokenUsage([
        { startDate: '2026-08-25', tokens: -1 },
        { startDate: 'not-a-date', tokens: 4 },
        { startDate: '2026-08-26', tokens: 0 },
      ]),
    ).toEqual([{ date: '2026-08-26', tokens: 0 }]);
  });

  it('keeps at most the latest thirty daily rows', () => {
    const buckets = Array.from({ length: 31 }, (_, index) => ({
      startDate: `2026-07-${String(index + 1).padStart(2, '0')}`,
      tokens: index,
    }));
    const normalized = normalizeDailyTokenUsage(buckets);
    expect(normalized).toHaveLength(30);
    expect(normalized[0].date).toBe('2026-07-02');
  });

  it('does not admit numeric overflow while merging daily rows', () => {
    const normalized = normalizeDailyTokenUsage([
      { startDate: '2026-08-25', tokens: Number.MAX_VALUE },
      { startDate: '2026-08-25', tokens: Number.MAX_VALUE },
    ]);
    expect(normalized).toEqual([{ date: '2026-08-25', tokens: Number.MAX_VALUE }]);
  });

  it('merges overlay account fields while retaining official session fields', () => {
    const base = buildClaudeUsageInsights(claudeSnapshot());
    const merged = mergeUsageInsights(base, {
      accountMetrics: { planType: insight('OAuth account', 'text', 'planType') },
    })!;
    expect(merged.accountMetrics?.planType?.value).toBe('OAuth account');
    expect(merged.sessionMetrics?.modelId?.value).toBe('claude-sonnet-test');
  });

  it('merges overlay source and stale state explicitly', () => {
    const base = buildClaudeUsageInsights(claudeSnapshot());
    const merged = mergeUsageInsights(base, {
      source: experimental,
      stale: true,
      checkedAt: NOW + 1,
    })!;
    expect(merged.source.kind).toBe('experimental-undocumented');
    expect(merged.stale).toBe(true);
    expect(merged.checkedAt).toBe(NOW + 1);
  });

  it('classifies a legacy snapshot without retaining raw payloads', () => {
    const result = insightsFromSnapshot({
      providerId: 'grok',
      checkedAt: NOW,
      observedAt: NOW,
      stale: false,
      source: 'Official Grok Build billing capability (x.ai/billing)',
    });
    expect(result.source.kind).toBe('official');
    expect(JSON.stringify(result)).not.toContain('session_id');
  });

  it('builds Codex account totals and streak metrics', () => {
    const result = buildCodexUsageInsights({
      planType: 'pro',
      usage: codexUsage(),
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.lifetimeTokens?.value).toBe(1000);
    expect(result.accountMetrics?.peakDailyTokens?.value).toBe(200);
    expect(result.accountMetrics?.currentStreakDays?.value).toBe(2);
    expect(result.source.kind).toBe('official');
  });

  it('keeps Codex reset credits zero instead of hiding it', () => {
    const result = buildCodexUsageInsights({
      usage: codexUsage(),
      resetCredits: 0,
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.resetCreditsAvailable?.value).toBe(0);
  });

  it('keeps Codex trend data separate from lifetime totals', () => {
    const result = buildCodexUsageInsights({ usage: codexUsage(), checkedAt: NOW });
    expect(result.trend?.dailyTokenUsage.map((row) => row.date)).toEqual([
      '2026-08-25',
      '2026-08-26',
    ]);
    expect(result.trend?.displayedDays).toBe(14);
    expect(result.accountMetrics?.lifetimeTokens?.value).not.toBe(220);
  });

  it('exposes Codex reset-credit expiration dates as display-only metrics', () => {
    const result = buildCodexUsageInsights({
      usage: codexUsage(),
      resetCreditExpiresAt: [1_800_000_000],
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.resetCreditExpiresAt?.value).toEqual([1_800_000_000]);
  });

  it('omits invalid Codex numeric summary values', () => {
    const result = buildCodexUsageInsights({
      usage: {
        ...codexUsage(),
        lifetimeTokens: -1,
        peakDailyTokens: Number.NaN,
      },
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.lifetimeTokens).toBeUndefined();
    expect(result.accountMetrics?.peakDailyTokens).toBeUndefined();
  });

  it('builds Claude latest-session model and version metrics', () => {
    const result = buildClaudeUsageInsights(claudeSnapshot());
    expect(result.sessionMetrics?.sessionLabel).toBe('latestObservedCliSession');
    expect(result.sessionMetrics?.modelId?.value).toBe('claude-sonnet-test');
    expect(result.sessionMetrics?.cliVersion?.value).toBe('2.1.241');
  });

  it('keeps Claude context and cache values in the session scope', () => {
    const session = buildClaudeUsageInsights(claudeSnapshot()).sessionMetrics!;
    expect(session.contextWindowSize?.value).toBe(200_000);
    expect(session.cacheCreationInputTokens?.value).toBe(50);
    expect(session.cacheReadInputTokens?.value).toBe(25);
    expect(session.inputTokens?.value).toBe(1000);
  });

  it('marks Claude cost as estimated and preserves duration metrics', () => {
    const session = buildClaudeUsageInsights(claudeSnapshot()).sessionMetrics!;
    expect(session.estimatedCostUsd?.isEstimated).toBe(true);
    expect(session.totalDurationMs?.value).toBe(4000);
    expect(session.totalApiDurationMs?.value).toBe(2500);
  });

  it('preserves false Claude fast/thinking flags', () => {
    const session = buildClaudeUsageInsights(claudeSnapshot()).sessionMetrics!;
    expect(session.fastMode?.value).toBe(false);
    expect(session.thinkingEnabled?.value).toBe(true);
  });

  it('keeps Claude account rate limits separate from session metrics', () => {
    const result = buildClaudeUsageInsights(claudeSnapshot());
    expect(result.accountMetrics?.rateLimits?.value[0].id).toBe('five-hour');
    expect(result.accountMetrics?.lifetimeTokens).toBeUndefined();
  });

  it('parses Claude status-line additional safe fields and drops secrets', () => {
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({
        version: '2.1.241',
        session_id: 'secret-session',
        cwd: 'C:/secret',
        model: { id: 'm1', display_name: 'Model 1' },
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 4, output_tokens: 2 },
        },
        cost: { total_cost_usd: 0, total_duration_ms: 20, total_lines_added: 0 },
        fast_mode: false,
        thinking: { enabled: false },
        output_style: { name: 'default' },
        rate_limits: { five_hour: { used_percentage: 10 } },
      }),
    );
    expect(snapshot.usageInsights?.sessionMetrics?.modelId?.value).toBe('m1');
    expect(snapshot.usageInsights?.sessionMetrics?.estimatedCostUsd?.value).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain('secret-session');
  });

  it('builds official Copilot AI credits with configured allowance provenance', () => {
    const result = buildCopilotUsageInsights({
      usage: copilotSummary({ usedCredits: 20 }),
      allowance: 100,
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.aiCreditsUsed?.value).toBe(20);
    expect(result.accountMetrics?.aiCreditsAllowance?.sourceKind).toBe('user-configured');
    expect(result.accountMetrics?.aiCreditsRemainingPercent?.value).toBe(80);
  });

  it('preserves zero Copilot credits', () => {
    const result = buildCopilotUsageInsights({
      usage: copilotSummary({ usedCredits: 0 }),
      allowance: 100,
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.aiCreditsUsed?.value).toBe(0);
  });

  it('does not derive a Copilot percentage without a denominator', () => {
    const result = buildCopilotUsageInsights({
      usage: copilotSummary({ usedCredits: 20 }),
      allowance: null,
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.aiCreditsRemainingPercent).toBeUndefined();
  });

  it('keeps Copilot model breakdown separate from AI credits', () => {
    const result = buildCopilotUsageInsights({
      usage: copilotSummary(),
      allowance: null,
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.productBreakdown?.value).toEqual(['gpt-test']);
    expect(result.accountMetrics?.aiCreditsUsed?.value).toBe(20);
  });

  it('represents organization-managed Copilot without an invented denominator', () => {
    const result = buildCopilotOrganizationInsights(NOW);
    expect(result.accountMetrics?.accountManagement?.value).toBe('organization-managed');
    expect(result.accountMetrics?.aiCreditsAllowance).toBeUndefined();
  });

  it('keeps experimental Copilot premium, chat, and completion quotas separate', () => {
    const result = buildCopilotEntitlementInsights({
      checkedAt: NOW,
      configuredBillingScope: 'pro',
      summary: {
        copilotPlan: 'business',
        accessTypeSku: 'sku',
        tokenBasedBilling: false,
        quotaResetDate: '2026-09-01T00:00:00.000Z',
        premiumInteractions: {
          creditsUsed: 1,
          entitlement: 10,
          remaining: 9,
          percentRemaining: 90,
          unlimited: false,
          overagePermitted: false,
        },
        chat: {
          creditsUsed: 2,
          entitlement: 20,
          remaining: 18,
          percentRemaining: 90,
          unlimited: false,
          overagePermitted: false,
        },
        completions: {
          creditsUsed: 3,
          entitlement: 30,
          remaining: 27,
          percentRemaining: 90,
          unlimited: false,
          overagePermitted: false,
        },
      },
    });
    expect(result.source.kind).toBe('experimental-undocumented');
    expect(result.accountMetrics?.legacyPremiumInteractions?.value).toBe(1);
    expect(result.accountMetrics?.chatQuota?.value).toBe(2);
    expect(result.accountMetrics?.completionQuota?.value).toBe(3);
  });

  it('keeps Grok official ACP billing provenance distinct', () => {
    const summary = parseGrokBilling({ subscriptionTier: 'pro', creditUsagePercent: 20 });
    const result = buildGrokUsageInsights({ summary, checkedAt: NOW });
    expect(result.source.label).toContain('x.ai/billing');
    expect(result.source.kind).toBe('official');
  });

  it('marks Grok CLI proxy insights experimental', () => {
    const result = buildGrokUsageInsights({
      summary: parseGrokBilling({ creditUsagePercent: 20 }),
      checkedAt: NOW,
      experimental: true,
    });
    expect(result.source.kind).toBe('experimental-undocumented');
  });

  it('does not create a Grok product metric when product data is absent', () => {
    const result = buildGrokUsageInsights({
      summary: parseGrokBilling({}),
      checkedAt: NOW,
    });
    expect(result.accountMetrics?.productBreakdown).toBeUndefined();
  });

  it('does not turn an absent Grok percentage into zero usage', () => {
    const summary = parseGrokBilling({ monthlyLimit: 100, used: 0 });
    expect(summary.usageWindows).toEqual([]);
    expect(
      buildGrokUsageInsights({ summary, checkedAt: NOW }).accountMetrics?.rateLimits,
    ).toBeUndefined();
  });

  it('rejects negative or out-of-range Grok percentages', () => {
    expect(parseGrokBilling({ creditUsagePercent: -1 }).usageWindows).toEqual([]);
    expect(parseGrokBilling({ creditUsagePercent: 101 }).usageWindows).toEqual([]);
  });

  it('parses Grok product breakdown as null when the endpoint omits it', () => {
    expect(parseGrokBilling({}).productBreakdown).toBeNull();
  });

  it('rejects negative Copilot billing quantities instead of clamping them to zero', () => {
    const parsed = parseCopilotUsage({
      timePeriod: '2026-08',
      usageItems: [
        {
          product: 'Copilot',
          sku: null,
          model: 'test',
          unitType: 'credit',
          grossQuantity: -10,
          discountQuantity: -2,
          netQuantity: null,
          grossAmount: -1,
          netAmount: null,
        },
      ],
    });
    expect(parsed.usedCredits).toBe(0);
    expect(parsed.includedCredits).toBeNull();
    expect(parsed.cost).toBeNull();
  });

  it('rejects negative Copilot entitlement fields', () => {
    const parsed = parseCopilotEntitlement({
      quota_snapshots: {
        premium_interactions: {
          credits_used: -1,
          entitlement: -2,
          remaining: -3,
          percent_remaining: 101,
        },
      },
    });
    expect(parsed.premiumInteractions).toEqual({
      creditsUsed: null,
      entitlement: null,
      remaining: null,
      percentRemaining: null,
      unlimited: null,
      overagePermitted: null,
    });
  });

  it('rejects Codex negative percentages and reset credits', () => {
    const parsed = parseRateLimits({
      rateLimits: { primary: { usedPercent: -1 } },
      rateLimitResetCredits: { availableCount: -1 },
    });
    expect(parsed.limits).toEqual([]);
    expect(parsed.resetCredits).toBeNull();
  });

  it('normalizes Codex reset-credit expiration dates and sorts them', () => {
    const parsed = parseRateLimits({
      rateLimitResetCredits: {
        availableCount: 1,
        expiresAt: 1_800_000_100,
        expirationDates: [1_800_000_000, 1_800_000_100],
      },
    });
    expect(parsed.resetCreditExpiresAt).toEqual([1_800_000_000, 1_800_000_100]);
  });

  it('normalizes Codex usage duplicate dates and caps the result at thirty rows', () => {
    const usage = parseUsage({
      dailyUsageBuckets: [
        { startDate: '2026-08-25', tokens: 2 },
        { startDate: '2026-08-25', tokens: 3 },
      ],
    });
    expect(usage.dailyUsageBuckets).toEqual([{ startDate: '2026-08-25', tokens: 5 }]);
  });

  it('defaults insights mode to summary and accepts detailed/hidden values', () => {
    expect(normalizeSettings().dashboard.insightsMode).toBe('summary');
    expect(
      normalizeSettings({ [SETTING_KEYS.dashboardInsightsMode]: 'detailed' }).dashboard
        .insightsMode,
    ).toBe('detailed');
    expect(
      normalizeSettings({ [SETTING_KEYS.dashboardInsightsMode]: 'hidden' }).dashboard.insightsMode,
    ).toBe('hidden');
  });

  it('falls back safely for an invalid insights mode without retaining the raw value', () => {
    const settings = normalizeSettings({ [SETTING_KEYS.dashboardInsightsMode]: 'secret-token' });
    expect(settings.dashboard.insightsMode).toBe('summary');
    expect(JSON.stringify(settings)).not.toContain('secret-token');
  });

  it('keeps account and session metrics typed as provider-scoped data', () => {
    const values: ProviderUsageInsights[] = [
      buildCodexUsageInsights({ usage: codexUsage(), checkedAt: NOW }),
      buildClaudeUsageInsights(claudeSnapshot()),
      buildCopilotUsageInsights({ usage: copilotSummary(), allowance: null, checkedAt: NOW }),
      buildGrokUsageInsights({ summary: parseGrokBilling({}), checkedAt: NOW }),
    ];
    expect(values.map((value) => value.providerId)).toEqual(['codex', 'claude', 'copilot', 'grok']);
  });
});
