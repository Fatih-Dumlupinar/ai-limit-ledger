import { normalizeToEpochMs } from '../limits/TimestampNormalizer';
import { escapeMarkdown, formatPercent } from '../limits/RateLimitFormatter';
import { type RemainingCapacityThresholds } from '../limits/RemainingCapacityProgress';
import { formatConfiguredTime, getUiTextCatalog, type UiTextCatalog } from './UiTextCatalog';
import {
  getProviderCapabilityDescriptor,
  normalizeProviderId,
  sourceKindForSnapshot,
} from '../providers/ProviderCapabilityContract';
import type { ProviderId, ProviderSnapshot } from '../providers/types';
import { localizedInsightLabel, safeUsageInsightsForSnapshot } from './SafeDashboard';
import {
  buildProviderPresentationSummary,
  formatPresentedReset,
  presentedPercentageText,
} from './ProviderPresentation';

export type ProviderRefreshMode =
  'push-with-fallback' | 'event-driven' | 'polling' | 'manual' | 'backoff' | 'not-scheduled';

export interface ProviderRefreshPresentation {
  mode: ProviderRefreshMode;
  lastCheckAt?: number;
  lastSuccessfulUpdateAt?: number;
  lastProviderEventAt?: number;
  sourceUpdatedAt?: number;
  snapshotAgeMs?: number;
  nextScheduledRefreshAt?: number;
  backoffUntil?: number;
  fallbackIntervalSeconds?: number;
  statusLineIntervalSeconds?: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const PROVIDER_SOURCE_LABELS: Record<ProviderId, string> = {
  codex: 'Official Codex App Server',
  claude: 'Official Claude Code status-line',
  copilot: 'Official GitHub Billing REST API',
  grok: 'Experimental Grok Build billing extension',
};

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  'ready-calculated': 'Ready',
  'ready-experimental': 'Ready (experimental)',
  stale: 'Stale — showing last known good data',
  'stale-experimental': 'Stale — showing last known good data',
  'rate-limited': 'Rate limited',
  'rate-limited-experimental': 'Rate limited — showing last known good data',
  'authentication-required': 'Sign-in required',
  'consent-required': 'Consent required',
  'integration-required': 'Integration required',
  'integration-disabled': 'Integration disabled',
  'cli-not-installed': 'CLI not installed',
  'waiting-for-first-response': 'Waiting for provider data',
  'upstream-statusline-not-invoked': 'Waiting for Claude status-line data',
  unavailable: 'Unavailable',
  error: 'Unavailable',
  'startup-error': 'Startup error',
  disabled: 'Disabled',
};

function localizedStatus(availability: string, catalog: UiTextCatalog): string {
  const base: Record<string, string> = {
    ready: catalog.ready,
    'ready-calculated': catalog.ready,
    'ready-experimental': catalog.ready,
    stale: catalog.stale,
    'stale-experimental': catalog.stale,
    'rate-limited': catalog.rateLimited,
    'rate-limited-experimental': catalog.rateLimited,
    'authentication-required': catalog.signInRequired,
    'consent-required': catalog.consentRequired,
    'integration-required': catalog.setupRequired,
    'integration-disabled': catalog.disabled,
    'cli-not-installed': catalog.cliNotInstalled,
    unavailable: catalog.unavailable,
    error: catalog.error,
    'startup-error': catalog.startupError,
    disabled: catalog.disabled,
  };
  if (
    availability === 'waiting-for-first-response' ||
    availability === 'upstream-statusline-not-invoked'
  )
    return catalog.loading;
  if (availability === 'stale' || availability === 'stale-experimental')
    return `${base[availability]} — ${catalog.lastKnownGood.toLowerCase()}`;
  if (availability === 'rate-limited' || availability === 'rate-limited-experimental')
    return `${base[availability]} — ${catalog.lastKnownGood.toLowerCase()}`;
  return base[availability] ?? STATUS_LABELS[availability] ?? catalog.unavailable;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
  const normalized = normalizeToEpochMs(value, 'unix-millis');
  return normalized === null ? undefined : normalized;
}

function metadataNumber(snapshot: ProviderSnapshot, key: string): number | undefined {
  return finite(snapshot.metadata?.[key]);
}

function hasNumericUsage(snapshot: ProviderSnapshot): boolean {
  return (
    snapshot.usageWindows.some(
      (window) => Number.isFinite(window.usedPercent) || Number.isFinite(window.remainingPercent),
    ) || typeof snapshot.credits?.used === 'number'
  );
}

function isExperimentalSource(snapshot: ProviderSnapshot): boolean {
  return sourceKindForSnapshot(snapshot.source, snapshot.metadata).startsWith('experimental');
}

function providerIdOf(snapshot: ProviderSnapshot): ProviderId | undefined {
  const id = normalizeProviderId(snapshot.providerId);
  return id === 'codex' || id === 'claude' || id === 'copilot' || id === 'grok' ? id : undefined;
}

function refreshInterval(snapshot: ProviderSnapshot, key: string): number | undefined {
  const value = metadataNumber(snapshot, key);
  return value !== undefined && value > 0 ? value : undefined;
}

export function buildProviderRefreshPresentation(
  snapshot: ProviderSnapshot,
  now = Date.now(),
): ProviderRefreshPresentation {
  const providerId = providerIdOf(snapshot);
  const lastCheckAt = epochMs(snapshot.checkedAt ?? snapshot.observedAt);
  const lastSuccessfulUpdateAt = epochMs(
    snapshot.lastSuccessfulUpdateAt ??
      snapshot.lastSuccessfulDataUpdate ??
      (hasNumericUsage(snapshot) ? snapshot.observedAt : undefined),
  );
  const lastProviderEventAt = epochMs(snapshot.lastProviderEventAt);
  const sourceUpdatedAt = epochMs(snapshot.sourceUpdatedAt);
  const retryAt = epochMs(snapshot.retryAt ?? metadataNumber(snapshot, 'oauthRetryAt'));
  const nextFallbackRefreshAt = epochMs(snapshot.nextFallbackRefreshAt);
  const metadataNextRefreshAt = epochMs(
    providerId === 'claude'
      ? metadataNumber(snapshot, 'oauthNextEligibleAt')
      : metadataNumber(snapshot, 'nextRefreshAt'),
  );
  const nextScheduledRefreshAt = nextFallbackRefreshAt ?? metadataNextRefreshAt;
  const backoffUntil = retryAt !== undefined && retryAt > now ? retryAt : undefined;
  const base: ProviderRefreshPresentation = {
    mode: 'not-scheduled',
    ...(lastCheckAt !== undefined ? { lastCheckAt } : {}),
    ...(lastSuccessfulUpdateAt !== undefined ? { lastSuccessfulUpdateAt } : {}),
    ...(lastProviderEventAt !== undefined ? { lastProviderEventAt } : {}),
    ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
    ...(lastSuccessfulUpdateAt !== undefined
      ? { snapshotAgeMs: Math.max(0, now - lastSuccessfulUpdateAt) }
      : {}),
    ...(nextScheduledRefreshAt !== undefined ? { nextScheduledRefreshAt } : {}),
    ...(backoffUntil !== undefined ? { backoffUntil } : {}),
  };

  if (backoffUntil !== undefined) return { ...base, mode: 'backoff' };
  if (providerId === 'codex' && nextFallbackRefreshAt !== undefined) {
    return {
      ...base,
      mode: 'push-with-fallback',
      fallbackIntervalSeconds:
        refreshInterval(snapshot, 'fallbackIntervalSeconds') ??
        (lastCheckAt !== undefined
          ? Math.max(1, Math.round((nextFallbackRefreshAt - lastCheckAt) / 1000))
          : undefined),
    };
  }
  if (providerId === 'claude' && isExperimentalSource(snapshot)) {
    return {
      ...base,
      mode: 'polling',
      ...(refreshInterval(snapshot, 'oauthRefreshSeconds') !== undefined
        ? { statusLineIntervalSeconds: refreshInterval(snapshot, 'oauthRefreshSeconds') }
        : {}),
    };
  }
  if (providerId === 'claude' && hasNumericUsage(snapshot)) {
    return {
      ...base,
      mode: 'event-driven',
      ...(refreshInterval(snapshot, 'statusLineIntervalSeconds') !== undefined
        ? { statusLineIntervalSeconds: refreshInterval(snapshot, 'statusLineIntervalSeconds') }
        : {}),
    };
  }
  if ((providerId === 'copilot' || providerId === 'grok') && nextScheduledRefreshAt !== undefined) {
    return { ...base, mode: 'polling' };
  }
  if (providerId && (hasNumericUsage(snapshot) || snapshot.connected)) {
    return { ...base, mode: 'manual' };
  }
  return base;
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value)
    .replace(/[\r\n]/g, ' ')
    .trim()
    .slice(0, 100);
  if (!text || /[\\/]|@[A-Za-z0-9.-]+|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(text)) return undefined;
  return escapeMarkdown(text);
}

function dateText(
  value: number | undefined,
  now = Date.now(),
  timeFormat: 'locale' | 'relative' | 'absolute' | 'both' = 'both',
  catalog?: UiTextCatalog,
  role: 'past-event' | 'future-target' | 'deadline' | 'snapshot-age' = 'snapshot-age',
): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : formatConfiguredTime(value, now, timeFormat, catalog ?? getUiTextCatalog(), role);
}

function countdown(
  value: number | undefined,
  now: number,
  pastLabel: string,
  catalog: UiTextCatalog = getUiTextCatalog(),
  role: 'future-target' | 'deadline' = 'future-target',
): string | undefined {
  if (value === undefined) return undefined;
  const diff = value - now;
  if (diff <= 0)
    return role === 'deadline'
      ? pastLabel
      : formatConfiguredTime(value, now, 'relative', catalog, role);
  return formatConfiguredTime(value, now, 'relative', catalog, role);
  /* istanbul ignore next -- legacy countdown implementation retained for compatibility. */
  // eslint-disable-next-line no-unreachable
  const totalSeconds = Math.ceil(diff / 1000);
  const turkish = catalog === getUiTextCatalog('tr');
  if (totalSeconds < 60) return turkish ? `${totalSeconds} sn içinde` : `in ${totalSeconds}s`;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(turkish ? `${days} gün` : `${days}d`);
  if (hours > 0) parts.push(turkish ? `${hours} sa` : `${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(turkish ? `${minutes} dk` : `${minutes}m`);
  if (days === 0 && hours === 0 && seconds > 0)
    parts.push(turkish ? `${seconds} sn` : `${seconds}s`);
  return turkish ? `${parts.join(' ')} içinde` : `in ${parts.join(' ')}`;
}

function modeLines(
  snapshot: ProviderSnapshot,
  presentation: ProviderRefreshPresentation,
  now: number,
  timeFormat: 'locale' | 'relative' | 'absolute' | 'both',
  catalog: UiTextCatalog,
): string[] {
  const lines = [`- ${catalog.mode}: ${modeLabel(snapshot, presentation, catalog)}`];
  if (
    presentation.mode === 'push-with-fallback' &&
    presentation.nextScheduledRefreshAt !== undefined
  ) {
    const interval = presentation.fallbackIntervalSeconds;
    if (interval !== undefined)
      lines[0] = `- ${catalog.mode}: ${catalog.liveAppServerEventsFallback.replace('{value}', String(interval))}`;
    const next = countdown(presentation.nextScheduledRefreshAt, now, catalog.now, catalog);
    if (next) lines.push(`- ${catalog.nextFallbackCheck}: ${next}`);
  } else if (presentation.mode === 'event-driven') {
    if (presentation.statusLineIntervalSeconds !== undefined)
      lines.push(`- ${catalog.configuredInterval}: ${presentation.statusLineIntervalSeconds}s`);
    lines.push(`- ${catalog.nextAutomaticCheck}: ${catalog.nextAfterResponse}`);
  } else if (presentation.mode === 'polling' && presentation.nextScheduledRefreshAt !== undefined) {
    const next = countdown(
      presentation.nextScheduledRefreshAt,
      now,
      catalog.retryEligibleNow,
      catalog,
    );
    if (next) lines.push(`- ${catalog.nextAutomaticCheck}: ${next}`);
  } else if (presentation.mode === 'manual') {
    lines.push(`- ${catalog.schedule}: ${catalog.manualRefresh}`);
  }
  if (presentation.backoffUntil !== undefined) {
    const retryDate = dateText(
      presentation.backoffUntil,
      now,
      timeFormat,
      catalog,
      'future-target',
    );
    const retryCountdown = countdown(
      presentation.backoffUntil,
      now,
      catalog.retryEligibleNow,
      catalog,
      'future-target',
    );
    lines.push(
      `- Retry paused until: ${retryDate ?? 'later'}${retryCountdown ? ` — ${retryCountdown}` : ''}`,
    );
  }
  return lines;
}

function modeLabel(
  snapshot: ProviderSnapshot,
  presentation: ProviderRefreshPresentation,
  catalog: UiTextCatalog,
): string {
  if (presentation.mode === 'push-with-fallback')
    return catalog.liveAppServerEventsFallback.replace(
      '{value}',
      String(presentation.fallbackIntervalSeconds ?? ''),
    );
  if (presentation.mode === 'event-driven') return catalog.claudeStatusLineEvents;
  if (presentation.mode === 'polling')
    return normalizeProviderId(snapshot.providerId) === 'claude'
      ? catalog.experimentalUsagePolling
      : catalog.periodicBillingCheck;
  if (presentation.mode === 'backoff') return catalog.backoff;
  if (presentation.mode === 'manual') return catalog.manualRefresh;
  return catalog.notScheduled;
  /* istanbul ignore next -- legacy English mode labels retained for compatibility. */
  // eslint-disable-next-line no-unreachable
  if (presentation.mode === 'push-with-fallback') return 'Live App Server events + fallback';
  if (presentation.mode === 'event-driven') return 'Claude status-line events';
  if (presentation.mode === 'polling')
    return normalizeProviderId(snapshot.providerId) === 'grok'
      ? 'Periodic CLI billing check'
      : normalizeProviderId(snapshot.providerId) === 'claude'
        ? 'Experimental usage polling'
        : 'Periodic billing check';
  if (presentation.mode === 'backoff') return catalog.backoff;
  if (presentation.mode === 'manual') return catalog.manualRefresh;
  return 'Not scheduled';
}

export interface ProviderTooltipOptions {
  density?: 'compact' | 'detailed';
  percentageMode?: 'remaining' | 'used' | 'both';
  thresholds?: RemainingCapacityThresholds;
  language?: 'auto' | 'en' | 'tr';
  timeFormat?: 'locale' | 'relative' | 'absolute' | 'both';
}

/** Pure, Markdown-only tooltip. The timer that uses it never refreshes a provider. */
export function formatProviderTooltip(
  snapshot: ProviderSnapshot,
  now = Date.now(),
  options: ProviderTooltipOptions = {},
): string {
  const providerId = providerIdOf(snapshot);
  const descriptor = providerId ? getProviderCapabilityDescriptor(providerId) : undefined;
  const name = descriptor?.displayName ?? 'Provider';
  const presentation = buildProviderRefreshPresentation(snapshot, now);
  const catalog = getUiTextCatalog(options.language ?? 'auto');
  const percentageMode = options.percentageMode ?? 'remaining';
  const semantic = buildProviderPresentationSummary(snapshot, {
    now,
    thresholds: options.thresholds,
    language: options.language,
  });
  const status = semantic.health.statusText || localizedStatus(snapshot.availability, catalog);
  const windows = semantic.quotaWindows;
  const timeFormat = options.timeFormat ?? 'both';
  const creditSummary =
    typeof snapshot.credits?.used === 'number' && Number.isFinite(snapshot.credits.used)
      ? `**${catalog.aiCredits} ${catalog.used.toLowerCase()}: ${formatPercent(snapshot.credits.used)}**`
      : `**${catalog.usageNotProvided}**`;
  const resetFormat = (compact: boolean) =>
    compact && timeFormat !== 'absolute' && timeFormat !== 'locale' ? 'relative' : timeFormat;
  const quotaLines = (limit: number, compact: boolean): string[] => {
    const selected = windows.slice(0, limit);
    if (selected.length === 0) return [creditSummary];
    return selected.flatMap((window) => {
      const percentage = presentedPercentageText(window, percentageMode, catalog);
      const bar =
        !compact && window.fillPercentage !== undefined
          ? `\`${'█'.repeat(Math.round(window.fillPercentage / 10))}${'░'.repeat(10 - Math.round(window.fillPercentage / 10))}\``
          : undefined;
      const reset = window.reset
        ? `${catalog.reset}: ${formatPresentedReset(window.reset, resetFormat(compact), catalog)}`
        : `${catalog.reset}: ${catalog.notProvided}`;
      const statusLine =
        window.severity === 'critical'
          ? catalog.critical
          : window.severity === 'warning'
            ? catalog.warning
            : undefined;
      return compact
        ? [
            `**${escapeMarkdown(window.label)}**`,
            `${percentage ? `**${percentage}**` : `*${catalog.numericUsageUnavailable}*`} · ${escapeMarkdown(reset)}`,
            ...(statusLine ? [`_${escapeMarkdown(statusLine)}_`] : []),
          ]
        : [
            `**${escapeMarkdown(window.label)}**`,
            ...(bar ? [bar] : []),
            percentage ? `**${percentage}**` : `*${catalog.numericUsageUnavailable}*`,
            escapeMarkdown(reset),
            ...(statusLine ? [`_${escapeMarkdown(statusLine)}_`] : []),
            '',
          ];
    });
  };
  const freshness = semantic.freshness;
  const issue = semantic.health.issueText ?? snapshot.warning ?? snapshot.error;
  if (options.density === 'compact') {
    return [
      `### ${name}`,
      '',
      `**${catalog.status}:** ${status}`,
      '',
      ...quotaLines(2, true),
      '',
      `**${catalog.updated}:** ${freshness.summaryText}`,
      ...(issue ? ['', `> ${escapeMarkdown(issue)}`] : []),
      ...(freshness.state !== 'fresh'
        ? [`**${catalog.dataState}:** ${catalog.lastKnownGood}`]
        : []),
    ].join('\n');
  }
  const lines = [`### ${name}`, '', `**${catalog.status}:** ${status}`, ''];
  if (issue) lines.push(`> ${escapeMarkdown(issue)}`, '');
  lines.push(...quotaLines(windows.length || 1, false));
  const plan = safeText(snapshot.plan);
  const insightRows = safeUsageInsightsForSnapshot(snapshot, now, options.language ?? 'auto')
    .filter((insight) => {
      if (insight.label === 'planType' && plan) return false;
      if (insight.label === 'rateLimits') return false;
      if (insight.label === 'resetAt' && windows.some((window) => window.reset)) return false;
      if (insight.label === 'aiCreditsRemainingPercent' && windows.length > 0) return false;
      return true;
    })
    .slice(0, 3);
  if (insightRows.length) {
    lines.push(
      '',
      `**${providerId === 'claude' ? catalog.latestObservedCliSession : catalog.usageInsights}:**`,
      ...insightRows.map((insight) => {
        const fieldSource =
          insight.sourceKind === semantic.sourceKind
            ? ''
            : ` _(${escapeMarkdown(insight.sourceLabel)})_`;
        return `- **${escapeMarkdown(localizedInsightLabel(insight.label, catalog))}:** ${escapeMarkdown(insight.value)}${fieldSource}`;
      }),
    );
  }
  const model = safeText(snapshot.metadata?.modelName ?? snapshot.metadata?.modelId);
  if (plan) lines.push('', `**${catalog.plan}:** ${plan}`);
  if (model) lines.push(`**${catalog.model}:** ${model}`);
  if (freshness.state === 'fresh') {
    lines.push('', `**${catalog.dataFreshness}:** ${freshness.summaryText}`);
  } else {
    lines.push(
      '',
      `**${catalog.dataFreshness}**`,
      ...freshness.detailLines.map((line) => `- ${line.label}: ${line.value}`),
    );
    lines.push(`- ${catalog.dataState}: ${catalog.lastKnownGood}`);
  }
  lines.push(
    '',
    `**${catalog.refreshSection}**`,
    ...modeLines(snapshot, presentation, now, timeFormat, catalog),
  );
  lines.push('', `_${catalog.source}: ${semantic.provenance[0]?.label ?? catalog.notProvided}_`);
  if (isExperimentalSource(snapshot)) lines.push(`_${catalog.experimental}_`);
  return lines.join('\n');
}
