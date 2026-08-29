import type { CopilotAllowance, CopilotPlan, CopilotUsageSummary } from './types';
import { getProviderLink } from '../../links/ProviderLinkRegistry';

const COPILOT_PLANS_SOURCE_URL = getProviderLink('copilot-plans-docs').url;

export const COPILOT_ALLOWANCES: Record<
  Exclude<CopilotPlan, 'auto' | 'custom'>,
  CopilotAllowance
> = {
  pro: {
    plan: 'pro',
    monthlyCredits: 1_500,
    effectiveAsOf: '2026-08-24',
    sourceUrl: COPILOT_PLANS_SOURCE_URL,
  },
  proPlus: {
    plan: 'proPlus',
    monthlyCredits: 7_000,
    effectiveAsOf: '2026-08-24',
    sourceUrl: COPILOT_PLANS_SOURCE_URL,
  },
  max: {
    plan: 'max',
    monthlyCredits: 20_000,
    effectiveAsOf: '2026-08-24',
    sourceUrl: COPILOT_PLANS_SOURCE_URL,
  },
};

export interface CopilotCalculatedAllowance {
  allowance: number | null;
  remaining: number | null;
  remainingPercent: number | null;
  label: string;
  allowanceSource: string | null;
}

export function calculateCopilotAllowance(
  plan: CopilotPlan,
  customMonthlyCredits: number | undefined,
  usage: CopilotUsageSummary,
): CopilotCalculatedAllowance {
  const knownAllowance = allowanceForKnownPlan(plan);
  const allowance =
    plan === 'custom'
      ? validCustomAllowance(customMonthlyCredits)
      : plan === 'auto'
        ? null
        : (knownAllowance?.monthlyCredits ?? null);
  if (allowance === null) {
    return {
      allowance: null,
      remaining: null,
      remainingPercent: null,
      label: 'Monthly allowance not configured',
      allowanceSource: null,
    };
  }
  const remaining = Math.max(allowance - usage.usedCredits, 0);
  const configuredPlanLabel = knownAllowance
    ? knownAllowance.plan === 'proPlus'
      ? 'Pro+'
      : knownAllowance.plan[0].toUpperCase() + knownAllowance.plan.slice(1)
    : 'Custom';
  return {
    allowance,
    remaining,
    remainingPercent: Math.max(0, Math.min(100, (remaining / allowance) * 100)),
    label:
      plan === 'custom'
        ? 'Configured custom Copilot allowance'
        : `Configured Copilot ${configuredPlanLabel} plan`,
    allowanceSource:
      plan === 'custom'
        ? 'User-configured customMonthlyCredits'
        : `GitHub Copilot plan allowance (${knownAllowance?.effectiveAsOf}; ${knownAllowance?.sourceUrl})`,
  };
}

function validCustomAllowance(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function allowanceForKnownPlan(plan: CopilotPlan): CopilotAllowance | null {
  if (plan === 'auto' || plan === 'custom') return null;
  return COPILOT_ALLOWANCES[plan];
}
