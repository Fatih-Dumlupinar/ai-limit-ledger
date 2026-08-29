import { describe, expect, it } from 'vitest';
import { normalizeToEpochMs, normalizeToEpochSeconds } from '../src/limits/TimestampNormalizer';

describe('TimestampNormalizer', () => {
  it('converts unix seconds to epoch ms', () => {
    expect(normalizeToEpochMs(1_700_000_000, 'unix-seconds')).toBe(1_700_000_000_000);
  });

  it('passes through unix millis', () => {
    expect(normalizeToEpochMs(1_700_000_000_000, 'unix-millis')).toBe(1_700_000_000_000);
  });

  it('parses ISO timestamps', () => {
    expect(normalizeToEpochMs('2026-01-01T00:00:00Z', 'iso')).toBe(
      Date.parse('2026-01-01T00:00:00Z'),
    );
  });

  it('resolves a duration-until-reset relative to now', () => {
    const now = 1_700_000_000_000;
    expect(normalizeToEpochMs(3600, 'seconds-until-reset', now)).toBe(now + 3600 * 1000);
    expect(normalizeToEpochMs(60, 'minutes-until-reset', now)).toBe(now + 60 * 60_000);
  });

  it('never guesses magnitude: a small duration-like value passed as unix-seconds is rejected, not silently shown as 1970', () => {
    // A "seconds until reset" duration (e.g. 14400 = 4 hours) misread as unix-seconds would
    // otherwise render as 1970-01-01. It must normalize to null instead.
    expect(normalizeToEpochMs(14_400, 'unix-seconds')).toBeNull();
    expect(normalizeToEpochSeconds(14_400, 'unix-seconds')).toBeNull();
  });

  it('rejects missing, negative, and non-finite values', () => {
    expect(normalizeToEpochMs(null, 'unix-seconds')).toBeNull();
    expect(normalizeToEpochMs(undefined, 'unix-seconds')).toBeNull();
    expect(normalizeToEpochMs(-1, 'seconds-until-reset')).toBeNull();
    expect(normalizeToEpochMs(Number.NaN, 'unix-seconds')).toBeNull();
    expect(normalizeToEpochMs('not-a-date', 'iso')).toBeNull();
  });

  it('rejects implausibly far-future or far-past dates rather than propagating garbage', () => {
    expect(normalizeToEpochMs(999_999_999_999, 'unix-seconds')).toBeNull(); // ~year 33658
    expect(normalizeToEpochMs(1, 'unix-seconds')).toBeNull(); // 1970-01-01T00:00:01Z
  });

  it('normalizeToEpochSeconds rounds down to whole seconds', () => {
    expect(normalizeToEpochSeconds('2026-01-01T00:00:00.500Z', 'iso')).toBe(
      Math.floor(Date.parse('2026-01-01T00:00:00.500Z') / 1000),
    );
  });
});
