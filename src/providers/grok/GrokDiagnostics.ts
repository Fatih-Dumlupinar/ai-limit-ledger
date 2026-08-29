import type { GrokCliInfo, GrokExtensionInfo } from './types';

export interface GrokIntegrationDiagnostics {
  cli: GrokCliInfo;
  extension: GrokExtensionInfo;
  state: string;
  billingMethod: string;
  capabilityCached: boolean;
  retryAt: number | null;
  /** Safe (never-sensitive) explanation of the last experimental CLI-proxy fallback attempt, if any. */
  experimentalFallbackStatus?: string;
}

export function formatGrokDiagnostics(value: GrokIntegrationDiagnostics): string {
  return [
    'providerId: grok',
    `state: ${value.state}`,
    `cli: ${value.cli.installed ? (value.cli.version ?? 'detected') : 'not-installed'}`,
    `extension: ${value.extension.installed ? `${value.extension.id ?? 'unknown'} ${value.extension.version ?? ''}` : 'not-detected'}`,
    `billingMethod: ${value.billingMethod}`,
    `capabilityCached: ${value.capabilityCached}`,
    `retryAt: ${value.retryAt ?? 'not-provided'}`,
    `experimentalFallbackStatus: ${value.experimentalFallbackStatus ?? 'not-attempted'}`,
  ].join('\n');
}
