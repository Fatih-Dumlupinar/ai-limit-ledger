import { describe, expect, it } from 'vitest';
import { createRemainingCapacityProgress } from '../src/limits/RemainingCapacityProgress';

describe('RemainingCapacityProgress', () => {
  it.each([
    [0, 100, 'normal'],
    [10, 90, 'normal'],
    [69.9, 30.1, 'normal'],
    [70, 30, 'warning'],
    [89.9, 10.1, 'warning'],
    [90, 10, 'critical'],
    [100, 0, 'critical'],
  ])('derives used=%s as remaining=%s with %s severity', (used, remaining, severity) => {
    const progress = createRemainingCapacityProgress(used);

    expect(progress).toMatchObject({
      usedPercent: used,
      remainingPercent: remaining,
      fillPercent: remaining,
      severity,
      ariaValueNow: remaining,
    });
    expect(progress?.ariaValueText).toContain(`${remaining}% remaining`);
    expect(progress?.ariaValueText).toContain(`${used}% used`);
  });

  it('clamps negative and over-limit values before deriving remaining capacity', () => {
    expect(createRemainingCapacityProgress(-20)).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
      fillPercent: 100,
      severity: 'normal',
    });
    expect(createRemainingCapacityProgress(180)).toMatchObject({
      usedPercent: 100,
      remainingPercent: 0,
      fillPercent: 0,
      severity: 'critical',
      statusText: 'Limit exhausted',
    });
  });

  it('rejects missing and non-finite values without fabricating progress', () => {
    expect(createRemainingCapacityProgress(undefined)).toBeUndefined();
    expect(createRemainingCapacityProgress(null)).toBeUndefined();
    expect(createRemainingCapacityProgress('10')).toBeUndefined();
    expect(createRemainingCapacityProgress(Number.NaN)).toBeUndefined();
    expect(createRemainingCapacityProgress(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('provides textual warnings for low and exhausted remaining capacity', () => {
    expect(createRemainingCapacityProgress(75)?.statusText).toBe('Low remaining capacity');
    expect(createRemainingCapacityProgress(95)?.statusText).toContain('Critical');
    expect(createRemainingCapacityProgress(100)?.statusText).toBe('Limit exhausted');
    expect(createRemainingCapacityProgress(50)?.statusText).toBeUndefined();
  });
});
