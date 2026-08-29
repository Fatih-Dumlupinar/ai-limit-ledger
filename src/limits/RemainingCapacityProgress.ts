import { formatPercent } from './RateLimitFormatter';
import { localization } from '../localization/LocalizationService';

export type RemainingCapacitySeverity = 'normal' | 'warning' | 'critical';

export interface RemainingCapacityProgress {
  usedPercent: number;
  remainingPercent: number;
  fillPercent: number;
  severity: RemainingCapacitySeverity;
  primaryText: string;
  secondaryText: string;
  ariaValueNow: number;
  ariaValueText: string;
  statusText?: string;
}

export interface RemainingCapacityThresholds {
  warningRemainingPercent?: number;
  criticalRemainingPercent?: number;
}

/**
 * Creates the single remaining-capacity presentation used by Dashboard, tooltips, and status text.
 * A percentage is accepted only when the provider supplied a finite numeric used value.
 */
export function createRemainingCapacityProgress(
  usedPercent: unknown,
  thresholds: RemainingCapacityThresholds = {},
): RemainingCapacityProgress | undefined {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return undefined;

  const used = roundPercentage(clampPercentage(usedPercent));
  const remaining = roundPercentage(100 - used);
  const warning = finiteThreshold(thresholds.warningRemainingPercent, 30, 1, 99);
  const critical = finiteThreshold(thresholds.criticalRemainingPercent, 10, 0, 98);
  const safeThresholds = critical < warning ? { warning, critical } : { warning: 30, critical: 10 };
  const severity: RemainingCapacitySeverity =
    remaining <= safeThresholds.critical
      ? 'critical'
      : remaining <= safeThresholds.warning
        ? 'warning'
        : 'normal';
  const usedText = `${formatPercent(used)}% used`;
  const remainingText = `${formatPercent(remaining)}% left`;
  const statusText =
    severity === 'critical'
      ? remaining === 0
        ? localization.t('limitExhausted')
        : localization.t('criticalNearlyExhausted')
      : severity === 'warning'
        ? localization.t('lowRemainingCapacity')
        : undefined;

  return {
    usedPercent: used,
    remainingPercent: remaining,
    fillPercent: remaining,
    severity,
    primaryText: remainingText,
    secondaryText: usedText,
    ariaValueNow: remaining,
    ariaValueText: `${formatPercent(remaining)}% remaining, ${formatPercent(used)}% used`,
    ...(statusText ? { statusText } : {}),
  };
}

function finiteThreshold(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function roundPercentage(value: number): number {
  return Math.round(value * 10) / 10;
}
