import { describe, expect, it } from 'vitest';
import {
  combinedStatusText,
  hasErrorState,
  providerSegmentText,
} from '../src/ui/StatusBarFormatter';
import type { ProviderSnapshot } from '../src/providers/types';

function claudeSnapshot(availability: ProviderSnapshot['availability']): ProviderSnapshot {
  return {
    providerId: 'claude',
    providerName: 'Claude',
    availability,
    connected: availability === 'manual-only',
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Official Claude Code status-line',
    observedAt: 0,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: true },
  };
}

function codexReady(remainingPercent: number): ProviderSnapshot {
  return {
    providerId: 'codex',
    providerName: 'Codex',
    availability: 'ready',
    connected: true,
    plan: null,
    cliVersion: null,
    usageWindows: [
      {
        id: 'codex-0',
        label: '5h',
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt: null,
        windowDurationMinutes: 300,
      },
    ],
    source: 'Official Codex App Server',
    observedAt: 0,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
  };
}

describe('StatusBarFormatter', () => {
  it('renders "Claude manual" for manual-only, not "Claude setup" or "Claude waiting"', () => {
    const text = combinedStatusText([claudeSnapshot('manual-only')], 'remaining');
    expect(text).toContain('AI Limit Ledger unavailable');
    expect(text).not.toContain('Claude');
    expect(text).not.toContain('Claude setup');
    expect(text).not.toContain('Claude waiting');
  });

  it('combines a ready Codex with a manual-only Claude', () => {
    const text = combinedStatusText([codexReady(38), claudeSnapshot('manual-only')], 'remaining');
    expect(text).toContain('38% left');
    expect(text).not.toContain('Claude');
  });

  it('derives status-bar remaining text from used percent through the shared model', () => {
    const snapshot = codexReady(38);
    snapshot.usageWindows[0].usedPercent = 70;
    snapshot.usageWindows[0].remainingPercent = 99;

    expect(providerSegmentText(snapshot, 'remaining')).toContain('30% left');
  });

  it('never flags manual-only as an error state', () => {
    expect(hasErrorState([claudeSnapshot('manual-only')])).toBe(false);
  });

  it('does flag genuine problem states as errors', () => {
    expect(hasErrorState([claudeSnapshot('external-change')])).toBe(true);
    expect(hasErrorState([claudeSnapshot('upstream-statusline-not-invoked')])).toBe(true);
  });
});
