import { describe, expect, it } from 'vitest';
import { applyClaudeOAuthOverlay } from '../src/providers/claude/ClaudeSourcePriority';
import type { ProviderSnapshot } from '../src/providers/types';
import type { ClaudeOAuthSnapshot } from '../src/providers/claude/oauth/ClaudeOAuthUsageService';

function baseSnapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: 'claude',
    providerName: 'Claude Code',
    availability: 'manual-only',
    connected: true,
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Official Claude Code status-line',
    observedAt: 1_000,
    checkedAt: 1_000,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: true },
    metadata: { accessMode: 'vscode-extension' },
    ...overrides,
  };
}

function oauthReady(usedPercent = 20, observedAt = 5_000): ClaudeOAuthSnapshot {
  return {
    availability: 'ready',
    fiveHour: { usedPercent, remainingPercent: 100 - usedPercent, resetsAt: null },
    checkedAt: observedAt,
    observedAt,
    stale: false,
    retryAt: null,
  };
}

describe('applyClaudeOAuthOverlay', () => {
  it('passes an official snapshot through untouched (metadata annotated only) when OAuth is not enabled', () => {
    const official = baseSnapshot();
    const merged = applyClaudeOAuthOverlay(official, undefined);
    expect(merged.availability).toBe('manual-only');
    expect(merged.usageWindows).toEqual([]);
    expect(merged.metadata?.accountLimitsSource).toBe('none');
  });

  it('overlays a ready-experimental snapshot onto manual-only when the official status-line has no account data', () => {
    const official = baseSnapshot({ availability: 'manual-only' });
    const merged = applyClaudeOAuthOverlay(official, oauthReady(33));
    expect(merged.availability).toBe('ready-experimental');
    expect(merged.usageWindows[0]?.usedPercent).toBe(33);
    expect(merged.source).toBe('Experimental — undocumented Anthropic usage endpoint');
    expect(merged.metadata?.accountLimitsSource).toBe('experimental-oauth');
  });

  it('never overlays experimental data onto a genuine configuration-problem state (repair-required)', () => {
    const official = baseSnapshot({ availability: 'repair-required' });
    const merged = applyClaudeOAuthOverlay(official, oauthReady(33));
    expect(merged.availability).toBe('repair-required');
    expect(merged.usageWindows).toEqual([]);
  });

  it('never replaces upstream-statusline-not-invoked with a raw manual-only label when experimental data is ready', () => {
    const official = baseSnapshot({ availability: 'upstream-statusline-not-invoked' });
    const merged = applyClaudeOAuthOverlay(official, oauthReady(10));
    expect(merged.availability).toBe('ready-experimental');
    expect(merged.availability).not.toBe('upstream-statusline-not-invoked');
  });

  it('keeps official context/model/session-cost fields untouched even when OAuth wins the 5h/7d numbers', () => {
    const official = baseSnapshot({
      availability: 'ready',
      usageWindows: [
        {
          id: 'five-hour',
          label: '5h',
          usedPercent: 1,
          remainingPercent: 99,
          resetsAt: null,
          windowDurationMinutes: 300,
        },
      ],
      observedAt: 1_000,
      tokens: { contextUsedPercent: 42, totalCostUsd: 1.23 },
    });
    const merged = applyClaudeOAuthOverlay(official, oauthReady(90, 5_000));
    expect(merged.usageWindows[0]?.usedPercent).toBe(90); // OAuth is fresher, wins the account limit
    expect(merged.tokens).toEqual({ contextUsedPercent: 42, totalCostUsd: 1.23 }); // untouched
    expect(merged.metadata?.contextSource).toBe('official-status-line');
  });

  it('keeps the official 5h/7d numbers when they are fresher than the OAuth snapshot', () => {
    const official = baseSnapshot({
      availability: 'ready',
      usageWindows: [
        {
          id: 'five-hour',
          label: '5h',
          usedPercent: 7,
          remainingPercent: 93,
          resetsAt: null,
          windowDurationMinutes: 300,
        },
      ],
      observedAt: 9_000,
    });
    const merged = applyClaudeOAuthOverlay(official, oauthReady(50, 1_000));
    expect(merged.usageWindows[0]?.usedPercent).toBe(7);
    expect(merged.metadata?.accountLimitsSource).toBe('official-status-line');
  });

  it('surfaces consent-required only when the official status-line has no automatic account data', () => {
    const official = baseSnapshot({ availability: 'manual-only' });
    const merged = applyClaudeOAuthOverlay(official, {
      availability: 'consent-required',
      checkedAt: 1,
      observedAt: null,
      stale: false,
      retryAt: null,
    });
    expect(merged.availability).toBe('consent-required');
  });
});
