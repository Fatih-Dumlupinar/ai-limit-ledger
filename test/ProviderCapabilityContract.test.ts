import { describe, expect, it } from 'vitest';
import { createNonce, renderDashboard } from '../src/ui/DetailsView';
import {
  CANONICAL_PROVIDER_IDS,
  PROVIDER_CAPABILITY_DESCRIPTORS,
  normalizeProviderId,
  resolveProviderPresentation,
  resolveProviderPresentations,
} from '../src/providers/ProviderCapabilityContract';
import type { ProviderSnapshot } from '../src/providers/types';
import { combinedStatusText } from '../src/ui/StatusBarFormatter';

const capabilities = { rateLimits: true, usage: true, statusLine: false };

function snapshot(
  providerId: string,
  availability: ProviderSnapshot['availability'],
  overrides: Partial<ProviderSnapshot> = {},
): ProviderSnapshot {
  return {
    providerId,
    providerName: providerId,
    availability,
    connected: false,
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Not connected',
    observedAt: 1_000,
    checkedAt: 1_000,
    stale: false,
    capabilities,
    ...overrides,
  };
}

function numericWindow() {
  return [
    {
      id: 'current',
      label: 'Current',
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: null,
      windowDurationMinutes: null,
    },
  ];
}

describe('provider capability descriptors', () => {
  it('contains exactly one descriptor for each canonical provider', () => {
    expect(PROVIDER_CAPABILITY_DESCRIPTORS).toHaveLength(4);
    expect(
      new Set(PROVIDER_CAPABILITY_DESCRIPTORS.map((descriptor) => descriptor.providerId)).size,
    ).toBe(4);
    expect(PROVIDER_CAPABILITY_DESCRIPTORS.map((descriptor) => descriptor.providerId)).toEqual(
      CANONICAL_PROVIDER_IDS,
    );
  });

  it('models CLI and source requirements at capability level', () => {
    const claude = PROVIDER_CAPABILITY_DESCRIPTORS.find(
      (descriptor) => descriptor.providerId === 'claude',
    )!;
    const copilot = PROVIDER_CAPABILITY_DESCRIPTORS.find(
      (descriptor) => descriptor.providerId === 'copilot',
    )!;
    const grok = PROVIDER_CAPABILITY_DESCRIPTORS.find(
      (descriptor) => descriptor.providerId === 'grok',
    )!;
    const codex = PROVIDER_CAPABILITY_DESCRIPTORS.find(
      (descriptor) => descriptor.providerId === 'codex',
    )!;
    const statusLine = claude.automaticUsageCapabilities.find(
      (capability) => capability.id === 'claude-status-line',
    )!;
    const oauth = claude.automaticUsageCapabilities.find(
      (capability) => capability.id === 'claude-oauth-usage',
    )!;
    expect(statusLine.requiresCli).toBe(true);
    expect(oauth).toMatchObject({
      requiresCli: false,
      sourceStability: 'experimental-undocumented',
      requiresExplicitConsent: true,
    });
    expect(copilot.automaticUsageCapabilities.every((capability) => !capability.requiresCli)).toBe(
      true,
    );
    expect(grok.automaticUsageCapabilities.every((capability) => capability.requiresCli)).toBe(
      true,
    );
    expect(codex.automaticUsageCapabilities[0]).toMatchObject({
      requiresCli: true,
      sourceStability: 'official',
    });
  });
});

describe('provider presentation resolver', () => {
  const cases: Array<{
    name: string;
    input: ProviderSnapshot;
    expected: {
      dashboardPlacement: 'active' | 'available' | 'hidden';
      statusBarVisibility: 'visible' | 'hidden';
      normalizedState: string;
      dataAvailability?: string;
      attention?: string;
    };
  }> = [
    {
      name: 'Codex without its executable',
      input: snapshot('codex', 'unavailable', { errorCategory: 'executable-not-found' }),
      expected: {
        dashboardPlacement: 'available',
        statusBarVisibility: 'hidden',
        normalizedState: 'cli-not-installed',
      },
    },
    {
      name: 'ready Codex numeric usage',
      input: snapshot('codex', 'ready', {
        connected: true,
        usageWindows: numericWindow(),
        source: 'Official Codex App Server',
      }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'visible',
        normalizedState: 'ready',
        dataAvailability: 'numeric-current',
      },
    },
    {
      name: 'Claude OAuth without the CLI',
      input: snapshot('claude', 'ready-experimental', {
        connected: true,
        usageWindows: numericWindow(),
        metadata: { accountLimitsSource: 'experimental-oauth' },
      }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'visible',
        normalizedState: 'experimental',
        dataAvailability: 'numeric-current',
      },
    },
    {
      name: 'Claude manual-only mode',
      input: snapshot('claude', 'manual-only', {
        connected: true,
        metadata: { accessMode: 'vscode-extension' },
      }),
      expected: {
        dashboardPlacement: 'available',
        statusBarVisibility: 'hidden',
        normalizedState: 'setup-required',
      },
    },
    {
      name: 'Copilot numeric entitlement without its optional CLI',
      input: snapshot('copilot', 'ready-experimental', {
        connected: true,
        credits: { used: 12, allowance: 100, remaining: 88 },
        usageWindows: numericWindow(),
        metadata: { cliInstalled: false },
      }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'visible',
        normalizedState: 'experimental',
        dataAvailability: 'numeric-current',
      },
    },
    {
      name: 'Copilot endpoint zero is real usage data',
      input: snapshot('copilot', 'ready-experimental', {
        connected: true,
        credits: { used: 0, allowance: null, remaining: null },
        metadata: { cliInstalled: false },
      }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'visible',
        normalizedState: 'experimental',
        dataAvailability: 'numeric-current',
      },
    },
    {
      name: 'Copilot without an established connection',
      input: snapshot('copilot', 'authentication-required', { metadata: { cliInstalled: false } }),
      expected: {
        dashboardPlacement: 'available',
        statusBarVisibility: 'hidden',
        normalizedState: 'authentication-required',
      },
    },
    {
      name: 'Grok without its CLI',
      input: snapshot('grok', 'cli-not-installed'),
      expected: {
        dashboardPlacement: 'available',
        statusBarVisibility: 'hidden',
        normalizedState: 'cli-not-installed',
      },
    },
    {
      name: 'connected free Grok with no numeric limit',
      input: snapshot('grok', 'connected-no-billing-method', { connected: true }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'hidden',
        normalizedState: 'no-numeric-usage',
        dataAvailability: 'no-numeric-usage',
      },
    },
    {
      name: 'Grok numeric usage',
      input: snapshot('grok', 'ready-experimental', {
        connected: true,
        usageWindows: numericWindow(),
      }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'visible',
        normalizedState: 'experimental',
      },
    },
    {
      name: 'stale last-known-good usage',
      input: snapshot('codex', 'stale', {
        connected: true,
        stale: true,
        usageWindows: numericWindow(),
        lastSuccessfulDataUpdate: 900,
      }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'visible',
        normalizedState: 'stale',
        dataAvailability: 'numeric-last-known-good',
        attention: 'warning',
      },
    },
    {
      name: 'active provider backoff',
      input: snapshot('codex', 'rate-limited', { connected: true, retryAt: 2_000 }),
      expected: {
        dashboardPlacement: 'active',
        statusBarVisibility: 'visible',
        normalizedState: 'rate-limited',
        attention: 'warning',
      },
    },
    {
      name: 'not-selected provider',
      input: snapshot('grok', 'not-selected'),
      expected: {
        dashboardPlacement: 'available',
        statusBarVisibility: 'hidden',
        normalizedState: 'not-selected',
      },
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(resolveProviderPresentation({ snapshot: input, now: 2_000 })).toMatchObject(expected);
  });

  it('removes a deselected provider even if its old snapshot says ready', () => {
    const [presentation] = resolveProviderPresentations(
      [snapshot('codex', 'ready', { connected: true, usageWindows: numericWindow() })],
      { selectedProviderIds: ['claude'] },
    );
    expect(presentation).toMatchObject({
      providerId: 'codex',
      selected: false,
      dashboardPlacement: 'available',
      statusBarVisibility: 'hidden',
    });
  });

  it('keeps a healthy provider visible when another provider has startup-error', () => {
    const presentations = resolveProviderPresentations([
      snapshot('codex', 'startup-error', { errorCategory: 'initialize-failed' }),
      snapshot('claude', 'ready', { connected: true, usageWindows: numericWindow() }),
    ]);
    expect(presentations[0].normalizedState).toBe('startup-error');
    expect(presentations[1]).toMatchObject({
      dashboardPlacement: 'active',
      statusBarVisibility: 'visible',
    });
  });

  it('normalizes aliases and never leaves initialization pending after the timeout', () => {
    expect(normalizeProviderId('github-copilot')).toBe('copilot');
    expect(
      resolveProviderPresentation({
        snapshot: snapshot('grok-build', 'initializing', { checkedAt: 0 }),
        now: 10_001,
      }),
    ).toMatchObject({
      providerId: 'grok',
      normalizedState: 'startup-error',
      reasonCode: 'initialization-timeout',
    });
  });

  it('routes an unknown availability to a controlled error state', () => {
    const unknown = snapshot('codex', 'new-provider-state' as ProviderSnapshot['availability']);
    expect(resolveProviderPresentation({ snapshot: unknown })).toMatchObject({
      normalizedState: 'error',
      dashboardPlacement: 'available',
      statusBarVisibility: 'hidden',
      reasonCode: 'provider-error',
    });
  });

  it('uses the same presentation decisions for dashboard placement and status-bar visibility', () => {
    const snapshots = [
      snapshot('codex', 'ready', { connected: true, usageWindows: numericWindow() }),
      snapshot('grok', 'connected-no-billing-method', { connected: true }),
    ];
    const presentations = resolveProviderPresentations(snapshots);
    const dashboard = renderDashboard(snapshots, createNonce());
    const statusBar = combinedStatusText(snapshots, 'remaining');
    expect(presentations.map((presentation) => presentation.dashboardPlacement)).toEqual([
      'active',
      'active',
    ]);
    expect(presentations.map((presentation) => presentation.statusBarVisibility)).toEqual([
      'visible',
      'hidden',
    ]);
    expect(dashboard).toContain('Active Providers');
    expect(statusBar).toContain('codex');
    expect(statusBar).not.toContain('grok');
  });
});
