import type { ProviderCredits } from '../types';
import type { GrokBillingSummary, GrokUsageWindow } from './types';

export function parseGrokBilling(value: unknown): GrokBillingSummary {
  const source = object(value);
  const config = object(source.billingConfig ?? source);
  const percentage = boundedPercent(
    number(config.creditUsagePercent ?? config.credit_usage_percent),
  );
  const period = object(config.currentPeriod ?? config.current_period);
  const periodStart = string(
    period.start ??
      period.billingPeriodStart ??
      config.billingPeriodStart ??
      config.billing_period_start,
  );
  const periodEnd = string(
    period.end ?? period.billingPeriodEnd ?? config.billingPeriodEnd ?? config.billing_period_end,
  );
  const reset = parseTimestamp(
    periodEnd ?? string(config.resetTimestamp ?? config.reset_timestamp),
  );
  const used = nonNegativeNumber(config.used);
  const monthlyLimit = nonNegativeNumber(config.monthlyLimit ?? config.monthly_limit);
  const onDemandUsed = nonNegativeNumber(config.onDemandUsed ?? config.on_demand_used);
  const prepaidBalance = nonNegativeNumber(config.prepaidBalance ?? config.prepaid_balance);
  const windows: GrokUsageWindow[] = [];
  if (percentage !== null) {
    windows.push({
      id: 'grok-current-period',
      label: periodLabel(periodStart, periodEnd),
      usedPercent: clampPercent(percentage),
      remainingPercent: clampPercent(100 - percentage),
      resetsAt: reset,
    });
  }
  const products = parseProducts(
    source.productBreakdown ??
      source.product_breakdown ??
      config.productBreakdown ??
      config.product_breakdown,
  );
  const buildUsage = nonNegativeNumber(
    source.buildUsage ?? source.build_usage ?? config.buildUsage ?? config.build_usage,
  );
  const onDemandEnabled = boolean(config.onDemandEnabled ?? config.on_demand_enabled);
  const credits: ProviderCredits = {
    used,
    allowance: monthlyLimit,
    remaining: monthlyLimit !== null && used !== null ? Math.max(monthlyLimit - used, 0) : null,
    additional: onDemandUsed,
    included: monthlyLimit,
  };
  return {
    plan: string(
      source.subscriptionTier ??
        source.subscription_tier ??
        config.subscriptionTier ??
        config.subscription_tier,
    ),
    currentPeriod:
      periodStart || periodEnd
        ? `${periodStart ?? 'Not provided'} → ${periodEnd ?? 'Not provided'}`
        : null,
    usageWindows: windows,
    productBreakdown: products,
    buildUsage,
    onDemandEnabled,
    extraCreditBalance: prepaidBalance,
    credits,
  };
}

function parseProducts(
  value: unknown,
): Array<{ product: string; usedPercent: number | null; credits: number | null }> | null {
  if (!Array.isArray(value)) return null;
  const products = value.flatMap((item) => {
    const source = object(item);
    const product = string(source.product ?? source.name ?? source.type);
    if (!product) return [];
    const percent = boundedPercent(
      nonNegativeNumber(source.usedPercent ?? source.used_percent ?? source.percentage),
    );
    const credits = nonNegativeNumber(source.credits ?? source.used ?? source.quantity);
    return [{ product, usedPercent: percent === null ? null : clampPercent(percent), credits }];
  });
  return products.length ? products : null;
}

function periodLabel(start: string | null, end: string | null): string {
  if (start || end)
    return `Current period${start || end ? ` (${start ?? 'Not provided'} – ${end ?? 'Not provided'})` : ''}`;
  return 'Current period';
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0)
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 160 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function boundedPercent(value: number | null): number | null {
  return value !== null && value >= 0 && value <= 100 ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
