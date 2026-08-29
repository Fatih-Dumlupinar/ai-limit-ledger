import type {
  LimitSnapshot,
  ParsedLimit,
  RateLimitBucket,
  RateLimitWindow,
  RateLimitsResult,
  UsageResult,
  UsageSnapshot,
} from '../appServer/types';
import { normalizeToEpochSeconds } from './TimestampNormalizer';
import { isSafeMetricNumber, normalizeDailyTokenUsage } from '../providers/UsageInsights';
export const clamp = (value: number): number => Math.min(100, Math.max(0, value));
function parseWindow(
  window: RateLimitWindow | null | undefined,
  limitId?: string,
): ParsedLimit | undefined {
  // A non-finite usedPercent (NaN, ±Infinity) must never be silently clamped into a fake 0-100
  // value — that would render as real data. Treat it the same as a missing field.
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent))
    return undefined;
  if (window.usedPercent < 0 || window.usedPercent > 100) return undefined;
  const usedPercent = clamp(window.usedPercent);
  const baseLabel = windowLabel(window.windowDurationMins);
  return {
    label: limitId ? `${limitId} ${baseLabel}` : baseLabel,
    usedPercent,
    remainingPercent: clamp(100 - usedPercent),
    durationMins:
      typeof window.windowDurationMins === 'number' &&
      Number.isFinite(window.windowDurationMins) &&
      window.windowDurationMins >= 0
        ? window.windowDurationMins
        : null,
    // The Codex App Server documents `resetsAt` as an absolute unix-seconds timestamp. An
    // implausible value (e.g. a small "seconds until reset" duration) normalizes to null —
    // "Not available" — rather than rendering as a date in 1970.
    resetsAt: normalizeToEpochSeconds(window.resetsAt, 'unix-seconds'),
    limitId: limitId ?? null,
  };
}
export function windowLabel(minutes: number | null | undefined): string {
  if (!minutes || minutes < 1) return '?';
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
export function parseUsage(result: UsageResult | null | undefined): UsageSnapshot {
  const summary = result?.summary;
  const metric = (value: unknown): number | null => (isSafeMetricNumber(value) ? value : null);
  const dailyUsageBuckets = normalizeDailyTokenUsage(result?.dailyUsageBuckets).map((bucket) => ({
    startDate: bucket.date,
    tokens: bucket.tokens,
  }));
  return {
    lifetimeTokens: metric(summary?.lifetimeTokens),
    peakDailyTokens: metric(summary?.peakDailyTokens),
    longestRunningTurnSec: metric(summary?.longestRunningTurnSec),
    currentStreakDays: metric(summary?.currentStreakDays),
    longestStreakDays: metric(summary?.longestStreakDays),
    dailyUsageBuckets,
  };
}
interface BucketEntry {
  key: string;
  bucket: RateLimitBucket;
}

/**
 * `rateLimitsByLimitId`, when present at all (even with a single, empty `codex` entry), is the
 * authoritative source and top-level `rateLimits` is never additionally consulted — matching the
 * documented precedence and avoiding double-counting the same window from two fields. Only when
 * `rateLimitsByLimitId` is absent/empty does the legacy top-level `rateLimits` field apply.
 */
function collectBuckets(result: RateLimitsResult): BucketEntry[] {
  const byId = result.rateLimitsByLimitId;
  if (byId && Object.keys(byId).length > 0) {
    return Object.entries(byId)
      .filter((entry): entry is [string, RateLimitBucket] => Boolean(entry[1]))
      .map(([key, bucket]) => ({ key, bucket }));
  }
  return result.rateLimits ? [{ key: 'codex', bucket: result.rateLimits }] : [];
}

function resetCreditExpirationDates(result: RateLimitsResult): number[] {
  const credits = result.rateLimitResetCredits;
  if (!credits) return [];
  const values = [
    credits.expiresAt,
    credits.expiresAtUnixSeconds,
    ...(credits.expirationDates ?? []),
  ];
  return [
    ...new Set(
      values
        .map((value) => normalizeToEpochSeconds(value, 'unix-seconds'))
        .filter((value): value is number => value !== null),
    ),
  ].sort((a, b) => a - b);
}

export function parseRateLimits(
  result: RateLimitsResult,
  accountPlan?: string | null,
  usage?: UsageResult,
  cliVersion?: string | null,
): LimitSnapshot {
  const buckets = collectBuckets(result);
  // The bucket key is only folded into the label when more than one limit source is actually
  // present — the common single-bucket case keeps its plain "5h"/"1w" labels unchanged.
  const multiSource = buckets.length > 1;
  const seen = new Set<string>();
  const limits: ParsedLimit[] = [];
  for (const { key, bucket } of buckets) {
    for (const raw of [bucket.primary, bucket.secondary]) {
      const parsed = parseWindow(raw, multiSource ? key : undefined);
      if (!parsed) continue;
      // Two sources reporting the identical window (same limit id, duration, and reset time) are
      // the same underlying limit reported twice — keep the first occurrence only.
      const dedupeKey = `${key}:${parsed.durationMins}:${parsed.resetsAt}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      limits.push(parsed);
    }
  }
  const metadataBucket =
    buckets.find((entry) => entry.key === 'codex')?.bucket ?? buckets[0]?.bucket;
  return {
    limits,
    planType: metadataBucket?.planType ?? accountPlan ?? null,
    reachedType: metadataBucket?.rateLimitReachedType ?? null,
    resetCredits:
      typeof result.rateLimitResetCredits?.availableCount === 'number' &&
      Number.isFinite(result.rateLimitResetCredits.availableCount) &&
      result.rateLimitResetCredits.availableCount >= 0
        ? result.rateLimitResetCredits.availableCount
        : null,
    resetCreditExpiresAt: resetCreditExpirationDates(result),
    updatedAt: new Date(),
    usage: parseUsage(usage),
    cliVersion: cliVersion ?? null,
    connected: true,
  };
}
