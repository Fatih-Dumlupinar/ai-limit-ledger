export interface RateLimitWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}
export interface RateLimitBucket {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
  credits?: unknown;
  rateLimitReachedType?: string | null;
}
export interface RateLimitsResult {
  rateLimits?: RateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, RateLimitBucket | null> | null;
  rateLimitResetCredits?: {
    availableCount?: number | null;
    expiresAt?: number | null;
    expiresAtUnixSeconds?: number | null;
    expirationDates?: number[] | null;
  } | null;
}
export interface AccountResult {
  account?: { planType?: string | null } | null;
}
export interface UsageBucket {
  startDate?: string | null;
  tokens?: number | null;
}
export interface UsageResult {
  summary?: {
    lifetimeTokens?: number | null;
    peakDailyTokens?: number | null;
    longestRunningTurnSec?: number | null;
    currentStreakDays?: number | null;
    longestStreakDays?: number | null;
  } | null;
  dailyUsageBuckets?: UsageBucket[] | null;
}
export interface UsageSnapshot {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
}
export interface ParsedLimit {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  durationMins: number | null;
  resetsAt: number | null;
  /** The `rateLimitsByLimitId` key this window came from, when more than one bucket was present. */
  limitId?: string | null;
}
export interface LimitSnapshot {
  limits: ParsedLimit[];
  planType: string | null;
  reachedType: string | null;
  resetCredits: number | null;
  resetCreditExpiresAt?: number[];
  updatedAt: Date;
  usage: UsageSnapshot;
  cliVersion: string | null;
  connected: boolean;
  stale?: boolean;
}
