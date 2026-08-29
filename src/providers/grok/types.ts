import type { ProviderCredits } from '../types';

export interface GrokCliInfo {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  reason?: 'not-found' | 'invalid-explicit-path' | 'workspace-path-rejected';
}

export interface GrokExtensionInfo {
  installed: boolean;
  id: string | null;
  version: string | null;
  official: boolean;
}

export interface GrokUsageWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
}

export interface GrokBillingSummary {
  plan: string | null;
  currentPeriod: string | null;
  usageWindows: GrokUsageWindow[];
  /** null means the provider did not expose a product breakdown. */
  productBreakdown: Array<{
    product: string;
    usedPercent: number | null;
    credits: number | null;
  }> | null;
  buildUsage: number | null;
  onDemandEnabled: boolean | null;
  extraCreditBalance: number | null;
  credits: ProviderCredits;
}

export interface GrokBillingTransport {
  getBilling(): Promise<GrokBillingSummary>;
  dispose(): void;
}

export const GROK_USAGE_SOURCE = 'Experimental — Grok Build billing extension' as const;
export const GROK_BILLING_METHOD = 'x.ai/billing';
