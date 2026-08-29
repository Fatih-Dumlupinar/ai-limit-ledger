import type { ProviderSnapshot, UsageWindow } from '../src/providers/types';

export const TASK92_NOW = Date.parse('2026-08-26T10:00:00.000Z');

export function task92Window(
  id: string,
  label: string,
  usedPercent: number,
  durationMinutes: number | null,
): UsageWindow {
  return {
    id,
    label,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: Math.floor((TASK92_NOW + 5 * 60_000) / 1000),
    windowDurationMinutes: durationMinutes,
  };
}

export function task92Snapshots(): ProviderSnapshot[] {
  return [
    {
      providerId: 'codex',
      providerName: 'Codex',
      availability: 'ready',
      connected: true,
      plan: 'Pro',
      cliVersion: '0.5.8',
      usageWindows: [task92Window('mystery-window-id', 'raw-provider-window-label', 25, null)],
      source: 'Official Codex App Server',
      observedAt: TASK92_NOW - 90_000,
      checkedAt: TASK92_NOW - 60_000,
      lastSuccessfulDataUpdate: TASK92_NOW - 90_000,
      lastProviderEventAt: TASK92_NOW - 20_000,
      nextFallbackRefreshAt: TASK92_NOW + 60_000,
      stale: false,
      warning: 'SECRET RAW PROVIDER WARNING MUST NEVER REACH THE DASHBOARD',
      capabilities: { rateLimits: true, usage: true, statusLine: false },
    },
    {
      providerId: 'claude',
      providerName: 'Claude Code',
      availability: 'stale-experimental',
      connected: true,
      plan: 'Pro',
      cliVersion: null,
      usageWindows: [
        task92Window('five-hour', '5h', 45, 300),
        task92Window('seven-day', '7d', 20, 10080),
      ],
      source: 'Experimental — undocumented Anthropic usage endpoint',
      observedAt: TASK92_NOW - 20 * 60_000,
      checkedAt: TASK92_NOW - 19 * 60_000,
      lastSuccessfulDataUpdate: TASK92_NOW - 20 * 60_000,
      lastProviderEventAt: TASK92_NOW - 40_000,
      nextFallbackRefreshAt: TASK92_NOW + 2 * 60_000,
      stale: true,
      capabilities: { rateLimits: true, usage: true, statusLine: true },
      tokens: { contextUsedPercent: 12, contextRemainingPercent: 88, totalCostUsd: 0.42 },
      metadata: { accountLimitsSource: 'experimental-oauth', modelName: 'Claude model' },
    },
    {
      providerId: 'copilot',
      providerName: 'GitHub Copilot',
      availability: 'ready',
      connected: true,
      plan: null,
      cliVersion: null,
      usageWindows: [],
      source: 'Official GitHub Billing REST API',
      observedAt: TASK92_NOW - 30_000,
      checkedAt: TASK92_NOW - 25_000,
      lastProviderEventAt: TASK92_NOW - 18_000,
      nextFallbackRefreshAt: TASK92_NOW + 3 * 60_000,
      stale: false,
      warning: 'SECRET COPILOT BILLING MESSAGE MUST NOT BE RENDERED',
      capabilities: { rateLimits: true, usage: true, statusLine: false },
      credits: { used: 12, allowance: null, remaining: null },
      metadata: { billingEndpoint: 'official-billing', accountManagement: 'organization-managed' },
    },
    {
      providerId: 'grok',
      providerName: 'Grok',
      availability: 'connected-no-billing-method',
      connected: true,
      plan: 'Free',
      cliVersion: null,
      usageWindows: [],
      source: 'Experimental — Grok Build billing extension',
      observedAt: TASK92_NOW - 45_000,
      checkedAt: TASK92_NOW - 40_000,
      lastProviderEventAt: TASK92_NOW - 30_000,
      nextFallbackRefreshAt: TASK92_NOW + 4 * 60_000,
      stale: false,
      capabilities: { rateLimits: true, usage: true, statusLine: false },
    },
  ];
}
