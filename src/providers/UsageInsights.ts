import type { ProviderId, ProviderSnapshot } from './types';
import type { LimitSnapshot, UsageSnapshot } from '../appServer/types';
import type { CopilotEntitlementSummary } from './copilot/experimental/CopilotEntitlementTransport';
import type { CopilotUsageSummary } from './copilot/types';
import type { GrokBillingSummary } from './grok/types';

/** A provider source classification. It is intentionally narrower than a display string. */
export type UsageInsightSourceKind =
  'official' | 'experimental-undocumented' | 'derived' | 'user-configured';

export type UsageInsightUnit =
  | 'tokens'
  | 'percent'
  | 'credits'
  | 'usd'
  | 'seconds'
  | 'milliseconds'
  | 'lines'
  | 'days'
  | 'count'
  | 'date'
  | 'text'
  | 'boolean';

export type UsageInsightFreshness = 'fresh' | 'stale' | 'last-known-good';

export interface UsageInsightSource {
  kind: UsageInsightSourceKind;
  label: string;
}

export interface UsageInsightValue<T> {
  value: T;
  unit: UsageInsightUnit;
  /** Stable semantic label/key. Localized UI text is resolved at render time. */
  label: string;
  sourceKind: UsageInsightSourceKind;
  sourceLabel: string;
  observedAt: number;
  freshness: UsageInsightFreshness;
  isEstimated: boolean;
  isDerived: boolean;
  isExperimental: boolean;
}

export interface UsageRateLimitMetric {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
  windowDurationMinutes: number | null;
}

export interface DailyTokenUsageMetric {
  date: string;
  tokens: UsageInsightValue<number>;
}

export interface UsageTrend {
  dailyTokenUsage: DailyTokenUsageMetric[];
  displayedDays: number;
}

export interface AccountUsageMetrics {
  planType?: UsageInsightValue<string>;
  rateLimits?: UsageInsightValue<UsageRateLimitMetric[]>;
  lifetimeTokens?: UsageInsightValue<number>;
  peakDailyTokens?: UsageInsightValue<number>;
  longestRunningTurnSeconds?: UsageInsightValue<number>;
  currentStreakDays?: UsageInsightValue<number>;
  longestStreakDays?: UsageInsightValue<number>;
  resetCreditsAvailable?: UsageInsightValue<number>;
  resetCreditExpiresAt?: UsageInsightValue<number[]>;
  aiCreditsUsed?: UsageInsightValue<number>;
  aiCreditsAllowance?: UsageInsightValue<number>;
  aiCreditsRemainingPercent?: UsageInsightValue<number>;
  resetAt?: UsageInsightValue<number>;
  accountManagement?: UsageInsightValue<string>;
  endpointPlan?: UsageInsightValue<string>;
  configuredBillingScope?: UsageInsightValue<string>;
  tokenBasedBilling?: UsageInsightValue<boolean>;
  chatQuota?: UsageInsightValue<number>;
  completionQuota?: UsageInsightValue<number>;
  legacyPremiumInteractions?: UsageInsightValue<number>;
  productBreakdown?: UsageInsightValue<string[]>;
  buildUsage?: UsageInsightValue<number>;
  extraCreditBalance?: UsageInsightValue<number>;
}

export interface SessionUsageMetrics {
  /** Always rendered as "Latest observed CLI session" by the UI. */
  sessionLabel: string;
  modelId?: UsageInsightValue<string>;
  modelDisplayName?: UsageInsightValue<string>;
  cliVersion?: UsageInsightValue<string>;
  contextWindowSize?: UsageInsightValue<number>;
  inputTokens?: UsageInsightValue<number>;
  outputTokens?: UsageInsightValue<number>;
  cacheCreationInputTokens?: UsageInsightValue<number>;
  cacheReadInputTokens?: UsageInsightValue<number>;
  contextUsedPercent?: UsageInsightValue<number>;
  contextRemainingPercent?: UsageInsightValue<number>;
  estimatedCostUsd?: UsageInsightValue<number>;
  totalDurationMs?: UsageInsightValue<number>;
  totalApiDurationMs?: UsageInsightValue<number>;
  linesAdded?: UsageInsightValue<number>;
  linesRemoved?: UsageInsightValue<number>;
  fastMode?: UsageInsightValue<boolean>;
  effortLevel?: UsageInsightValue<string>;
  thinkingEnabled?: UsageInsightValue<boolean>;
  exceeds200kTokens?: UsageInsightValue<boolean>;
  outputStyle?: UsageInsightValue<string>;
}

export interface ProviderInsightsCapabilities {
  accountMetrics: boolean;
  sessionMetrics: boolean;
  dailyTrend: boolean;
  resetCredits: boolean;
  productBreakdown: boolean;
}

export interface ProviderUsageInsights {
  providerId: ProviderId;
  accountMetrics?: AccountUsageMetrics;
  sessionMetrics?: SessionUsageMetrics;
  trend?: UsageTrend;
  capabilities?: ProviderInsightsCapabilities;
  source: UsageInsightSource;
  checkedAt: number;
  sourceUpdatedAt?: number;
  stale: boolean;
}

const MAX_TIMESTAMP_MS = 100_000_000_000_000;
const MIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isSafeMetricNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isSafeTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_TIMESTAMP_MS
  );
}

export function isValidUsageDate(value: unknown): value is string {
  if (typeof value !== 'string' || !MIN_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function usageFreshness(stale: boolean): UsageInsightFreshness {
  return stale ? 'stale' : 'fresh';
}

export function makeInsight<T>(
  value: unknown,
  unit: UsageInsightUnit,
  label: string,
  source: UsageInsightSource,
  observedAt: number,
  stale = false,
  options: { isEstimated?: boolean; isDerived?: boolean } = {},
): UsageInsightValue<T> | undefined {
  if (!isSafeTimestamp(observedAt)) return undefined;
  if (typeof value === 'number' && !isSafeMetricNumber(value)) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
    return undefined;
  }
  return {
    value: value as T,
    unit,
    label,
    sourceKind: source.kind,
    sourceLabel: source.label,
    observedAt,
    freshness: usageFreshness(stale),
    isEstimated: options.isEstimated ?? false,
    isDerived: options.isDerived ?? false,
    isExperimental: source.kind === 'experimental-undocumented',
  };
}

export function makeArrayInsight<T>(
  value: T[],
  unit: UsageInsightUnit,
  label: string,
  source: UsageInsightSource,
  observedAt: number,
  stale = false,
  options: { isEstimated?: boolean; isDerived?: boolean } = {},
): UsageInsightValue<T[]> | undefined {
  if (!isSafeTimestamp(observedAt)) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        (typeof item === 'number' && !isSafeMetricNumber(item)) ||
        (typeof item === 'string' && !item.trim()),
    )
  )
    return undefined;
  return {
    value: value.slice(),
    unit,
    label,
    sourceKind: source.kind,
    sourceLabel: source.label,
    observedAt,
    freshness: usageFreshness(stale),
    isEstimated: options.isEstimated ?? false,
    isDerived: options.isDerived ?? false,
    isExperimental: source.kind === 'experimental-undocumented',
  };
}

/** Deterministically sorts, merges duplicate dates, rejects bad rows, and keeps at most 30 days. */
export function normalizeDailyTokenUsage(
  buckets: readonly { startDate?: unknown; tokens?: unknown }[] | null | undefined,
): Array<{ date: string; tokens: number }> {
  const merged = new Map<string, number>();
  for (const bucket of buckets ?? []) {
    if (!isValidUsageDate(bucket?.startDate) || !isSafeMetricNumber(bucket?.tokens)) continue;
    const current = merged.get(bucket.startDate) ?? 0;
    const total = current + bucket.tokens;
    if (Number.isFinite(total)) merged.set(bucket.startDate, total);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-30)
    .map(([date, tokens]) => ({ date, tokens }));
}

export function mergeUsageInsights(
  base: ProviderUsageInsights | undefined,
  overlay: Partial<ProviderUsageInsights> | undefined,
): ProviderUsageInsights | undefined {
  if (!base && !overlay) return undefined;
  if (!base) return overlay as ProviderUsageInsights;
  if (!overlay) return base;
  return {
    ...base,
    ...overlay,
    accountMetrics: { ...base.accountMetrics, ...overlay.accountMetrics },
    sessionMetrics: { ...base.sessionMetrics, ...overlay.sessionMetrics } as
      SessionUsageMetrics | undefined,
    trend: overlay.trend ?? base.trend,
    ...(base.capabilities || overlay.capabilities
      ? {
          capabilities: {
            accountMetrics:
              overlay.capabilities?.accountMetrics ?? base.capabilities?.accountMetrics ?? false,
            sessionMetrics:
              overlay.capabilities?.sessionMetrics ?? base.capabilities?.sessionMetrics ?? false,
            dailyTrend: overlay.capabilities?.dailyTrend ?? base.capabilities?.dailyTrend ?? false,
            resetCredits:
              overlay.capabilities?.resetCredits ?? base.capabilities?.resetCredits ?? false,
            productBreakdown:
              overlay.capabilities?.productBreakdown ??
              base.capabilities?.productBreakdown ??
              false,
          },
        }
      : {}),
    source: overlay.source ?? base.source,
    checkedAt: overlay.checkedAt ?? base.checkedAt,
    sourceUpdatedAt: overlay.sourceUpdatedAt ?? base.sourceUpdatedAt,
    stale: overlay.stale ?? base.stale,
  };
}

export function insightsFromSnapshot(
  snapshot: Pick<ProviderSnapshot, 'providerId' | 'checkedAt' | 'observedAt' | 'stale' | 'source'>,
): ProviderUsageInsights {
  const checkedAt = isSafeTimestamp(snapshot.checkedAt) ? snapshot.checkedAt : snapshot.observedAt;
  const source: UsageInsightSource = {
    kind: snapshot.source.toLowerCase().includes('experimental')
      ? 'experimental-undocumented'
      : 'official',
    label: snapshot.source,
  };
  return {
    providerId: snapshot.providerId as ProviderId,
    source,
    checkedAt: isSafeTimestamp(checkedAt) ? checkedAt : Date.now(),
    stale: snapshot.stale,
  };
}

const CODEX_SOURCE: UsageInsightSource = {
  kind: 'official',
  label: 'Official Codex App Server',
};

const CLAUDE_SOURCE: UsageInsightSource = {
  kind: 'official',
  label: 'Official Claude Code status-line',
};

function addMetric<T>(
  target: object,
  key: string,
  value: unknown,
  unit: UsageInsightUnit,
  label: string,
  source: UsageInsightSource,
  observedAt: number,
  stale: boolean,
  options: { isEstimated?: boolean; isDerived?: boolean } = {},
): void {
  const result = makeInsight<T>(value, unit, label, source, observedAt, stale, options);
  if (result) (target as Record<string, unknown>)[key] = result;
}

export function buildCodexUsageInsights(input: {
  planType?: string | null;
  limitSnapshot?: LimitSnapshot;
  usage: UsageSnapshot;
  resetCredits?: number | null;
  resetCreditExpiresAt?: number[];
  checkedAt: number;
  stale?: boolean;
}): ProviderUsageInsights {
  const checkedAt = isSafeTimestamp(input.checkedAt) ? input.checkedAt : Date.now();
  const stale = input.stale ?? false;
  const account: Record<string, unknown> = {};
  const limits = input.limitSnapshot?.limits ?? [];
  addMetric(
    account,
    'planType',
    input.planType,
    'text',
    'planType',
    CODEX_SOURCE,
    checkedAt,
    stale,
  );
  if (limits.length)
    account.rateLimits = makeArrayInsight(
      limits.map((limit) => ({
        id: limit.limitId ?? limit.label,
        label: limit.label,
        usedPercent: limit.usedPercent,
        remainingPercent: limit.remainingPercent,
        resetsAt: limit.resetsAt,
        windowDurationMinutes: limit.durationMins,
      })),
      'count',
      'rateLimits',
      CODEX_SOURCE,
      checkedAt,
      stale,
    );
  addMetric(
    account,
    'lifetimeTokens',
    input.usage.lifetimeTokens,
    'tokens',
    'lifetimeTokens',
    CODEX_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'peakDailyTokens',
    input.usage.peakDailyTokens,
    'tokens',
    'peakDailyTokens',
    CODEX_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'longestRunningTurnSeconds',
    input.usage.longestRunningTurnSec,
    'seconds',
    'longestRunningTurn',
    CODEX_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'currentStreakDays',
    input.usage.currentStreakDays,
    'days',
    'currentStreak',
    CODEX_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'longestStreakDays',
    input.usage.longestStreakDays,
    'days',
    'longestStreak',
    CODEX_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'resetCreditsAvailable',
    input.resetCredits,
    'count',
    'resetCreditsAvailable',
    CODEX_SOURCE,
    checkedAt,
    stale,
  );
  if (input.resetCreditExpiresAt?.length)
    account.resetCreditExpiresAt = makeArrayInsight(
      input.resetCreditExpiresAt,
      'date',
      'resetCreditExpiresAt',
      CODEX_SOURCE,
      checkedAt,
      stale,
    );

  const dailyTokenUsage = input.usage.dailyUsageBuckets.flatMap((bucket) => {
    const tokens = makeInsight<number>(
      bucket.tokens,
      'tokens',
      'dailyTokens',
      CODEX_SOURCE,
      checkedAt,
      stale,
    );
    return tokens ? [{ date: bucket.startDate, tokens }] : [];
  });
  const result: ProviderUsageInsights = {
    providerId: 'codex',
    accountMetrics: account as AccountUsageMetrics,
    trend: { dailyTokenUsage, displayedDays: 14 },
    capabilities: {
      accountMetrics: true,
      sessionMetrics: false,
      dailyTrend: dailyTokenUsage.length > 0,
      resetCredits: input.resetCredits !== null && input.resetCredits !== undefined,
      productBreakdown: false,
    },
    source: CODEX_SOURCE,
    checkedAt,
    sourceUpdatedAt: checkedAt,
    stale,
  };
  return result;
}

function tokenFrom(snapshot: Pick<ProviderSnapshot, 'tokens'>, key: string): number | null {
  const value = snapshot.tokens?.[key];
  return isSafeMetricNumber(value) ? value : null;
}

function metadataValue(snapshot: Pick<ProviderSnapshot, 'metadata'>, key: string): unknown {
  return snapshot.metadata?.[key];
}

export function buildClaudeUsageInsights(
  snapshot: Pick<
    ProviderSnapshot,
    | 'providerId'
    | 'usageWindows'
    | 'tokens'
    | 'metadata'
    | 'cliVersion'
    | 'checkedAt'
    | 'observedAt'
    | 'sourceUpdatedAt'
    | 'stale'
  >,
): ProviderUsageInsights {
  const checkedAt = isSafeTimestamp(snapshot.checkedAt)
    ? snapshot.checkedAt
    : isSafeTimestamp(snapshot.observedAt)
      ? snapshot.observedAt
      : Date.now();
  const observedAt = isSafeTimestamp(snapshot.sourceUpdatedAt)
    ? snapshot.sourceUpdatedAt
    : checkedAt;
  const session: Record<string, unknown> = { sessionLabel: 'latestObservedCliSession' };
  addMetric(
    session,
    'modelId',
    metadataValue(snapshot, 'modelId'),
    'text',
    'model',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'modelDisplayName',
    metadataValue(snapshot, 'modelName'),
    'text',
    'model',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'cliVersion',
    metadataValue(snapshot, 'version') ??
      metadataValue(snapshot, 'cliVersion') ??
      snapshot.cliVersion,
    'text',
    'cliVersion',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'contextWindowSize',
    tokenFrom(snapshot, 'contextWindowSize'),
    'tokens',
    'contextCapacity',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'inputTokens',
    tokenFrom(snapshot, 'totalInputTokens'),
    'tokens',
    'inputTokens',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'outputTokens',
    tokenFrom(snapshot, 'totalOutputTokens'),
    'tokens',
    'outputTokens',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'cacheCreationInputTokens',
    tokenFrom(snapshot, 'cacheCreationInputTokens'),
    'tokens',
    'cacheCreationInputTokens',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'cacheReadInputTokens',
    tokenFrom(snapshot, 'cacheReadInputTokens'),
    'tokens',
    'cacheReadInputTokens',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'contextUsedPercent',
    tokenFrom(snapshot, 'contextUsedPercent'),
    'percent',
    'contextUsed',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'contextRemainingPercent',
    tokenFrom(snapshot, 'contextRemainingPercent'),
    'percent',
    'contextRemaining',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'estimatedCostUsd',
    tokenFrom(snapshot, 'totalCostUsd'),
    'usd',
    'estimatedSessionCost',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
    { isEstimated: true },
  );
  addMetric(
    session,
    'totalDurationMs',
    tokenFrom(snapshot, 'totalDurationMs'),
    'milliseconds',
    'sessionDuration',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'totalApiDurationMs',
    tokenFrom(snapshot, 'totalApiDurationMs'),
    'milliseconds',
    'apiWaitTime',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'linesAdded',
    tokenFrom(snapshot, 'totalLinesAdded'),
    'lines',
    'linesAdded',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'linesRemoved',
    tokenFrom(snapshot, 'totalLinesRemoved'),
    'lines',
    'linesRemoved',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'fastMode',
    metadataValue(snapshot, 'fastMode'),
    'boolean',
    'fastMode',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'effortLevel',
    metadataValue(snapshot, 'effort'),
    'text',
    'effortLevel',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'thinkingEnabled',
    metadataValue(snapshot, 'thinking'),
    'boolean',
    'thinking',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'exceeds200kTokens',
    metadataValue(snapshot, 'exceeds200kTokens'),
    'boolean',
    'exceeds200kTokens',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );
  addMetric(
    session,
    'outputStyle',
    metadataValue(snapshot, 'outputStyle'),
    'text',
    'outputStyle',
    CLAUDE_SOURCE,
    observedAt,
    snapshot.stale,
  );

  const limits = snapshot.usageWindows.map((window) => ({
    id: window.id,
    label: window.label,
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetsAt: window.resetsAt,
    windowDurationMinutes: window.windowDurationMinutes,
  }));
  const account: AccountUsageMetrics = {};
  if (limits.length) {
    account.rateLimits = makeArrayInsight(
      limits,
      'count',
      'rateLimits',
      CLAUDE_SOURCE,
      observedAt,
      snapshot.stale,
    );
  }
  return {
    providerId: 'claude',
    accountMetrics: account,
    sessionMetrics: session as unknown as SessionUsageMetrics,
    capabilities: {
      accountMetrics: limits.length > 0,
      sessionMetrics: Object.keys(session).length > 1,
      dailyTrend: false,
      resetCredits: false,
      productBreakdown: false,
    },
    source: CLAUDE_SOURCE,
    checkedAt,
    ...(isSafeTimestamp(snapshot.sourceUpdatedAt)
      ? { sourceUpdatedAt: snapshot.sourceUpdatedAt }
      : {}),
    stale: snapshot.stale,
  };
}

const COPILOT_SOURCE: UsageInsightSource = {
  kind: 'official',
  label: 'Official GitHub Billing REST API',
};
const COPILOT_EXPERIMENTAL_SOURCE: UsageInsightSource = {
  kind: 'experimental-undocumented',
  label: 'Experimental — undocumented GitHub Copilot entitlement endpoint',
};
const USER_CONFIGURED_COPILOT_SOURCE: UsageInsightSource = {
  kind: 'user-configured',
  label: 'User-configured Copilot plan allowance',
};
const DERIVED_SOURCE: UsageInsightSource = { kind: 'derived', label: 'Derived from provider data' };

export function buildCopilotUsageInsights(input: {
  usage: CopilotUsageSummary;
  allowance: number | null;
  checkedAt: number;
  stale?: boolean;
}): ProviderUsageInsights {
  const checkedAt = isSafeTimestamp(input.checkedAt) ? input.checkedAt : Date.now();
  const stale = input.stale ?? false;
  const account: AccountUsageMetrics = {};
  addMetric(
    account,
    'aiCreditsUsed',
    input.usage.usedCredits,
    'credits',
    'aiCreditsUsed',
    COPILOT_SOURCE,
    checkedAt,
    stale,
  );
  if (isSafeMetricNumber(input.allowance)) {
    addMetric(
      account,
      'aiCreditsAllowance',
      input.allowance,
      'credits',
      'aiCreditsAllowance',
      USER_CONFIGURED_COPILOT_SOURCE,
      checkedAt,
      stale,
    );
    addMetric(
      account,
      'aiCreditsRemainingPercent',
      (1 - input.usage.usedCredits / input.allowance) * 100,
      'percent',
      'aiCreditsRemainingPercent',
      DERIVED_SOURCE,
      checkedAt,
      stale,
      { isDerived: true },
    );
  }
  if (isSafeMetricNumber(input.usage.nextResetAt))
    addMetric(
      account,
      'resetAt',
      input.usage.nextResetAt,
      'date',
      'resetAt',
      COPILOT_SOURCE,
      checkedAt,
      stale,
      { isDerived: true },
    );
  if (input.usage.modelBreakdown.length)
    account.productBreakdown = makeArrayInsight(
      input.usage.modelBreakdown.map((item) => item.model),
      'text',
      'modelBreakdown',
      COPILOT_SOURCE,
      checkedAt,
      stale,
    );
  return {
    providerId: 'copilot',
    accountMetrics: account,
    capabilities: {
      accountMetrics: true,
      sessionMetrics: false,
      dailyTrend: false,
      resetCredits: false,
      productBreakdown: input.usage.modelBreakdown.length > 0,
    },
    source: COPILOT_SOURCE,
    checkedAt,
    sourceUpdatedAt: checkedAt,
    stale,
  };
}

export function buildCopilotOrganizationInsights(checkedAt: number): ProviderUsageInsights {
  const safeCheckedAt = isSafeTimestamp(checkedAt) ? checkedAt : Date.now();
  const account: AccountUsageMetrics = {};
  addMetric(
    account,
    'accountManagement',
    'organization-managed',
    'text',
    'accountManagement',
    COPILOT_SOURCE,
    safeCheckedAt,
    false,
  );
  return {
    providerId: 'copilot',
    accountMetrics: account,
    capabilities: {
      accountMetrics: true,
      sessionMetrics: false,
      dailyTrend: false,
      resetCredits: false,
      productBreakdown: false,
    },
    source: COPILOT_SOURCE,
    checkedAt: safeCheckedAt,
    stale: false,
  };
}

function entitlementMetric(
  bucket: CopilotEntitlementSummary['premiumInteractions'],
  key: 'creditsUsed' | 'entitlement' | 'remaining' | 'percentRemaining',
): number | null {
  const value = bucket?.[key];
  return isSafeMetricNumber(value) ? value : null;
}

export function buildCopilotEntitlementInsights(input: {
  summary: CopilotEntitlementSummary;
  configuredBillingScope: string;
  checkedAt: number;
  stale?: boolean;
}): ProviderUsageInsights {
  const checkedAt = isSafeTimestamp(input.checkedAt) ? input.checkedAt : Date.now();
  const stale = input.stale ?? false;
  const account: AccountUsageMetrics = {};
  const primary =
    input.summary.premiumInteractions ?? input.summary.chat ?? input.summary.completions;
  addMetric(
    account,
    'aiCreditsUsed',
    entitlementMetric(primary, 'creditsUsed'),
    'credits',
    'aiCreditsUsed',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'aiCreditsAllowance',
    entitlementMetric(primary, 'entitlement'),
    'credits',
    'aiCreditsAllowance',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'aiCreditsRemainingPercent',
    entitlementMetric(primary, 'percentRemaining'),
    'percent',
    'aiCreditsRemainingPercent',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'resetAt',
    input.summary.quotaResetDate ? Date.parse(input.summary.quotaResetDate) : null,
    'date',
    'resetAt',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'accountManagement',
    'organization-managed',
    'text',
    'accountManagement',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'endpointPlan',
    input.summary.copilotPlan,
    'text',
    'endpointPlan',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'configuredBillingScope',
    input.configuredBillingScope,
    'text',
    'configuredBillingScope',
    USER_CONFIGURED_COPILOT_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'tokenBasedBilling',
    input.summary.tokenBasedBilling,
    'boolean',
    'tokenBasedBilling',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'legacyPremiumInteractions',
    entitlementMetric(input.summary.premiumInteractions, 'creditsUsed'),
    'credits',
    'legacyPremiumInteractions',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'chatQuota',
    entitlementMetric(input.summary.chat, 'creditsUsed'),
    'credits',
    'chatQuota',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'completionQuota',
    entitlementMetric(input.summary.completions, 'creditsUsed'),
    'credits',
    'completionQuota',
    COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    stale,
  );
  return {
    providerId: 'copilot',
    accountMetrics: account,
    capabilities: {
      accountMetrics: true,
      sessionMetrics: false,
      dailyTrend: false,
      resetCredits: false,
      productBreakdown: false,
    },
    source: COPILOT_EXPERIMENTAL_SOURCE,
    checkedAt,
    sourceUpdatedAt: checkedAt,
    stale,
  };
}

const GROK_SOURCE: UsageInsightSource = {
  kind: 'official',
  label: 'Official Grok Build billing capability (x.ai/billing)',
};
const GROK_EXPERIMENTAL_SOURCE: UsageInsightSource = {
  kind: 'experimental-undocumented',
  label: 'Experimental — Grok Build CLI billing proxy',
};

export function buildGrokUsageInsights(input: {
  summary: GrokBillingSummary;
  checkedAt: number;
  experimental?: boolean;
  stale?: boolean;
}): ProviderUsageInsights {
  const checkedAt = isSafeTimestamp(input.checkedAt) ? input.checkedAt : Date.now();
  const stale = input.stale ?? false;
  const source = input.experimental ? GROK_EXPERIMENTAL_SOURCE : GROK_SOURCE;
  const account: AccountUsageMetrics = {};
  addMetric(account, 'planType', input.summary.plan, 'text', 'planType', source, checkedAt, stale);
  addMetric(
    account,
    'buildUsage',
    input.summary.buildUsage,
    'credits',
    'buildUsage',
    source,
    checkedAt,
    stale,
  );
  addMetric(
    account,
    'extraCreditBalance',
    input.summary.extraCreditBalance,
    'credits',
    'extraCreditBalance',
    source,
    checkedAt,
    stale,
  );
  const numericWindows = input.summary.usageWindows.filter(
    (window) =>
      isSafeMetricNumber(window.usedPercent) && isSafeMetricNumber(window.remainingPercent),
  );
  if (numericWindows.length)
    account.rateLimits = makeArrayInsight(
      numericWindows.map((window) => ({
        id: window.id,
        label: window.label,
        usedPercent: window.usedPercent as number,
        remainingPercent: window.remainingPercent as number,
        resetsAt: window.resetsAt,
        windowDurationMinutes: null,
      })),
      'count',
      'rateLimits',
      source,
      checkedAt,
      stale,
    );
  const products = (input.summary.productBreakdown ?? [])
    .map((item) => item.product)
    .filter(Boolean);
  if (products.length)
    account.productBreakdown = makeArrayInsight(
      products,
      'text',
      'productBreakdown',
      source,
      checkedAt,
      stale,
    );
  return {
    providerId: 'grok',
    accountMetrics: account,
    capabilities: {
      accountMetrics: numericWindows.length > 0 || Object.keys(account).length > 0,
      sessionMetrics: false,
      dailyTrend: false,
      resetCredits: false,
      productBreakdown: products.length > 0,
    },
    source,
    checkedAt,
    sourceUpdatedAt: checkedAt,
    stale,
  };
}
