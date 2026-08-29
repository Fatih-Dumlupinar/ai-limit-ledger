import { describe, expect, it } from 'vitest';
import {
  elapsedDuration,
  escapeMarkdown,
  formatPercent,
  formatReset,
  formatStatus,
  formatTooltip,
  remainingDuration,
} from '../src/limits/RateLimitFormatter';
import type { LimitSnapshot } from '../src/appServer/types';
const snapshot: LimitSnapshot = {
  limits: [
    {
      label: '5h',
      usedPercent: 24,
      remainingPercent: 76,
      durationMins: 300,
      resetsAt: 1_700_000_000,
    },
    { label: '7d', usedPercent: 52, remainingPercent: 48, durationMins: 10080, resetsAt: null },
  ],
  planType: 'Plus',
  reachedType: null,
  resetCredits: 2,
  updatedAt: new Date(),
  usage: {
    lifetimeTokens: null,
    peakDailyTokens: null,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
    dailyUsageBuckets: [],
  },
  cliVersion: 'codex-cli 0.2',
  connected: true,
};
describe('RateLimitFormatter', () => {
  it('formats single-line standard and compact status text', () => {
    expect(formatStatus(snapshot, 'remaining', true)).toBe('$(pulse) Codex 5h 76% · 7d 48%');
    expect(formatStatus(snapshot, 'used', false, true)).toBe('$(pulse) 24%');
    expect(formatStatus(snapshot, 'remaining', true)).not.toMatch(/[\r\n]/);
  });
  it('uses Markdown newlines and escapes untrusted values', () => {
    const tooltip = formatTooltip({ ...snapshot, planType: 'x](command:evil)' });
    expect(tooltip).toContain('### Codex Usage\n');
    expect(tooltip).not.toContain('command:evil)');
    expect(escapeMarkdown('a|b')).toBe('a\\|b');
  });
  it('converts a Unix timestamp to local display time', () =>
    expect(formatReset(1_700_000_000)).toContain('2023'));

  it('normalizes a multi-day countdown into days/hours/minutes, never a raw minute count', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    // 5 days, 18 hours, 36 minutes from `now`.
    const resetsAt = Math.floor(now / 1000) + 5 * 86400 + 18 * 3600 + 36 * 60;
    const text = remainingDuration(resetsAt, now);
    expect(text).toBe('5d 18h 36m');
    expect(text).not.toMatch(/\d{3,}m/); // never a triple-digit minute remainder like "1116m"
  });

  it('shows "Reset time passed" for a timestamp already in the past', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const resetsAt = Math.floor(now / 1000) - 3600;
    expect(remainingDuration(resetsAt, now)).toBe('Reset time passed');
  });

  it('formats percentages: one decimal max under 10, no trailing .0 at/above 10', () => {
    expect(formatPercent(0.4)).toBe('0.4');
    expect(formatPercent(0)).toBe('0');
    expect(formatPercent(63.777)).toBe('63.8');
    expect(formatPercent(63)).toBe('63');
    expect(formatPercent(3.02)).toBe('3');
    expect(formatPercent(100)).toBe('100');
  });

  it('rejects out-of-range/non-finite percentages safely', () => {
    expect(formatPercent(-5)).toBe('0');
    expect(formatPercent(150)).toBe('100');
    expect(formatPercent(NaN)).toBe('Not provided');
    expect(formatPercent(null)).toBe('Not provided');
    expect(formatPercent(undefined)).toBe('Not provided');
  });

  it('formats elapsed snapshot age the same way as remaining duration', () => {
    const now = Date.UTC(2026, 0, 1, 1, 5, 0);
    const observedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(elapsedDuration(observedAt, now)).toBe('1h 5m');
    expect(elapsedDuration(null)).toBe('Not provided');
  });
});
