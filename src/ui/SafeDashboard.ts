import * as vscode from 'vscode';
import { SafeLogRedactor } from '../infrastructure/redact';
import { normalizeToEpochMs } from '../limits/TimestampNormalizer';
import { createRemainingCapacityProgress } from '../limits/RemainingCapacityProgress';
import type { RemainingCapacityThresholds } from '../limits/RemainingCapacityProgress';
import {
  formatConfiguredTime,
  getUiTextCatalog,
  localizedProviderGuidance,
  localizedProviderLinkLabel,
  localizedProviderSourceLabel,
  percentageText,
} from './UiTextCatalog';
import {
  getProviderInstallGuidance,
  getProviderLink,
  type ProviderLinkId,
  type ProviderLinkDefinition,
} from '../links/ProviderLinkRegistry';
import type { ProviderId } from '../providers/types';
import {
  normalizeProviderId,
  resolveProviderPresentations,
  type ProviderPresentationState,
} from '../providers/ProviderCapabilityContract';
import type { ProviderSnapshot } from '../providers/types';
import { buildProviderPresentationSummary, type PresentedFreshness } from './ProviderPresentation';
import type { UsageInsightValue } from '../providers/UsageInsights';
import type { InsightsMode } from '../configuration/EffectiveSettings';
import type { LocalizationKey } from '../localization/LocalizationKeys';

export const SAFE_DASHBOARD_SCHEME = 'ai-limit-ledger';
export const SAFE_DASHBOARD_URI = vscode.Uri.parse(`${SAFE_DASHBOARD_SCHEME}:/dashboard.md`);
export const SAFE_DASHBOARD_VERSION = '0.6.0';
export const SAFE_DASHBOARD_TIMER_INTERVAL_MS = 30_000;

export interface SafeMetric {
  label: string;
  value: string;
}

export interface SafeUsageInsight {
  label: string;
  value: string;
  unit: string;
  sourceKind: string;
  sourceLabel: string;
  observedAt: number;
  isEstimated: boolean;
  isDerived: boolean;
  isExperimental: boolean;
}

export interface SafeUsageWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: number;
  windowDurationMinutes?: number;
}

export interface SafeProviderDocumentModel {
  providerId: string;
  displayName: string;
  normalizedState: string;
  statusKey: LocalizationKey;
  explanationKey?: LocalizationKey;
  requirementKey?: LocalizationKey;
  sourceKind: string;
  sourceLabel?: string;
  freshness: PresentedFreshness;
  experimental: boolean;
  stale: boolean;
  usageWindows: SafeUsageWindow[];
  rawMetrics: SafeMetric[];
  usageInsights: SafeUsageInsight[];
  insightsMode: InsightsMode;
  plan?: string;
  cliVersion?: string;
  extensionVersion?: string;
  lastCheckAt?: number;
  lastSuccessfulUpdateAt?: number;
  lastProviderEventAt?: number;
  nextRefreshAt?: number;
  backoffUntil?: number;
  /** @deprecated Use explanationKey; retained for structural compatibility only. */
  safeExplanation?: never;
  /** @deprecated Use the provider presentation status/explanation keys. */
  requirement?: never;
  cliUsageInstruction?: string;
  links: readonly SafeProviderLink[];
  commands: string[];
}

export type SafeProviderLink = Pick<
  ProviderLinkDefinition,
  'id' | 'label' | 'url' | 'category' | 'requiresAuthentication'
>;

export interface SafeDashboardDocumentModel {
  generatedAt: number;
  activeProviders: SafeProviderDocumentModel[];
  availableProviders: SafeProviderDocumentModel[];
  overallState: string;
  version: string;
  percentageMode: 'remaining' | 'used' | 'both';
  thresholds: RemainingCapacityThresholds;
  preferences: {
    dashboardMode: string;
    statusBarMode: string;
    tooltipDensity: string;
    notificationLevel: string;
    timeFormat: string;
    language: 'auto' | 'en' | 'tr';
    insightsMode: InsightsMode;
  };
}

export type DashboardMode = 'auto' | 'rich-webview' | 'safe-native';

export function dashboardModeFromConfiguration(value: unknown): DashboardMode {
  return value === 'rich-webview' || value === 'safe-native' ? value : 'auto';
}

export interface SafeDashboardDiagnosticsSnapshot {
  configuredMode: DashboardMode;
  lastRendererUsed: 'rich-webview' | 'safe-native' | null;
  safeDashboardRegistered: boolean;
  safeDashboardOpen: boolean;
  safeDashboardLastRenderedAt: number | null;
  safeDashboardRenderCount: number;
  lastRichDashboardReadyTimeout: number | null;
  lastFallbackAction: string | null;
}

const redactor = new SafeLogRedactor();
let diagnostics: SafeDashboardDiagnosticsSnapshot = {
  configuredMode: 'auto',
  lastRendererUsed: null,
  safeDashboardRegistered: false,
  safeDashboardOpen: false,
  safeDashboardLastRenderedAt: null,
  safeDashboardRenderCount: 0,
  lastRichDashboardReadyTimeout: null,
  lastFallbackAction: null,
};

export function getSafeDashboardDiagnosticsSnapshot(): SafeDashboardDiagnosticsSnapshot {
  return { ...diagnostics };
}

export function setConfiguredDashboardMode(mode: DashboardMode): void {
  diagnostics = { ...diagnostics, configuredMode: mode };
}

export function recordRichDashboardReadyTimeout(at = Date.now()): void {
  diagnostics = { ...diagnostics, lastRichDashboardReadyTimeout: at };
}

export function recordRichDashboardUsed(): void {
  diagnostics = { ...diagnostics, lastRendererUsed: 'rich-webview' };
}

export function recordSafeDashboardFallback(at = Date.now()): void {
  diagnostics = {
    ...diagnostics,
    lastFallbackAction: 'open-safe-dashboard',
    lastRichDashboardReadyTimeout: diagnostics.lastRichDashboardReadyTimeout ?? at,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeText(value: unknown, maximum = 160): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  const normalized = redactor
    .redact(String(value))
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function safeMarkdownText(value: unknown, maximum = 160): string | undefined {
  const normalized = safeText(value, maximum);
  return normalized
    ?.replace(/\bcommand:/gi, 'command :')
    ?.replace(/[\\`*_[\]<>#|!]/g, (character) => `\\${character}`)
    .replace(/[()]/g, (character) => `\\${character}`);
}

function safeTimestamp(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  return normalizeToEpochMs(value, 'unix-millis') ?? undefined;
}

function safeResetTimestamp(value: unknown, now: number): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  return normalizeToEpochMs(value, 'unix-seconds', now) ?? undefined;
}

function safeNumber(value: unknown): string | undefined {
  return isFiniteNumber(value) ? value.toLocaleString() : undefined;
}

function localizedOverallState(
  value: string,
  catalog: ReturnType<typeof getUiTextCatalog>,
): string {
  if (value === 'Ready') return catalog.ready;
  if (value === 'Attention required') return catalog.attentionRequired;
  if (value === 'Some providers need attention') return catalog.someProvidersNeedAttention;
  if (value === 'No active provider data') return catalog.noActiveProviderData;
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function localizedSourceLabel(value: string, catalog: ReturnType<typeof getUiTextCatalog>): string {
  return value;
  /* istanbul ignore next -- legacy source text compatibility. */
  // eslint-disable-next-line no-unreachable
  if (catalog === getUiTextCatalog('en')) return value;
  return value
    .replace(/\bOfficial\b/g, catalog.official)
    .replace(/\bExperimental\b/g, catalog.experimental)
    .replace(/\bCommunity\b/g, catalog.community)
    .replace(/\bSource\b/g, catalog.source)
    .replace(/\busage\b/gi, catalog.usageNoun);
}

function localizedMetricLabel(value: string, catalog: ReturnType<typeof getUiTextCatalog>): string {
  const labels: Record<string, string> = {
    'AI credits used': catalog.aiCredits,
    'AI credits allowance': catalog.remaining,
    'Premium interactions': catalog.premiumInteractions,
    'Chat quota': catalog.chatQuota,
    'Completions quota': catalog.completionsQuota,
    'Account management': catalog.accountManagement,
    'Endpoint plan': catalog.endpointPlan,
    'Build usage': catalog.buildUsage,
    'Extra credits': catalog.extraCredits,
    'Context used %': catalog.contextUsed,
    'Context remaining %': catalog.contextRemaining,
    'Session cost USD': catalog.sessionCostUsd,
    Model: catalog.model,
  };
  return labels[value] ?? value;
}

const SAFE_DASHBOARD_LINK_IDS: Readonly<Record<ProviderId, readonly ProviderLinkId[]>> = {
  codex: ['codex-usage', 'codex-cli-docs', 'codex-limits-docs'],
  claude: ['claude-usage', 'claude-install', 'claude-vscode-docs'],
  copilot: ['copilot-billing', 'copilot-usage-docs', 'copilot-cli-install', 'copilot-settings'],
  grok: ['grok-billing', 'grok-install', 'grok-cli-reference', 'grok-official-repository'],
};

function linksFor(providerId: ProviderId): readonly SafeProviderLink[] {
  return SAFE_DASHBOARD_LINK_IDS[providerId].map((id) => {
    const link = getProviderLink(id);
    return {
      id: link.id,
      label: link.label,
      url: link.url,
      category: link.category,
      requiresAuthentication: link.requiresAuthentication,
    };
  });
}

function commandsFor(providerId: string, active: boolean): string[] {
  if (active) {
    switch (providerId) {
      case 'codex':
        return [
          'AI Limit Ledger: Refresh Codex Usage',
          `AI Limit Ledger: ${getProviderLink('codex-usage').label}`,
        ];
      case 'claude':
        return [
          'AI Limit Ledger: Refresh Claude Usage',
          `AI Limit Ledger: ${getProviderLink('claude-usage').label}`,
        ];
      case 'copilot':
        return [
          'AI Limit Ledger: Refresh GitHub Copilot Usage',
          `AI Limit Ledger: ${getProviderLink('copilot-billing').label}`,
        ];
      case 'grok':
        return [
          'AI Limit Ledger: Refresh Grok Usage',
          `AI Limit Ledger: ${getProviderLink('grok-billing').label}`,
          'AI Limit Ledger: Copy /usage',
        ];
      default:
        return [];
    }
  }
  switch (providerId) {
    case 'grok':
      return [
        `AI Limit Ledger: ${getProviderLink('grok-install').label}`,
        'AI Limit Ledger: Recheck Grok Installation',
      ];
    case 'claude':
      return ['AI Limit Ledger: Enable Claude Code Integration'];
    case 'copilot':
      return ['AI Limit Ledger: Connect GitHub Copilot Usage'];
    default:
      return [];
  }
}

function metricsFor(providerId: string, snapshot: ProviderSnapshot): SafeMetric[] {
  const metrics: SafeMetric[] = [];
  const add = (label: string, value: unknown): void => {
    const formatted = safeNumber(value);
    if (formatted !== undefined) metrics.push({ label, value: formatted });
  };
  const metadata = snapshot.metadata ?? {};

  if (providerId === 'copilot') {
    add('AI credits used', snapshot.credits?.used ?? metadata.aiCreditsUsed);
    add('AI credits allowance', snapshot.credits?.allowance);
    add('Premium interactions', metadata.premiumInteractionsCreditsUsed);
    add('Chat quota', metadata.chatCreditsUsed);
    add('Completions quota', metadata.completionsCreditsUsed);
    const accountManagement = safeMarkdownText(metadata.accountManagement) ?? 'Not provided';
    const endpointPlan = safeMarkdownText(metadata.endpointPlan) ?? safeMarkdownText(snapshot.plan);
    metrics.push({ label: 'Account management', value: accountManagement });
    if (endpointPlan) metrics.push({ label: 'Endpoint plan', value: endpointPlan });
  }
  if (providerId === 'grok') {
    add('Build usage', metadata.buildUsage);
    add('Extra credits', metadata.extraCredits ?? metadata.extraCreditBalance);
  }
  if (providerId === 'claude') {
    add('Context used %', snapshot.tokens?.contextUsedPercent);
    add('Context remaining %', snapshot.tokens?.contextRemainingPercent);
    add('Session cost USD', snapshot.tokens?.totalCostUsd);
    const model = safeMarkdownText(metadata.modelName ?? metadata.modelId);
    if (model) metrics.push({ label: 'Model', value: model });
  }
  return metrics;
}

const INSIGHT_LABELS: Readonly<Record<string, keyof ReturnType<typeof getUiTextCatalog>>> = {
  planType: 'plan',
  rateLimits: 'usageWindow',
  lifetimeTokens: 'lifetimeTokens',
  peakDailyTokens: 'peakDailyTokens',
  longestRunningTurn: 'longestTurn',
  currentStreak: 'currentStreak',
  longestStreak: 'longestStreak',
  resetCreditsAvailable: 'resetCredits',
  resetCreditExpiresAt: 'resetAt',
  aiCreditsUsed: 'aiCredits',
  aiCreditsAllowance: 'aiCreditsAllowance',
  aiCreditsRemainingPercent: 'aiCreditsRemaining',
  resetAt: 'resetAt',
  accountManagement: 'accountManagement',
  endpointPlan: 'endpointPlan',
  configuredBillingScope: 'configuredBillingScope',
  tokenBasedBilling: 'tokenBasedBilling',
  chatQuota: 'chatQuota',
  completionQuota: 'completionsQuota',
  legacyPremiumInteractions: 'legacyPremiumInteractions',
  productBreakdown: 'productBreakdown',
  modelBreakdown: 'productBreakdown',
  buildUsage: 'buildUsage',
  extraCreditBalance: 'extraCreditBalance',
  model: 'model',
  cliVersion: 'cli',
  contextCapacity: 'contextCapacity',
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  cacheCreationInputTokens: 'cacheCreationInputTokens',
  cacheReadInputTokens: 'cacheReadInputTokens',
  contextUsed: 'contextUsed',
  contextRemaining: 'contextRemaining',
  estimatedSessionCost: 'estimatedSessionCost',
  sessionDuration: 'sessionDuration',
  apiWaitTime: 'apiWaitTime',
  linesAdded: 'linesAdded',
  linesRemoved: 'linesRemoved',
  fastMode: 'fastMode',
  effortLevel: 'effortLevel',
  thinking: 'thinking',
  exceeds200kTokens: 'exceeds200kTokens',
  outputStyle: 'outputStyle',
  dailyTokens: 'lifetimeTokens',
};

export function localizedInsightLabel(
  label: string,
  catalog: ReturnType<typeof getUiTextCatalog>,
): string {
  const key = INSIGHT_LABELS[label];
  return key ? catalog[key] : label;
}

function insightValueText(
  insight: UsageInsightValue<unknown>,
  now: number,
  catalog: ReturnType<typeof getUiTextCatalog>,
): string | undefined {
  if (typeof insight.value === 'number') {
    if (!Number.isFinite(insight.value) || insight.value < 0) return undefined;
    if (insight.unit === 'date')
      return formatDate(
        insight.value,
        now,
        'both',
        catalog === getUiTextCatalog('tr') ? 'tr' : 'en',
        'deadline',
      );
    if (insight.unit === 'percent') return `${insight.value.toLocaleString()}%`;
    if (insight.unit === 'usd') return `$${insight.value.toFixed(2)}`;
    if (insight.unit === 'milliseconds') return `${insight.value.toLocaleString()} ms`;
    return insight.value.toLocaleString();
  }
  if (typeof insight.value === 'boolean') return insight.value ? catalog.yes : catalog.no;
  const text = safeMarkdownText(insight.value);
  return text;
}

export function safeUsageInsightsForSnapshot(
  snapshot: ProviderSnapshot,
  now: number,
  language: 'auto' | 'en' | 'tr',
): SafeUsageInsight[] {
  const insights = snapshot.usageInsights;
  if (!insights) return [];
  const catalog = getUiTextCatalog(language);
  const values: Array<{ label: string; insight: UsageInsightValue<unknown> }> = [];
  const account = insights.accountMetrics ?? {};
  const accountEntries: Array<[string, UsageInsightValue<unknown> | undefined]> = [
    ['planType', account.planType as UsageInsightValue<unknown> | undefined],
    ['lifetimeTokens', account.lifetimeTokens as UsageInsightValue<unknown> | undefined],
    ['peakDailyTokens', account.peakDailyTokens as UsageInsightValue<unknown> | undefined],
    [
      'longestRunningTurn',
      account.longestRunningTurnSeconds as UsageInsightValue<unknown> | undefined,
    ],
    ['currentStreak', account.currentStreakDays as UsageInsightValue<unknown> | undefined],
    ['longestStreak', account.longestStreakDays as UsageInsightValue<unknown> | undefined],
    [
      'resetCreditsAvailable',
      account.resetCreditsAvailable as UsageInsightValue<unknown> | undefined,
    ],
    [
      'resetCreditExpiresAt',
      account.resetCreditExpiresAt as UsageInsightValue<unknown> | undefined,
    ],
    ['aiCreditsUsed', account.aiCreditsUsed as UsageInsightValue<unknown> | undefined],
    ['aiCreditsAllowance', account.aiCreditsAllowance as UsageInsightValue<unknown> | undefined],
    [
      'aiCreditsRemainingPercent',
      account.aiCreditsRemainingPercent as UsageInsightValue<unknown> | undefined,
    ],
    ['resetAt', account.resetAt as UsageInsightValue<unknown> | undefined],
    ['accountManagement', account.accountManagement as UsageInsightValue<unknown> | undefined],
    ['endpointPlan', account.endpointPlan as UsageInsightValue<unknown> | undefined],
    [
      'configuredBillingScope',
      account.configuredBillingScope as UsageInsightValue<unknown> | undefined,
    ],
    ['tokenBasedBilling', account.tokenBasedBilling as UsageInsightValue<unknown> | undefined],
    ['chatQuota', account.chatQuota as UsageInsightValue<unknown> | undefined],
    ['completionQuota', account.completionQuota as UsageInsightValue<unknown> | undefined],
    [
      'legacyPremiumInteractions',
      account.legacyPremiumInteractions as UsageInsightValue<unknown> | undefined,
    ],
    ['productBreakdown', account.productBreakdown as UsageInsightValue<unknown> | undefined],
    ['buildUsage', account.buildUsage as UsageInsightValue<unknown> | undefined],
    ['extraCreditBalance', account.extraCreditBalance as UsageInsightValue<unknown> | undefined],
  ];
  for (const [label, insight] of accountEntries) {
    if (!insight) continue;
    const displayValue = Array.isArray(insight.value)
      ? insight.unit === 'date'
        ? insight.value
            .map((value) =>
              typeof value === 'number'
                ? formatDate(safeResetTimestamp(value, now), now, 'both', language, 'deadline')
                : undefined,
            )
            .filter(Boolean)
            .join(', ')
        : insight.value
            .map((value) => safeMarkdownText(value))
            .filter(Boolean)
            .join(', ')
      : insightValueText(insight, now, catalog);
    if (displayValue) values.push({ label, insight: { ...insight, value: displayValue } });
  }
  const session = insights.sessionMetrics;
  if (session) {
    const sessionEntries: Array<[string, UsageInsightValue<unknown> | undefined]> = [
      ['model', session.modelDisplayName ?? session.modelId],
      ['cliVersion', session.cliVersion],
      ['contextCapacity', session.contextWindowSize],
      ['inputTokens', session.inputTokens],
      ['outputTokens', session.outputTokens],
      ['cacheCreationInputTokens', session.cacheCreationInputTokens],
      ['cacheReadInputTokens', session.cacheReadInputTokens],
      ['contextUsed', session.contextUsedPercent],
      ['contextRemaining', session.contextRemainingPercent],
      ['estimatedSessionCost', session.estimatedCostUsd],
      ['sessionDuration', session.totalDurationMs],
      ['apiWaitTime', session.totalApiDurationMs],
      ['linesAdded', session.linesAdded],
      ['linesRemoved', session.linesRemoved],
      ['fastMode', session.fastMode],
      ['effortLevel', session.effortLevel],
      ['thinking', session.thinkingEnabled],
      ['exceeds200kTokens', session.exceeds200kTokens],
      ['outputStyle', session.outputStyle],
    ];
    for (const [label, insight] of sessionEntries) {
      if (!insight) continue;
      const displayValue = insightValueText(insight, now, catalog);
      if (displayValue) values.push({ label, insight: { ...insight, value: displayValue } });
    }
  }
  for (const bucket of (insights.trend?.dailyTokenUsage ?? []).slice(-14)) {
    const displayValue = insightValueText(
      bucket.tokens as UsageInsightValue<unknown>,
      now,
      catalog,
    );
    if (displayValue)
      values.push({
        label: `dailyTokens:${bucket.date}`,
        insight: { ...bucket.tokens, value: displayValue },
      });
  }
  return values.map(({ label, insight }) => ({
    label,
    value: String(insight.value),
    unit: insight.unit,
    sourceKind: insight.sourceKind,
    sourceLabel: safeText(insight.sourceLabel, 180) ?? catalog.notProvided,
    observedAt: insight.observedAt,
    isEstimated: insight.isEstimated,
    isDerived: insight.isDerived,
    isExperimental: insight.isExperimental,
  }));
}

function explanationKeyFor(
  providerId: string,
  snapshot: ProviderSnapshot,
  presentation: ProviderPresentationState,
  hasNumericUsage: boolean,
): LocalizationKey | undefined {
  if (
    providerId === 'grok' &&
    snapshot.connected &&
    String(snapshot.plan ?? '').toLowerCase() === 'free' &&
    !hasNumericUsage
  ) {
    return 'numericUsageNotExposed';
  }
  if (providerId === 'copilot' && !hasNumericUsage) {
    return 'monthlyAllowanceNotProvided';
  }
  if (snapshot.stale || presentation.dataAvailability === 'numeric-last-known-good') {
    return 'showingLastKnownUsage';
  }
  return hasNumericUsage
    ? presentation.explanationKey
    : (presentation.explanationKey ?? 'numericUsageUnavailable');
}

function requirementKeyFor(providerId: string): LocalizationKey {
  switch (providerId) {
    case 'codex':
      return 'codexAutomaticUsageRequirement';
    case 'claude':
      return 'claudeAutomaticUsageRequirement';
    case 'copilot':
      return 'copilotAutomaticUsageRequirement';
    case 'grok':
      return 'grokAutomaticUsageRequirement';
    default:
      return 'providerIntegrationSetup';
  }
}

function providerModel(
  snapshot: ProviderSnapshot,
  presentation: ProviderPresentationState,
  now: number,
  thresholds: RemainingCapacityThresholds = {},
  insightsMode: InsightsMode = 'summary',
  language: 'auto' | 'en' | 'tr' = 'auto',
): SafeProviderDocumentModel {
  const providerId = presentation.providerId;
  const semantic = buildProviderPresentationSummary(snapshot, {
    now,
    thresholds,
    language,
    resolved: presentation,
  });
  const usageWindows = semantic.quotaWindows.map((window) => ({
    id: safeText(window.id, 80) ?? 'usage-window',
    label: safeMarkdownText(window.label, 80) ?? 'Usage window',
    ...(window.usedPercentage !== undefined ? { usedPercent: window.usedPercentage } : {}),
    ...(window.remainingPercentage !== undefined
      ? { remainingPercent: window.remainingPercentage }
      : {}),
    ...(window.reset ? { resetsAt: window.reset.at } : {}),
  }));
  const hasNumericUsage = usageWindows.some((window) => window.usedPercent !== undefined);
  const sourceKind = presentation.sourceKind;
  const plan = safeMarkdownText(snapshot.plan);
  const cliVersion = safeMarkdownText(snapshot.cliVersion);
  const extensionVersion = safeMarkdownText(
    snapshot.extensionVersion ?? snapshot.metadata?.extensionVersion,
  );
  const lastCheckAt = safeTimestamp(snapshot.checkedAt ?? snapshot.observedAt);
  const lastSuccessfulUpdateAt =
    safeTimestamp(snapshot.lastSuccessfulDataUpdate ?? snapshot.lastSuccessfulUpdateAt) ??
    (hasNumericUsage ? safeTimestamp(snapshot.observedAt) : undefined);
  const lastProviderEventAt = safeTimestamp(snapshot.lastProviderEventAt);
  const nextRefreshAt = safeTimestamp(
    snapshot.nextFallbackRefreshAt ?? snapshot.metadata?.nextRefreshAt,
  );
  const backoffUntil = safeTimestamp(snapshot.retryAt);
  const guidance = getProviderInstallGuidance(providerId as ProviderId);
  const explanationKey = explanationKeyFor(providerId, snapshot, presentation, hasNumericUsage);
  return {
    providerId,
    displayName: presentation.descriptor?.displayName ?? providerId,
    normalizedState: presentation.normalizedState,
    statusKey: presentation.statusKey,
    ...(explanationKey ? { explanationKey } : {}),
    ...(presentation.dashboardPlacement === 'available'
      ? { requirementKey: requirementKeyFor(providerId) }
      : {}),
    sourceKind,
    sourceLabel: semantic.provenance[0]?.label,
    freshness: semantic.freshness,
    experimental: sourceKind.startsWith('experimental'),
    stale: snapshot.stale || presentation.dataAvailability === 'numeric-last-known-good',
    usageWindows,
    rawMetrics: metricsFor(providerId, snapshot),
    usageInsights: safeUsageInsightsForSnapshot(snapshot, now, language),
    insightsMode,
    ...(plan ? { plan } : {}),
    ...(cliVersion ? { cliVersion } : {}),
    ...(extensionVersion ? { extensionVersion } : {}),
    ...(lastCheckAt !== undefined ? { lastCheckAt } : {}),
    ...(lastSuccessfulUpdateAt !== undefined ? { lastSuccessfulUpdateAt } : {}),
    ...(lastProviderEventAt !== undefined ? { lastProviderEventAt } : {}),
    ...(nextRefreshAt !== undefined ? { nextRefreshAt } : {}),
    ...(backoffUntil !== undefined ? { backoffUntil } : {}),
    ...(guidance.cliUsageInstruction ? { cliUsageInstruction: guidance.cliUsageInstruction } : {}),
    links: linksFor(providerId as ProviderId),
    commands: commandsFor(providerId, presentation.dashboardPlacement === 'active'),
  };
}

export function buildSafeDashboardDocumentModel(
  snapshots: readonly ProviderSnapshot[],
  options: {
    selectedProviderIds?: readonly string[];
    now?: number;
    version?: string;
    providerVisibility?: 'auto' | 'active-only' | 'all-supported';
    providerOrder?: readonly string[];
    showAvailableIntegrations?: boolean;
    percentageMode?: 'remaining' | 'used' | 'both';
    thresholds?: RemainingCapacityThresholds;
    language?: 'auto' | 'en' | 'tr';
    dashboardMode?: string;
    statusBarMode?: string;
    tooltipDensity?: string;
    insightsMode?: InsightsMode;
    notificationLevel?: string;
    timeFormat?: 'locale' | 'relative' | 'absolute' | 'both';
  } = {},
): SafeDashboardDocumentModel {
  const now = options.now ?? Date.now();
  const thresholds = options.thresholds ?? {};
  const presentations = resolveProviderPresentations(snapshots, {
    selectedProviderIds: options.selectedProviderIds,
    now,
  });
  const snapshotById = new Map(
    snapshots.map((snapshot) => [normalizeProviderId(snapshot.providerId), snapshot]),
  );
  const models = presentations
    .filter((presentation) => presentation.dashboardPlacement !== 'hidden')
    .flatMap((presentation) => {
      const snapshot = snapshotById.get(normalizeProviderId(presentation.providerId));
      return snapshot
        ? [
            providerModel(
              snapshot,
              presentation,
              now,
              thresholds,
              options.insightsMode ?? 'summary',
              options.language ?? 'auto',
            ),
          ]
        : [];
    });
  const activeProviders = models.filter((model) =>
    presentations.some(
      (presentation) =>
        presentation.providerId === model.providerId &&
        presentation.dashboardPlacement === 'active',
    ),
  );
  const order = (options.providerOrder ?? ['codex', 'claude', 'copilot', 'grok']).map(
    normalizeProviderId,
  );
  const sortByOrder = (left: SafeProviderDocumentModel, right: SafeProviderDocumentModel): number =>
    order.indexOf(left.providerId) - order.indexOf(right.providerId);
  activeProviders.sort(sortByOrder);
  const availableProviders = models
    .filter((model) => !activeProviders.includes(model))
    .sort(sortByOrder);
  if (options.providerVisibility === 'active-only' || options.showAvailableIntegrations === false)
    availableProviders.length = 0;
  const hasError = presentations.some(
    (presentation) =>
      presentation.dashboardPlacement !== 'hidden' && presentation.attention === 'error',
  );
  const hasWarning = presentations.some(
    (presentation) =>
      presentation.dashboardPlacement !== 'hidden' && presentation.attention === 'warning',
  );
  return {
    generatedAt: now,
    activeProviders,
    availableProviders,
    overallState: hasError
      ? 'Attention required'
      : hasWarning
        ? 'Some providers need attention'
        : activeProviders.length > 0
          ? 'Ready'
          : 'No active provider data',
    version: options.version ?? SAFE_DASHBOARD_VERSION,
    percentageMode: options.percentageMode ?? 'remaining',
    thresholds,
    preferences: {
      dashboardMode: options.dashboardMode ?? 'auto',
      statusBarMode: options.statusBarMode ?? 'compact',
      tooltipDensity: options.tooltipDensity ?? 'detailed',
      notificationLevel: options.notificationLevel ?? 'errors',
      timeFormat: options.timeFormat ?? 'both',
      language: options.language ?? 'auto',
      insightsMode: options.insightsMode ?? 'summary',
    },
  };
}

function formatDate(
  value: number | undefined,
  now: number,
  timeFormat: string,
  language: 'auto' | 'en' | 'tr' = 'auto',
  role: 'past-event' | 'future-target' | 'deadline' | 'snapshot-age' = 'snapshot-age',
): string {
  return formatConfiguredTime(
    value,
    now,
    timeFormat === 'locale' ||
      timeFormat === 'relative' ||
      timeFormat === 'absolute' ||
      timeFormat === 'both'
      ? timeFormat
      : 'both',
    getUiTextCatalog(language),
    role,
  );
}

function formatCountdown(
  value: number | undefined,
  now: number,
  language: 'auto' | 'en' | 'tr' = 'auto',
  role: 'future-target' | 'deadline' = 'future-target',
): string {
  const catalog = getUiTextCatalog(language);
  const turkish = catalog === getUiTextCatalog('tr');
  if (value === undefined) return catalog.notProvided;
  return formatConfiguredTime(value, now, 'relative', catalog, role);
  /* istanbul ignore next -- legacy countdown implementation retained for compatibility. */
  // eslint-disable-next-line no-unreachable
  const seconds = Math.max(0, Math.ceil(((value as number) - now) / 1000));
  if (seconds === 0) return catalog.now;
  if (seconds < 60) return turkish ? `${seconds} sn içinde` : `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return turkish ? `${minutes} dk içinde` : `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24)
    return turkish
      ? `${hours} sa${remainingMinutes ? ` ${remainingMinutes} dk` : ''} içinde`
      : `in ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ''}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return turkish
    ? `${days} gün${remainingHours ? ` ${remainingHours} sa` : ''} içinde`
    : `in ${days}d${remainingHours ? ` ${remainingHours}h` : ''}`;
}

function progressBar(
  usedPercent: number | undefined,
  remainingPercent: number | undefined,
  thresholds: RemainingCapacityThresholds,
  percentageMode: SafeDashboardDocumentModel['percentageMode'],
  language: 'auto' | 'en' | 'tr',
): string | undefined {
  const progress = createRemainingCapacityProgress(usedPercent, thresholds);
  const catalog = getUiTextCatalog(language);
  if (!progress) {
    if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent))
      return undefined;
    const remaining = Math.min(100, Math.max(0, Math.round(remainingPercent * 10) / 10));
    const used = Math.round((100 - remaining) * 10) / 10;
    return percentageMode === 'remaining'
      ? `${remaining}% ${catalog.remaining.toLowerCase()}`
      : percentageText(remaining, used, percentageMode, catalog);
  }
  const filled = Math.min(10, Math.max(0, Math.round(progress.remainingPercent / 10)));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  const statusText =
    progress.severity === 'critical'
      ? catalog.critical
      : progress.severity === 'warning'
        ? catalog.warning
        : undefined;
  const status = statusText ? ` · ${statusText}` : '';
  const text =
    percentageMode === 'remaining'
      ? `${progress.remainingPercent}% ${catalog.remaining.toLowerCase()}`
      : percentageText(progress.remainingPercent, progress.usedPercent, percentageMode, catalog);
  return `[${bar}] ${text}${status}`;
}

function localizedCommand(
  value: string,
  providerId: string,
  catalog: ReturnType<typeof getUiTextCatalog>,
): string {
  if (/open .*usage|open .*billing/i.test(value)) {
    const linkId =
      providerId === 'codex'
        ? 'codex-usage'
        : providerId === 'claude'
          ? 'claude-usage'
          : providerId === 'copilot'
            ? 'copilot-billing'
            : 'grok-billing';
    return localizedProviderLinkLabel(linkId, catalog);
  }
  if (/refresh codex/i.test(value)) return `${catalog.refresh} Codex`;
  if (/refresh claude/i.test(value)) return `${catalog.refresh} Claude`;
  if (/refresh github copilot/i.test(value)) return `${catalog.refresh} GitHub Copilot`;
  if (/refresh grok/i.test(value)) return `${catalog.refresh} Grok`;
  if (/recheck grok/i.test(value)) return `${catalog.recheckInstallation} Grok`;
  if (/connect github copilot/i.test(value)) return `${catalog.connect} GitHub Copilot`;
  if (/enable claude/i.test(value)) return `${catalog.enableIntegration}: Claude`;
  return value;
}

export function insightSourceKindLabel(
  value: string,
  catalog: ReturnType<typeof getUiTextCatalog>,
): string {
  if (value === 'derived') return catalog.derivedMetric;
  if (value === 'experimental-undocumented') return catalog.experimentalSource;
  if (value === 'user-configured') return catalog.configuredBillingScope;
  return catalog.official;
}

function renderUsageInsights(
  model: SafeProviderDocumentModel,
  catalog: ReturnType<typeof getUiTextCatalog>,
): string[] {
  if (model.insightsMode === 'hidden' || model.usageInsights.length === 0) return [];
  const entries = model.usageInsights.filter((insight) => {
    if (insight.label === 'planType' && model.plan) return false;
    if (insight.label === 'rateLimits') return false;
    if (insight.label === 'resetAt' && model.usageWindows.some((window) => window.resetsAt))
      return false;
    if (insight.label === 'aiCreditsRemainingPercent' && model.usageWindows.length > 0)
      return false;
    if (!insight.label.startsWith('dailyTokens:')) return true;
    return model.insightsMode === 'detailed';
  });
  const visible = model.insightsMode === 'summary' ? entries.slice(0, 5) : entries;
  if (visible.length === 0) return [];
  const sessionLabels = new Set([
    'model',
    'cliVersion',
    'contextCapacity',
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'contextUsed',
    'contextRemaining',
    'estimatedSessionCost',
    'sessionDuration',
    'apiWaitTime',
    'linesAdded',
    'linesRemoved',
    'fastMode',
    'effortLevel',
    'thinking',
    'exceeds200kTokens',
    'outputStyle',
  ]);
  const accountEntries = visible.filter((insight) => !sessionLabels.has(insight.label));
  const sessionEntries = visible.filter((insight) => sessionLabels.has(insight.label));
  const renderTable = (tableEntries: readonly SafeUsageInsight[]): string[] => {
    const hasFieldProvenance = tableEntries.some(
      (insight) => insight.sourceKind !== model.sourceKind,
    );
    const rows = tableEntries.map((insight) => {
      const label = insight.label.startsWith('dailyTokens:')
        ? `${catalog.lifetimeTokens} (${insight.label.slice('dailyTokens:'.length)})`
        : localizedInsightLabel(insight.label, catalog);
      const flags = [
        insight.isEstimated ? catalog.estimatedSessionCost : '',
        insight.isDerived ? catalog.derivedMetric : '',
        insight.isExperimental ? catalog.experimentalSource : '',
      ].filter(Boolean);
      const provenance = hasFieldProvenance
        ? ` | ${insightSourceKindLabel(insight.sourceKind, catalog)}: ${insight.sourceLabel}`
        : '';
      return `| ${label} | ${insight.value}${flags.length ? ` (${flags.join(', ')})` : ''}${provenance} |`;
    });
    return [
      hasFieldProvenance
        ? `| ${catalog.metric} | ${catalog.value} | ${catalog.sourceProvenance} |`
        : `| ${catalog.metric} | ${catalog.value} |`,
      hasFieldProvenance ? '|---|---|---|' : '|---|---|',
      ...rows,
    ];
  };
  const lines = [
    `### ${catalog.usageInsights}`,
    '',
    ...(model.sourceLabel ? [`_${catalog.sourceProvenance}: ${model.sourceLabel}_`, ''] : []),
  ];
  if (accountEntries.length)
    lines.push(`**${catalog.accountSummary}**`, '', ...renderTable(accountEntries));
  if (sessionEntries.length)
    lines.push('', `**${catalog.latestObservedCliSession}**`, '', ...renderTable(sessionEntries));
  if (model.insightsMode === 'summary' && entries.length > visible.length)
    lines.push(
      '',
      `${catalog.detailed}: ${entries.length - visible.length} ${catalog.usageInsights.toLowerCase()}`,
    );
  return lines;
}

function renderProvider(
  model: SafeProviderDocumentModel,
  now: number,
  thresholds: RemainingCapacityThresholds,
  percentageMode: SafeDashboardDocumentModel['percentageMode'],
  timeFormat: string,
  language: 'auto' | 'en' | 'tr',
): string {
  const catalog = getUiTextCatalog(language);
  const status = `${catalog[model.statusKey]}${model.experimental ? ` — ${catalog.experimental}` : ''}`;
  const lines = [
    `### ${model.displayName}`,
    '',
    `${catalog.status}: ${status}`,
    `${catalog.source}: ${model.sourceLabel ?? localizedProviderSourceLabel(model.providerId as ProviderId, model.sourceKind, catalog)}`,
  ];
  if (model.plan) lines.push(`${catalog.plan}: ${model.plan}`);
  if (model.cliVersion) lines.push(`${catalog.cli}: ${model.cliVersion}`);
  if (model.extensionVersion) lines.push(`${catalog.extension}: ${model.extensionVersion}`);
  if (model.explanationKey) lines.push(`${catalog.note}: ${catalog[model.explanationKey]}`);
  if (model.requirementKey) lines.push(`${catalog.requirement}: ${catalog[model.requirementKey]}`);
  if (model.cliUsageInstruction)
    lines.push(
      `${catalog.usageInstruction}: ${localizedProviderGuidance(model.providerId as ProviderId, catalog).cliUsageInstruction ?? model.cliUsageInstruction}`,
    );
  lines.push('');
  if (model.usageWindows.length > 0) {
    for (const window of model.usageWindows) {
      lines.push(window.label);
      const progress = progressBar(
        window.usedPercent,
        window.remainingPercent,
        thresholds,
        percentageMode,
        language,
      );
      lines.push(progress ?? catalog.numericUsageUnavailable);
      if (window.resetsAt !== undefined)
        lines.push(
          `${catalog.reset}: ${formatDate(window.resetsAt, now, timeFormat, language, 'deadline')}`,
        );
      lines.push('');
    }
  } else if (model.providerId === 'grok' && model.plan?.toLowerCase() === 'free') {
    lines.push(`${catalog.connection}: ${catalog.connected}`, catalog.freeNoNumericUsage, '');
  } else {
    lines.push(`${catalog.usageWindow}: ${catalog.numericUsageUnavailable}`, '');
  }
  const insightLines = renderUsageInsights(model, catalog);
  if (insightLines.length) lines.push(...insightLines, '');
  for (const metric of model.rawMetrics)
    lines.push(`${localizedMetricLabel(metric.label, catalog)}: ${metric.value}`);
  if (model.freshness.state === 'fresh') {
    lines.push(`${catalog.dataFreshness}: ${model.freshness.summaryText}`);
  } else {
    lines.push(catalog.dataFreshness);
    lines.push(...model.freshness.detailLines.map((line) => `${line.label}: ${line.value}`));
  }
  if (model.nextRefreshAt !== undefined)
    lines.push(
      `${catalog.nextAutomaticCheck}: ${formatCountdown(model.nextRefreshAt, now, language, 'future-target')}`,
    );
  if (model.backoffUntil !== undefined)
    lines.push(
      `${catalog.backoff}: ${formatCountdown(model.backoffUntil, now, language, 'future-target')}`,
    );
  if (model.links.length > 0) {
    lines.push('', catalog.officialLinks);
    lines.push(
      ...model.links.map(
        (link) =>
          `- ${localizedProviderLinkLabel(link.id, catalog)}: ${link.url}${link.requiresAuthentication ? ` (${catalog.signInInBrowser})` : ''}`,
      ),
    );
  }
  if (model.stale) lines.push(`${catalog.dataState}: ${catalog.lastKnownGood}`);
  if (model.commands.length > 0) {
    lines.push('', `${catalog.commands}:`);
    lines.push(
      ...model.commands.map(
        (command) => `- ${localizedCommand(command, model.providerId, catalog)}`,
      ),
    );
  }
  return lines.join('\n');
}

export function renderSafeDashboard(model: SafeDashboardDocumentModel): string {
  const now = model.generatedAt;
  const catalog = getUiTextCatalog(model.preferences.language);
  const lines = [
    `# ${catalog.dashboardTitle} — ${catalog.safeNative}`,
    '',
    catalog.safeNative,
    '',
    catalog.safeDashboardIntro,
    '',
    `${catalog.generated}: ${formatDate(model.generatedAt, now, model.preferences.timeFormat, model.preferences.language)}`,
    `${catalog.activeProviders}: ${model.activeProviders.length}`,
    `${catalog.status}: ${localizedOverallState(model.overallState, catalog)}`,
    `${catalog.settings}: ${safePreferenceSummary(model)}`,
    '',
    `## ${catalog.activeProviders}`,
    '',
    model.activeProviders.length
      ? model.activeProviders
          .map((provider) =>
            renderProvider(
              provider,
              now,
              model.thresholds,
              model.percentageMode,
              model.preferences.timeFormat,
              model.preferences.language,
            ),
          )
          .join('\n\n---\n\n')
      : catalog.noActiveProvidersReporting,
    '',
    `## ${catalog.availableIntegrations}`,
    '',
    model.availableProviders.length
      ? model.availableProviders
          .map((provider) =>
            renderProvider(
              provider,
              now,
              model.thresholds,
              model.percentageMode,
              model.preferences.timeFormat,
              model.preferences.language,
            ),
          )
          .join('\n\n---\n\n')
      : catalog.allIntegrationsActive,
    '',
    `${catalog.dashboardTitle} v${model.version}`,
  ];
  const activeIndex = lines.findIndex((line) => line.startsWith(`${catalog.activeProviders}:`));
  if (activeIndex >= 0)
    lines[activeIndex] = formatSafeProviderCount(model.activeProviders.length, catalog);
  return `${lines.join('\n')}\n`;
}

function formatSafeProviderCount(
  count: number,
  catalog: ReturnType<typeof getUiTextCatalog>,
): string {
  const plural =
    catalog === getUiTextCatalog('tr') || count !== 1
      ? catalog.activeProviderCountPlural
      : catalog.activeProviderCountSingular;
  return plural.replace('{count}', String(count));
}

function safePreferenceSummary(model: SafeDashboardDocumentModel): string {
  const catalog = getUiTextCatalog(model.preferences.language);
  const value = (input: string): string => {
    switch (input) {
      case 'auto':
        return catalog.auto;
      case 'remaining':
        return catalog.remaining;
      case 'used':
        return catalog.used;
      case 'both':
        return catalog.both;
      case 'summary':
        return catalog.summary;
      case 'compact':
        return catalog.compact;
      case 'detailed':
        return catalog.detailed;
      case 'hidden':
        return catalog.hidden;
      case 'rich-webview':
        return catalog.richWebview;
      case 'safe-native':
        return catalog.safeNative;
      case 'off':
        return catalog.notificationsOff;
      case 'errors':
        return catalog.errorsOnly;
      case 'warnings-and-errors':
        return catalog.warningsAndErrors;
      case 'locale':
        return catalog.localeTimeFormat;
      case 'relative':
        return catalog.relativeTimeFormat;
      case 'absolute':
        return catalog.absoluteTimeFormat;
      default:
        return catalog.notProvided;
    }
  };
  const language =
    model.preferences.language === 'en'
      ? catalog.displayLanguageEnglish
      : model.preferences.language === 'tr'
        ? catalog.displayLanguageTurkish
        : catalog.displayLanguageAuto;
  const timeFormat =
    model.preferences.timeFormat === 'both'
      ? catalog.bothTimeFormat
      : value(model.preferences.timeFormat);
  return `${catalog.dashboard}: ${value(model.preferences.dashboardMode)} · ${catalog.status}: ${value(model.preferences.statusBarMode)} · ${catalog.percentageDisplay}: ${value(model.percentageMode)} · ${catalog.detailed}: ${value(model.preferences.tooltipDensity)} · ${catalog.warning}: ${value(model.preferences.notificationLevel)} · ${catalog.displayTimeFormat}: ${timeFormat} · ${catalog.displayLanguage}: ${language}`;
}

export interface SafeDashboardControllerOptions {
  modelSource: () => SafeDashboardDocumentModel;
  timerIntervalMs?: number;
}

export class SafeDashboardContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private disposed = false;

  constructor(private readonly modelSource: () => SafeDashboardDocumentModel) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    void uri;
    if (this.disposed) return `${getUiTextCatalog().safeDashboardUnavailable}\n`;
    diagnostics = {
      ...diagnostics,
      safeDashboardLastRenderedAt: Date.now(),
      safeDashboardRenderCount: diagnostics.safeDashboardRenderCount + 1,
    };
    try {
      return renderSafeDashboard(this.modelSource());
    } catch {
      const catalog = getUiTextCatalog();
      return `# ${catalog.dashboardTitle} — ${catalog.safeNative}\n\n${catalog.unavailable}.\n`;
    }
  }

  refresh(): void {
    if (!this.disposed) this.changeEmitter.fire(SAFE_DASHBOARD_URI);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.changeEmitter.dispose();
  }
}

export class SafeDashboardController implements vscode.Disposable {
  private readonly provider: SafeDashboardContentProvider;
  private registration: vscode.Disposable | undefined;
  private visibleEditorsListener: vscode.Disposable | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshDebounce: ReturnType<typeof setTimeout> | undefined;
  private isOpen = false;
  private disposed = false;

  constructor(private readonly options: SafeDashboardControllerOptions) {
    this.provider = new SafeDashboardContentProvider(options.modelSource);
  }

  register(): void {
    if (this.registration || this.disposed) return;
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      SAFE_DASHBOARD_SCHEME,
      this.provider,
    );
    this.visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors((editors) => {
      this.isOpen = editors.some(
        (editor) => editor.document.uri.toString() === SAFE_DASHBOARD_URI.toString(),
      );
      diagnostics = { ...diagnostics, safeDashboardOpen: this.isOpen };
      if (this.isOpen) this.startTimer();
      else this.stopTimer();
    });
    diagnostics = { ...diagnostics, safeDashboardRegistered: true };
  }

  async open(options: { fallback?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    this.register();
    if (options.fallback) recordSafeDashboardFallback();
    diagnostics = { ...diagnostics, lastRendererUsed: 'safe-native' };
    const document = await vscode.workspace.openTextDocument(SAFE_DASHBOARD_URI);
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false,
    });
    this.isOpen = true;
    diagnostics = { ...diagnostics, safeDashboardOpen: true };
    this.startTimer();
  }

  refresh(): void {
    if (!this.isOpen || this.refreshDebounce) return;
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = undefined;
      if (this.isOpen && !this.disposed) this.provider.refresh();
    }, 50);
  }

  markRichDashboardUsed(): void {
    diagnostics = { ...diagnostics, lastRendererUsed: 'rich-webview' };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = undefined;
    this.visibleEditorsListener?.dispose();
    this.registration?.dispose();
    this.provider.dispose();
    this.registration = undefined;
    diagnostics = { ...diagnostics, safeDashboardRegistered: false, safeDashboardOpen: false };
  }

  private startTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(
      () => this.provider.refresh(),
      this.options.timerIntervalMs ?? SAFE_DASHBOARD_TIMER_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
