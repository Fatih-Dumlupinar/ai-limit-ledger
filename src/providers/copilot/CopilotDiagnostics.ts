import type { CopilotCliInfo, CopilotExtensionInfo } from './types';

export interface CopilotIntegrationDiagnostics {
  cli: CopilotCliInfo;
  extension: CopilotExtensionInfo;
  connected: boolean;
  state: string;
  lastSuccessfulUpdateAt: number | null;
  nextRetryAt: number | null;
  consecutive429s: number;
  tokenPresent: boolean;
  /** Present only when the experimental entitlement endpoint has ever been attempted. */
  experimental?: CopilotExperimentalDiagnostics;
}

/**
 * Safe (never-sensitive) summary of the experimental entitlement fallback. Never includes the
 * token or the raw response body — only presence flags and allowlisted numeric usage values,
 * which are not credentials.
 */
export interface CopilotExperimentalDiagnostics {
  endpointReached: boolean;
  resultCategory: string;
  endpointPlanPresent: boolean;
  managementClassification: string;
  tokenBasedBilling: boolean | null;
  quotaBucketsRecognized: string[];
  creditsUsedPresent: Record<string, boolean>;
  usageMetricValues: Record<string, number | null>;
  resetFieldPresent: boolean;
}

export function formatCopilotDiagnostics(value: CopilotIntegrationDiagnostics): string {
  const lines = [
    `providerId: copilot`,
    `state: ${value.state}`,
    `cli: ${value.cli.installed ? (value.cli.version ?? 'detected') : 'not-installed'}`,
    `extension: ${value.extension.installed ? (value.extension.version ?? 'detected') : 'not-detected'}`,
    `connected: ${value.connected}`,
    `lastSuccessfulUpdateAt: ${value.lastSuccessfulUpdateAt ?? 'not-provided'}`,
    `nextRetryAt: ${value.nextRetryAt ?? 'not-provided'}`,
    `consecutive429s: ${value.consecutive429s}`,
    `tokenPresent: ${value.tokenPresent}`,
  ];
  if (value.experimental) {
    const experimental = value.experimental;
    lines.push(
      `experimentalEndpointReached: ${experimental.endpointReached}`,
      `experimentalResultCategory: ${experimental.resultCategory}`,
      `experimentalEndpointPlanPresent: ${experimental.endpointPlanPresent}`,
      `experimentalManagementClassification: ${experimental.managementClassification}`,
      `experimentalTokenBasedBilling: ${experimental.tokenBasedBilling ?? 'not-provided'}`,
      `experimentalQuotaBucketsRecognized: ${experimental.quotaBucketsRecognized.join(', ') || 'none'}`,
      `experimentalCreditsUsedPresent: ${JSON.stringify(experimental.creditsUsedPresent)}`,
      `experimentalUsageMetricValues: ${JSON.stringify(experimental.usageMetricValues)}`,
      `experimentalResetFieldPresent: ${experimental.resetFieldPresent}`,
    );
  }
  return lines.join('\n');
}
