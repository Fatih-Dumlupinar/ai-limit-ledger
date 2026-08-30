import { normalizeToEpochMs } from '../limits/TimestampNormalizer';
import { createRemainingCapacityProgress } from '../limits/RemainingCapacityProgress';
import {
  formatConfiguredTime,
  getUiTextCatalog,
  localizedProviderSourceLabel,
  localizedRateLimitWindowLabel,
  type UiTextCatalog,
} from './UiTextCatalog';
import {
  getProviderCapabilityDescriptor,
  normalizeProviderId,
  resolveProviderPresentation,
  sourceKindForSnapshot,
  type ProviderPresentationState,
  type ProviderSourceKind,
} from '../providers/ProviderCapabilityContract';
import type { ProviderId, ProviderSnapshot, UsageWindow } from '../providers/types';

export type PresentedTimeFormat = 'locale' | 'relative' | 'absolute' | 'both';

export interface PresentedReset {
  at: number;
  absoluteText: string;
  relativeText: string;
}

export interface PresentedQuotaWindow {
  id: string;
  label: string;
  usedPercentage?: number;
  remainingPercentage?: number;
  reset?: PresentedReset;
  severity?: 'normal' | 'warning' | 'critical';
  fillPercentage?: number;
  ariaValueNow?: number;
  ariaValueText?: string;
  statusText?: string;
}

export interface PresentedFreshness {
  state: 'fresh' | 'stale' | 'error';
  primaryAt?: number;
  summaryText: string;
  checkedAt?: number;
  observedAt?: number;
  lastSuccessfulUpdateAt?: number;
  detailLines: readonly PresentedFreshnessLine[];
}

export interface PresentedFreshnessLine {
  label: string;
  value: string;
  at?: number;
}

export interface PresentedHealth {
  state: string;
  attention: 'none' | 'warning' | 'error';
  statusText: string;
  issueText?: string;
}

export interface PresentedProvenance {
  kind: ProviderSourceKind;
  label: string;
}

export interface ProviderPresentationSummary {
  providerId: string;
  displayName: string;
  sourceKind: ProviderSourceKind;
  provenance: readonly PresentedProvenance[];
  quotaWindows: readonly PresentedQuotaWindow[];
  health: PresentedHealth;
  freshness: PresentedFreshness;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function percentage(value: unknown): number | undefined {
  const number = finite(value);
  if (number === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, number)) * 10) / 10;
}

function validTimestamp(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function resetFor(value: unknown, now: number, catalog: UiTextCatalog): PresentedReset | undefined {
  if (value === null || value === undefined) return undefined;
  const at = normalizeToEpochMs(value, 'unix-seconds', now);
  if (at === null) return undefined;
  return {
    at,
    absoluteText: formatConfiguredTime(at, now, 'absolute', catalog, 'deadline'),
    relativeText: formatConfiguredTime(at, now, 'relative', catalog, 'deadline'),
  };
}

function sourceWindowForCopilot(snapshot: ProviderSnapshot): UsageWindow | undefined {
  const allowance = finite(snapshot.credits?.allowance);
  const used = finite(snapshot.credits?.used);
  if (allowance === undefined || allowance <= 0 || used === undefined) return undefined;
  return {
    id: 'monthly-ai-credits',
    label: 'Monthly AI credits',
    usedPercent: (used / allowance) * 100,
    remainingPercent: 100 - (used / allowance) * 100,
    resetsAt: null,
    windowDurationMinutes: null,
  };
}

function orderedWindows(snapshot: ProviderSnapshot): UsageWindow[] {
  const source = snapshot.usageWindows.slice();
  if (source.length === 0 && normalizeProviderId(snapshot.providerId) === 'copilot') {
    const derived = sourceWindowForCopilot(snapshot);
    if (derived) source.push(derived);
  }
  const seen = new Set<string>();
  const providerId = normalizeProviderId(snapshot.providerId);
  return source
    .map((window, index) => ({ window, index }))
    .filter(({ window }) => {
      const rawKey = String(window.id || window.label || 'usage-window')
        .trim()
        .toLowerCase();
      const key =
        providerId === 'copilot' && rawKey === 'copilot-monthly-ai-credits'
          ? 'monthly-ai-credits'
          : rawKey;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        (left.window.windowDurationMinutes ?? Number.MAX_SAFE_INTEGER) -
          (right.window.windowDurationMinutes ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ window }) => window);
}

function presentedWindow(
  providerId: string,
  window: UsageWindow,
  now: number,
  thresholds: Parameters<typeof createRemainingCapacityProgress>[1],
  catalog: UiTextCatalog,
): PresentedQuotaWindow {
  const progress = createRemainingCapacityProgress(window.usedPercent, thresholds);
  const usedPercentage = progress?.usedPercent ?? percentage(window.usedPercent);
  const remainingPercentage = progress?.remainingPercent ?? percentage(window.remainingPercent);
  const rawId = String(window.id || '')
    .trim()
    .toLowerCase();
  const id =
    providerId === 'copilot' && rawId === 'copilot-monthly-ai-credits'
      ? 'monthly-ai-credits'
      : String(window.id || '');
  const label = localizedRateLimitWindowLabel(
    id,
    window.label,
    window.windowDurationMinutes,
    catalog,
  );
  const reset = resetFor(window.resetsAt, now, catalog);
  return {
    id: id || label,
    label: providerId === 'claude' ? `${catalog.accountLimit} — ${label}` : label,
    ...(usedPercentage !== undefined ? { usedPercentage } : {}),
    ...(remainingPercentage !== undefined ? { remainingPercentage } : {}),
    ...(reset ? { reset } : {}),
    ...(progress
      ? {
          severity: progress.severity,
          fillPercentage: progress.fillPercent,
          ariaValueNow: progress.ariaValueNow,
          ariaValueText: `${progress.remainingPercent}% ${catalog.remaining.toLowerCase()}, ${progress.usedPercent}% ${catalog.used.toLowerCase()}`,
          ...(progress.severity !== 'normal'
            ? {
                statusText: progress.severity === 'critical' ? catalog.critical : catalog.warning,
              }
            : {}),
        }
      : {}),
  };
}

function isProblemState(snapshot: ProviderSnapshot): 'fresh' | 'stale' | 'error' {
  if (
    snapshot.error ||
    snapshot.availability === 'error' ||
    snapshot.availability === 'startup-error' ||
    snapshot.availability === 'authentication-required'
  )
    return 'error';
  if (
    snapshot.stale ||
    snapshot.availability === 'stale' ||
    snapshot.availability === 'stale-experimental' ||
    snapshot.availability === 'rate-limited' ||
    snapshot.availability === 'rate-limited-experimental'
  )
    return 'stale';
  return 'fresh';
}

function freshnessFor(
  snapshot: ProviderSnapshot,
  windows: readonly PresentedQuotaWindow[],
  now: number,
  catalog: UiTextCatalog,
): PresentedFreshness {
  const checkedAt = validTimestamp(snapshot.checkedAt);
  const observedAt = validTimestamp(snapshot.observedAt);
  const hasNumericData = windows.some(
    (window) => window.usedPercentage !== undefined || window.remainingPercentage !== undefined,
  );
  const lastSuccessfulUpdateAt =
    validTimestamp(snapshot.lastSuccessfulUpdateAt) ??
    validTimestamp(snapshot.lastSuccessfulDataUpdate) ??
    (hasNumericData ? observedAt : undefined);
  const primaryAt = lastSuccessfulUpdateAt ?? observedAt ?? checkedAt;
  const state = isProblemState(snapshot);
  const summaryText = primaryAt
    ? formatConfiguredTime(primaryAt, now, 'relative', catalog, 'past-event')
    : catalog.notProvided;
  const candidates: Array<PresentedFreshnessLine> = [];
  const add = (
    label: string,
    at: number | undefined,
    role: 'past-event' | 'snapshot-age' = 'past-event',
  ) => {
    if (at === undefined || candidates.some((line) => line.at === at)) return;
    candidates.push({ label, value: formatConfiguredTime(at, now, 'relative', catalog, role), at });
  };
  add(catalog.lastCheck, checkedAt);
  add(catalog.lastSuccessfulUpdate, lastSuccessfulUpdateAt);
  add(catalog.lastProviderEvent, validTimestamp(snapshot.lastProviderEventAt));
  add(catalog.snapshotAge, observedAt, 'snapshot-age');
  return {
    state,
    ...(primaryAt ? { primaryAt } : {}),
    summaryText,
    ...(checkedAt ? { checkedAt } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(lastSuccessfulUpdateAt ? { lastSuccessfulUpdateAt } : {}),
    detailLines: candidates,
  };
}

function healthFor(
  snapshot: ProviderSnapshot,
  resolved: ProviderPresentationState,
  catalog: UiTextCatalog,
): PresentedHealth {
  const attention = resolved.attention;
  const statusText = catalog[resolved.statusKey];
  const issueText =
    snapshot.error ?? snapshot.warning ?? catalog[resolved.explanationKey ?? resolved.statusKey];
  return {
    state: resolved.normalizedState,
    attention,
    statusText,
    ...(issueText && issueText !== statusText ? { issueText } : {}),
  };
}

export function buildProviderPresentationSummary(
  snapshot: ProviderSnapshot,
  options: {
    now?: number;
    thresholds?: Parameters<typeof createRemainingCapacityProgress>[1];
    language?: 'auto' | 'en' | 'tr';
    resolved?: ProviderPresentationState;
  } = {},
): ProviderPresentationSummary {
  const now = options.now ?? Date.now();
  const catalog = getUiTextCatalog(options.language ?? 'auto');
  const providerId = normalizeProviderId(snapshot.providerId);
  const resolved = options.resolved ?? resolveProviderPresentation({ snapshot, now });
  const sourceKind =
    options.resolved?.sourceKind ?? sourceKindForSnapshot(snapshot.source, snapshot.metadata);
  const quotaWindows = orderedWindows(snapshot).map((window) =>
    presentedWindow(providerId, window, now, options.thresholds ?? {}, catalog),
  );
  const provider =
    providerId === 'codex' ||
    providerId === 'claude' ||
    providerId === 'copilot' ||
    providerId === 'grok'
      ? (providerId as ProviderId)
      : undefined;
  const sourceLabel = provider
    ? localizedProviderSourceLabel(provider, sourceKind, catalog)
    : catalog.sourceUsage;
  return {
    providerId,
    displayName: getProviderCapabilityDescriptor(providerId)?.displayName ?? snapshot.providerName,
    sourceKind,
    provenance: [{ kind: sourceKind, label: sourceLabel }],
    quotaWindows,
    health: healthFor(snapshot, resolved, catalog),
    freshness: freshnessFor(snapshot, quotaWindows, now, catalog),
  };
}

export function formatPresentedReset(
  reset: PresentedReset | undefined,
  format: PresentedTimeFormat = 'both',
  catalog: UiTextCatalog = getUiTextCatalog(),
): string {
  if (!reset) return catalog.notProvided;
  if (format === 'relative') return reset.relativeText;
  if (format === 'absolute' || format === 'locale') return reset.absoluteText;
  return `${reset.absoluteText} · ${reset.relativeText}`;
}

export function presentedPercentageText(
  window: PresentedQuotaWindow,
  mode: 'remaining' | 'used' | 'both' = 'remaining',
  catalog: UiTextCatalog = getUiTextCatalog(),
): string | undefined {
  const remaining =
    window.remainingPercentage === undefined
      ? undefined
      : `${window.remainingPercentage}% ${catalog.left}`;
  const used =
    window.usedPercentage === undefined
      ? undefined
      : `${window.usedPercentage}% ${catalog.used.toLowerCase()}`;
  if (mode === 'remaining') return remaining ?? used;
  if (mode === 'used') return used ?? remaining;
  if (remaining && used) return `${remaining} · ${used}`;
  return remaining ?? used;
}
