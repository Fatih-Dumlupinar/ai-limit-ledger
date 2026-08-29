/**
 * Provider-neutral timestamp normalization. Every caller must state which kind of value it has —
 * no magnitude guessing — because guessing is exactly how a "seconds until reset" duration or a
 * unix-seconds value can silently render as a date in 1970.
 */
export type TimestampKind =
  'unix-seconds' | 'unix-millis' | 'iso' | 'seconds-until-reset' | 'minutes-until-reset' | 'date';

const PLAUSIBLE_MIN_MS = Date.UTC(2020, 0, 1);
const PLAUSIBLE_MAX_MS = Date.UTC(2100, 0, 1);

function plausible(ms: number): number | null {
  return Number.isFinite(ms) && ms >= PLAUSIBLE_MIN_MS && ms <= PLAUSIBLE_MAX_MS ? ms : null;
}

/** Returns unix milliseconds, or null if the value is missing, malformed, or outside a plausible date range. */
export function normalizeToEpochMs(
  value: unknown,
  kind: TimestampKind,
  now: number = Date.now(),
): number | null {
  if (kind === 'date') return value instanceof Date ? plausible(value.getTime()) : null;
  if (kind === 'iso') {
    if (typeof value !== 'string') return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : plausible(parsed);
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  switch (kind) {
    case 'unix-seconds':
      return plausible(n * 1000);
    case 'unix-millis':
      return plausible(n);
    case 'seconds-until-reset':
      return n >= 0 ? plausible(now + n * 1000) : null;
    case 'minutes-until-reset':
      return n >= 0 ? plausible(now + n * 60_000) : null;
    default:
      return null;
  }
}

/** Convenience wrapper returning unix seconds (the convention `UsageWindow.resetsAt`/`ParsedLimit.resetsAt` already use). */
export function normalizeToEpochSeconds(
  value: unknown,
  kind: TimestampKind,
  now: number = Date.now(),
): number | null {
  const ms = normalizeToEpochMs(value, kind, now);
  return ms === null ? null : Math.floor(ms / 1000);
}
