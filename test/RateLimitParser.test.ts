import { describe, expect, it } from 'vitest';
import { clamp, parseRateLimits, parseUsage, windowLabel } from '../src/limits/RateLimitParser';
describe('RateLimitParser', () => {
  it('calculates and clamps remaining percentage', () => {
    expect(clamp(-5)).toBe(0);
    expect(clamp(130)).toBe(100);
    expect(
      parseRateLimits({ rateLimits: { primary: { usedPercent: 24 } } }).limits[0].remainingPercent,
    ).toBe(76);
  });
  it('formats known and unknown windows', () => {
    expect(windowLabel(300)).toBe('5h');
    expect(windowLabel(1440)).toBe('1d');
    expect(windowLabel(10080)).toBe('1w');
    expect(windowLabel(17)).toBe('17m');
  });
  it('prefers the codex bucket and falls back to legacy', () => {
    expect(
      parseRateLimits({
        rateLimits: { primary: { usedPercent: 1 } },
        rateLimitsByLimitId: { codex: { primary: null } },
      }).limits,
    ).toEqual([]);
    expect(parseRateLimits({ rateLimits: { primary: { usedPercent: 50 } } }).limits).toHaveLength(
      1,
    );
  });
  it('never renders a 1970 reset date: a duration-shaped resetsAt normalizes to null', () => {
    // Regression: a small value (e.g. "seconds until reset") must not be misread as an absolute
    // unix-seconds timestamp, which would land near 1970-01-01.
    const parsed = parseRateLimits({
      rateLimits: { primary: { usedPercent: 10, resetsAt: 14_400 } },
    });
    expect(parsed.limits[0].resetsAt).toBeNull();
  });
  it('accepts a plausible absolute unix-seconds resetsAt', () => {
    const parsed = parseRateLimits({
      rateLimits: { primary: { usedPercent: 10, resetsAt: 1_800_000_000 } },
    });
    expect(parsed.limits[0].resetsAt).toBe(1_800_000_000);
  });
  it('shows every rateLimitsByLimitId bucket, not just one', () => {
    const parsed = parseRateLimits({
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 20, windowDurationMins: 300 } },
        'gpt-5-codex': { primary: { usedPercent: 40, windowDurationMins: 300 } },
      },
    });
    expect(parsed.limits).toHaveLength(2);
    expect(parsed.limits.map((l) => l.usedPercent).sort()).toEqual([20, 40]);
  });

  it('deduplicates the identical window reported by two sources', () => {
    const parsed = parseRateLimits({
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_900_000_000 } },
      },
    });
    // A single bucket already collapses to one window per primary/secondary slot; this locks in
    // that a second identical read never doubles the same window (regression guard for future
    // multi-source merges).
    expect(parsed.limits).toHaveLength(1);
  });

  it('rejects a non-finite usedPercent instead of silently clamping it to a fake value', () => {
    const parsed = parseRateLimits({
      rateLimits: { primary: { usedPercent: NaN, windowDurationMins: 300 } },
    });
    expect(parsed.limits).toHaveLength(0);
  });

  it('parses nullable usage and limits sorted daily buckets', () => {
    const usage = parseUsage({
      summary: { lifetimeTokens: null },
      dailyUsageBuckets: [
        { startDate: '2026-08-03', tokens: 3 },
        { startDate: '2026-08-01', tokens: 1 },
        { startDate: null, tokens: 99 },
      ],
    });
    expect(usage.lifetimeTokens).toBeNull();
    expect(usage.dailyUsageBuckets.map((x) => x.startDate)).toEqual(['2026-08-01', '2026-08-03']);
  });
});
