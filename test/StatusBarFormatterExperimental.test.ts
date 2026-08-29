import { describe, expect, it } from 'vitest';
import { providerSegmentText } from '../src/ui/StatusBarFormatter';
import type { ProviderSnapshot } from '../src/providers/types';

function copilotExperimentalSnapshot(used: number): ProviderSnapshot {
  return {
    providerId: 'copilot',
    providerName: 'Copilot',
    availability: 'ready-experimental',
    connected: true,
    plan: 'business',
    cliVersion: '1.0.80',
    usageWindows: [],
    credits: { used, allowance: null, remaining: null },
    source: 'Experimental — GitHub Copilot entitlement endpoint',
    observedAt: 0,
    stale: false,
    capabilities: { rateLimits: false, usage: true, statusLine: false },
  };
}

function grokWithPercent(usedPercent: number): ProviderSnapshot {
  return {
    providerId: 'grok',
    providerName: 'Grok',
    availability: 'ready-experimental',
    connected: true,
    plan: 'SuperGrok',
    cliVersion: '1.0.5',
    usageWindows: [
      {
        id: 'grok-current-period',
        label: 'Current period',
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: null,
        windowDurationMinutes: null,
      },
    ],
    source: 'Experimental — Grok Build billing extension',
    observedAt: 0,
    stale: false,
    capabilities: { rateLimits: false, usage: true, statusLine: false },
  };
}

describe('experimental Copilot/Grok status bar segments', () => {
  it('shows a raw credit count for Copilot when no percentage is known (unlimited entitlement)', () => {
    expect(providerSegmentText(copilotExperimentalSnapshot(31), 'remaining')).toBe(
      'Copilot 31 credits',
    );
  });

  it('shows a percentage for Grok when the CLI-proxy fallback provides one', () => {
    expect(providerSegmentText(grokWithPercent(24), 'used')).toContain('24%');
    expect(providerSegmentText(grokWithPercent(24), 'used')).toContain('used');
  });
});
