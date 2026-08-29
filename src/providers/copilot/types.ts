import type { ProviderCredits } from '../types';

export type CopilotPlan = 'auto' | 'pro' | 'proPlus' | 'max' | 'custom';

export interface CopilotCliInfo {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
}

export interface CopilotExtensionInfo {
  installed: boolean;
  version: string | null;
  ids: string[];
}

export interface CopilotUsageItem {
  product: string | null;
  sku: string | null;
  model: string | null;
  unitType: string | null;
  grossQuantity: number | null;
  discountQuantity: number | null;
  netQuantity: number | null;
  grossAmount: number | null;
  netAmount: number | null;
}

export interface CopilotUsageResponse {
  timePeriod: string | null;
  usageItems: CopilotUsageItem[];
}

export interface CopilotModelBreakdown {
  model: string;
  quantity: number;
  cost: number | null;
}

export interface CopilotUsageSummary {
  timePeriod: string | null;
  usedCredits: number;
  includedCredits: number | null;
  additionalCredits: number | null;
  cost: number | null;
  modelBreakdown: CopilotModelBreakdown[];
  nextResetAt: number;
  credits: ProviderCredits;
}

export interface CopilotAllowance {
  plan: Exclude<CopilotPlan, 'auto'>;
  monthlyCredits: number;
  effectiveAsOf: string;
  sourceUrl: string;
}

export interface CopilotUsageTransportResult {
  kind: 'success' | 'authentication-required' | 'organization-managed' | 'unavailable';
  usage?: CopilotUsageSummary;
  status?: number;
  message?: string;
}

export const COPILOT_BILLING_API_VERSION = '2026-03-10';
export const COPILOT_USAGE_SOURCE = 'Official GitHub Billing REST API' as const;
