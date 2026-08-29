import { describe, expect, it, vi } from 'vitest';
import { calculateCopilotAllowance } from '../src/providers/copilot/CopilotAllowanceCalculator';
import {
  GitHubAuthenticationService,
  COPILOT_PAT_SECRET_KEY,
} from '../src/providers/copilot/GitHubAuthenticationService';
import { parseCopilotApiResponse } from '../src/providers/copilot/GitHubBillingClient';
import { nextCopilotResetAt, parseCopilotUsage } from '../src/providers/copilot/CopilotUsageParser';
import { CopilotProvider } from '../src/providers/copilot/CopilotProvider';

describe('Copilot allowlist and usage model', () => {
  it('copies only documented billing fields and aggregates the current response', () => {
    const parsed = parseCopilotApiResponse({
      timePeriod: { year: 2026, month: 8 },
      secret: 'must not survive',
      usageItems: [
        {
          model: 'gpt-5',
          unitType: 'ai-credits',
          netQuantity: 100,
          discountQuantity: 70,
          netAmount: 1.25,
          token: 'ignored',
        },
        {
          model: 'claude-sonnet',
          unitType: 'ai-credits',
          grossQuantity: 20,
          discountQuantity: 20,
          grossAmount: 0,
        },
      ],
    });
    expect(parsed).not.toHaveProperty('secret');
    expect(parsed.usageItems[0]).not.toHaveProperty('token');
    const usage = parseCopilotUsage(parsed, new Date('2026-08-24T12:00:00Z'));
    expect(usage.usedCredits).toBe(120);
    expect(usage.includedCredits).toBe(90);
    expect(usage.additionalCredits).toBe(30);
    expect(usage.modelBreakdown.map((item) => item.model)).toEqual(['gpt-5', 'claude-sonnet']);
    expect(usage.nextResetAt).toBe(Date.UTC(2026, 8, 1));
  });

  it('resets on the first day of the next UTC month', () => {
    expect(nextCopilotResetAt(new Date('2026-12-31T23:59:00Z'))).toBe(Date.UTC(2027, 0, 1));
  });

  it('does not calculate remaining percentage for unknown auto allowance', () => {
    const usage = parseCopilotUsage({ timePeriod: '2026-08', usageItems: [] });
    const result = calculateCopilotAllowance('auto', undefined, usage);
    expect(result.allowance).toBeNull();
    expect(result.remainingPercent).toBeNull();
    expect(result.label).toBe('Monthly allowance not configured');
  });

  it('maps configured plans and custom allowances', () => {
    const usage = parseCopilotUsage({
      timePeriod: '2026-08',
      usageItems: [
        {
          product: 'Copilot',
          netQuantity: 430,
          discountQuantity: null,
          grossQuantity: null,
          sku: null,
          model: null,
          unitType: 'ai-credits',
          grossAmount: null,
          netAmount: null,
        },
      ],
    });
    expect(calculateCopilotAllowance('pro', undefined, usage).remaining).toBe(1070);
    expect(calculateCopilotAllowance('custom', 500, usage).remaining).toBe(70);
  });
});

describe('GitHub authentication consent boundaries', () => {
  it('prefers VS Code auth and disconnect deletes only the AI Limit Ledger PAT secret', async () => {
    const getSession = vi.fn(async () => ({ accessToken: 'session-token' }));
    const secrets = {
      get: vi.fn(async () => 'pat-token'),
      store: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const service = new GitHubAuthenticationService({ getSession }, secrets);
    expect(await service.getToken(false)).toBe('session-token');
    await service.disconnect();
    expect(secrets.delete).toHaveBeenCalledWith(COPILOT_PAT_SECRET_KEY);
  });

  it('stores a PAT only after the user explicitly chooses the PAT fallback', async () => {
    const secrets = {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const service = new GitHubAuthenticationService(
      { getSession: vi.fn(async () => undefined) },
      secrets,
      { choose: async () => 'Use fine-grained PAT', input: async () => 'pat-value' },
    );
    expect(await service.connect()).toBe('connected');
    expect(secrets.store).toHaveBeenCalledWith(COPILOT_PAT_SECRET_KEY, 'pat-value');
  });
});

describe('CopilotProvider', () => {
  it('does not request billing when no credential is connected', async () => {
    const auth = new GitHubAuthenticationService(
      { getSession: vi.fn(async () => undefined) },
      {
        get: vi.fn(async () => undefined),
        store: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
    );
    const billing = { getCurrentUsage: vi.fn() };
    const provider = new CopilotProvider({
      authentication: auth,
      billing,
      detectCli: async () => ({ installed: true, executablePath: 'copilot', version: '1.0.80' }),
      detectExtensions: () => ({ installed: true, version: '1.200.0', ids: ['GitHub.copilot'] }),
    });
    await provider.start();
    await provider.refresh(true);
    expect(provider.getSnapshot()?.availability).toBe('authentication-required');
    expect(billing.getCurrentUsage).not.toHaveBeenCalled();
  });

  function authWithToken() {
    return new GitHubAuthenticationService(
      { getSession: vi.fn(async () => ({ accessToken: 'gh-token' })) },
      { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
    );
  }

  it('uses the experimental entitlement fallback when organization-managed and opted in', async () => {
    const billing = {
      getCurrentUsage: vi.fn(async () => ({ kind: 'organization-managed' as const, status: 404 })),
    };
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({
          copilot_plan: 'business',
          token_based_billing: true,
          quota_reset_date: '2026-09-01',
          quota_snapshots: {
            premium_interactions: { credits_used: 31, unlimited: true, entitlement: 0 },
          },
        }),
    }));
    const provider = new CopilotProvider({
      authentication: authWithToken(),
      billing,
      detectCli: async () => ({ installed: true, executablePath: 'copilot', version: '1.0.80' }),
      detectExtensions: () => ({ installed: true, version: '1.200.0', ids: ['GitHub.copilot'] }),
      experimentalEnabled: () => true,
      experimentalFetch,
    });
    await provider.start();
    await provider.refresh(true);
    const snapshot = provider.getSnapshot();
    expect(snapshot?.availability).toBe('ready-experimental');
    expect(snapshot?.credits?.used).toBe(31);
    // unlimited + zero entitlement must never render as a fabricated percentage.
    expect(snapshot?.usageWindows).toEqual([]);
    expect(snapshot?.metadata?.billingEndpoint).toBe('experimental-entitlement');
  });

  it('falls back to the plain organization-managed snapshot when the experimental fetch fails', async () => {
    const billing = {
      getCurrentUsage: vi.fn(async () => ({ kind: 'organization-managed' as const, status: 404 })),
    };
    const experimentalFetch = vi.fn(async () => ({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => '',
    }));
    const provider = new CopilotProvider({
      authentication: authWithToken(),
      billing,
      detectCli: async () => ({ installed: true, executablePath: 'copilot', version: '1.0.80' }),
      detectExtensions: () => ({ installed: true, version: '1.200.0', ids: ['GitHub.copilot'] }),
      experimentalEnabled: () => true,
      experimentalFetch,
    });
    await provider.start();
    await provider.refresh(true);
    expect(provider.getSnapshot()?.availability).toBe('organization-managed');
  });

  it('treats credits_used=0 as valid data, not "no usage data"', async () => {
    const billing = {
      getCurrentUsage: vi.fn(async () => ({ kind: 'organization-managed' as const, status: 404 })),
    };
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({
          copilot_plan: 'business',
          quota_snapshots: {
            premium_interactions: { credits_used: 0, unlimited: true, entitlement: 0 },
          },
        }),
    }));
    const provider = new CopilotProvider({
      authentication: authWithToken(),
      billing,
      detectCli: async () => ({ installed: true, executablePath: 'copilot', version: '1.0.80' }),
      detectExtensions: () => ({ installed: true, version: '1.200.0', ids: ['GitHub.copilot'] }),
      experimentalEnabled: () => true,
      experimentalFetch,
    });
    await provider.start();
    await provider.refresh(true);
    const snapshot = provider.getSnapshot();
    expect(snapshot?.availability).toBe('ready-experimental');
    expect(snapshot?.credits?.used).toBe(0);
    expect(snapshot?.metadata?.premiumInteractionsCreditsUsed).toBe(0);
  });

  it('separates account management, endpoint plan, and configured billing scope', async () => {
    const billing = {
      getCurrentUsage: vi.fn(async () => ({ kind: 'organization-managed' as const, status: 404 })),
    };
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({
          copilot_plan: 'business',
          quota_snapshots: { chat: { credits_used: 5 } },
        }),
    }));
    const provider = new CopilotProvider({
      authentication: authWithToken(),
      billing,
      plan: () => 'pro',
      detectCli: async () => ({ installed: true, executablePath: 'copilot', version: '1.0.80' }),
      detectExtensions: () => ({ installed: true, version: '1.200.0', ids: ['GitHub.copilot'] }),
      experimentalEnabled: () => true,
      experimentalFetch,
    });
    await provider.start();
    await provider.refresh(true);
    const meta = provider.getSnapshot()?.metadata ?? {};
    expect(meta.accountManagement).toBe('organization-managed');
    expect(meta.endpointPlan).toBe('business');
    expect(meta.configuredBillingScope).toBe('pro');
    expect(meta.chatCreditsUsed).toBe(5);
  });

  it('reports each quota bucket independently without summing them', async () => {
    const billing = {
      getCurrentUsage: vi.fn(async () => ({ kind: 'organization-managed' as const, status: 404 })),
    };
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({
          quota_snapshots: {
            premium_interactions: { credits_used: 3 },
            chat: { credits_used: 7 },
            completions: { credits_used: 11 },
          },
        }),
    }));
    const provider = new CopilotProvider({
      authentication: authWithToken(),
      billing,
      detectCli: async () => ({ installed: true, executablePath: 'copilot', version: '1.0.80' }),
      detectExtensions: () => ({ installed: true, version: '1.200.0', ids: ['GitHub.copilot'] }),
      experimentalEnabled: () => true,
      experimentalFetch,
    });
    await provider.start();
    await provider.refresh(true);
    const meta = provider.getSnapshot()?.metadata ?? {};
    expect(meta.premiumInteractionsCreditsUsed).toBe(3);
    expect(meta.chatCreditsUsed).toBe(7);
    expect(meta.completionsCreditsUsed).toBe(11);
  });

  it('does not call the experimental fetch when not opted in (no network without consent)', async () => {
    const billing = {
      getCurrentUsage: vi.fn(async () => ({ kind: 'organization-managed' as const, status: 404 })),
    };
    const experimentalFetch = vi.fn();
    const provider = new CopilotProvider({
      authentication: authWithToken(),
      billing,
      detectCli: async () => ({ installed: true, executablePath: 'copilot', version: '1.0.80' }),
      detectExtensions: () => ({ installed: true, version: '1.200.0', ids: ['GitHub.copilot'] }),
      experimentalEnabled: () => false,
      experimentalFetch,
    });
    await provider.start();
    await provider.refresh(true);
    expect(experimentalFetch).not.toHaveBeenCalled();
    expect(provider.getSnapshot()?.availability).toBe('organization-managed');
  });
});
