import { describe, expect, it } from 'vitest';
import {
  createNonce,
  isAllowedMessage,
  renderDashboard,
  renderWebview,
  setDashboardRenderSettings,
} from '../src/ui/DetailsView';
import { PROVIDER_INITIALIZATION_TIMEOUT_MS } from '../src/ui/DetailsView';
import type { LimitSnapshot } from '../src/appServer/types';
import type { ProviderSnapshot } from '../src/providers/types';
import { buildCodexUsageInsights } from '../src/providers/UsageInsights';
const snapshot: LimitSnapshot = {
  limits: [],
  planType: null,
  reachedType: null,
  resetCredits: null,
  updatedAt: new Date(),
  usage: {
    lifetimeTokens: null,
    peakDailyTokens: null,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
    dailyUsageBuckets: [{ startDate: '2026-08-26', tokens: 120 }],
  },
  cliVersion: null,
  connected: false,
  stale: true,
};
describe('DetailsView', () => {
  const request = (actionId: string) => ({
    type: 'dashboard.action.request',
    requestId: 'request-1',
    actionId,
  });
  it('creates a nonce-backed CSP and escapes data', () => {
    const nonce = createNonce();
    const html = renderWebview({ ...snapshot, planType: '<unsafe>' }, nonce);
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain('&lt;unsafe&gt;');
  });
  it('allowlists webview actions', () => {
    expect(isAllowedMessage(request('refresh-all'))).toBe(true);
    expect(isAllowedMessage(request('enable-claude'))).toBe(true);
    expect(isAllowedMessage(request('evil'))).toBe(false);
    expect(isAllowedMessage(request('repair-claude'))).toBe(true);
    expect(isAllowedMessage(request('diagnose-codex'))).toBe(true);
    expect(isAllowedMessage(request('open-codex-usage'))).toBe(true);
    expect(isAllowedMessage(request('open-claude-usage'))).toBe(true);
    expect(isAllowedMessage(request('copy-grok-usage'))).toBe(true);
    expect(
      isAllowedMessage({
        type: 'dashboard.action.request',
        requestId: 'request-1',
        actionId: 'open-codex-usage',
        url: 'https://example.com',
      }),
    ).toBe(false);
    expect(
      isAllowedMessage({
        type: 'dashboard.action.request',
        requestId: 'request-1',
        actionId: 'open-codex-usage',
        url: 'javascript:alert(1)',
      }),
    ).toBe(false);
  });

  it('renders an explicit not-selected card instead of an infinite initializing message', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'copilot',
          providerName: 'GitHub Copilot',
          availability: 'not-selected',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Not connected',
          observedAt: Date.now(),
          checkedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: false, usage: true, statusLine: false },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Not selected');
    expect(html).not.toContain('still initializing');
  });

  it('converts an expired initializing snapshot into a startup error', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'grok',
          providerName: 'Grok',
          availability: 'initializing',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Not connected',
          observedAt: 0,
          checkedAt: Date.now() - PROVIDER_INITIALIZATION_TIMEOUT_MS - 1,
          stale: false,
          capabilities: { rateLimits: false, usage: true, statusLine: false },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('startup-error');
    expect(html).not.toContain('still initializing');
  });

  it('renders typed insights with provenance in the Rich Dashboard and honors hidden mode', () => {
    const provider: ProviderSnapshot = {
      providerId: 'codex',
      providerName: 'Codex',
      availability: 'ready',
      connected: true,
      plan: 'pro',
      cliVersion: '0.6.0',
      usageWindows: [],
      source: 'Official Codex App Server',
      observedAt: Date.now(),
      checkedAt: Date.now(),
      stale: false,
      capabilities: { rateLimits: true, usage: true, statusLine: false },
      usageInsights: buildCodexUsageInsights({
        usage: {
          lifetimeTokens: 100,
          peakDailyTokens: 20,
          longestRunningTurnSec: 4,
          currentStreakDays: 2,
          longestStreakDays: 3,
          dailyUsageBuckets: [],
        },
        checkedAt: Date.now(),
      }),
    };
    setDashboardRenderSettings({ language: 'en', insightsMode: 'summary' });
    const rich = renderDashboard([provider], createNonce());
    expect(rich).toContain('Usage insights');
    expect(rich).toContain('Source provenance');
    setDashboardRenderSettings({ language: 'en', insightsMode: 'detailed' });
    expect(renderDashboard([provider], createNonce())).toContain('usage-insights-table__bar');
    setDashboardRenderSettings({ language: 'en', insightsMode: 'hidden' });
    expect(renderDashboard([provider], createNonce())).not.toContain('Usage insights');
  });
  it('renders the Claude setup action in the provider dashboard', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'integration-required',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: 0,
          stale: false,
          warning: 'Claude Code integration is disabled.',
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Try Automatic Claude Usage Tracking');
    expect(html).toContain('data-action-id="enable-claude"');
  });

  it('renders Codex recovery and official usage actions', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'codex',
          providerName: 'Codex',
          availability: 'ready',
          connected: true,
          plan: 'pro',
          cliVersion: 'codex-cli 0.3.7',
          usageWindows: [],
          source: 'Official Codex App Server',
          observedAt: Date.now(),
          checkedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: false },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('data-action-id="diagnose-codex"');
    expect(html).toContain('data-action-id="open-codex-usage"');
    expect(html).toContain('data-action-id="restart-codex-app-server"');
  });

  it('renders a single Repair integration action for repair-required, not a generic recheck button', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'repair-required',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: 0,
          stale: false,
          warning:
            'Claude CLI is installed, but the statusLine connection is missing. Run "AI Limit Ledger: Repair Claude Code Integration".',
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Repair integration');
    expect(html).toContain('data-action-id="repair-claude"');
    expect(html).not.toContain('Recheck integration');
    expect(html).not.toContain('Try Automatic Claude Usage Tracking');
  });

  it('uses provider-specific refresh guidance after successful Repair', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'restart-required',
          connected: true,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Refresh Claude Usage');
    expect(html).toContain('data-action-id="refresh-claude"');
    expect(html).not.toContain('Repair integration');
  });

  it('re-rendering the dashboard for a live snapshot update reflects the new state (no reopen needed)', () => {
    const nonce = createNonce();
    const waiting = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'waiting-for-first-response',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: 0,
          stale: false,
          warning:
            'Waiting for the first completed Claude CLI response containing rate-limit data.',
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      nonce,
    );
    expect(waiting).toContain('Waiting for the first completed Claude CLI response');

    const ready = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'ready',
          connected: true,
          plan: null,
          cliVersion: '2.1.241',
          usageWindows: [
            {
              id: 'five-hour',
              label: '5h',
              usedPercent: 10,
              remainingPercent: 90,
              resetsAt: 1_900_000_000,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      nonce,
    );
    expect(ready).not.toContain('Waiting for the first completed Claude CLI response');
    expect(ready).toContain('90% left');
  });

  it('never renders a 1970 reset date for a provider usage window (dashboard card)', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'codex',
          providerName: 'Codex',
          availability: 'ready',
          connected: true,
          plan: 'Plus',
          cliVersion: '1.0',
          usageWindows: [
            {
              id: 'codex-0',
              label: '5h',
              usedPercent: 24,
              remainingPercent: 76,
              resetsAt: 1_800_000_000,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Official Codex App Server',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: false },
        },
      ],
      createNonce(),
    );
    expect(html).not.toContain('1970');
    expect(html).toContain(new Date(1_800_000_000 * 1000).toLocaleString('en-US'));
  });

  it('renders separate 5-hour/7-day rows with reset times for Claude', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'ready',
          connected: true,
          plan: null,
          cliVersion: '2.1.241',
          usageWindows: [
            {
              id: 'five-hour',
              label: '5h',
              usedPercent: 27,
              remainingPercent: 73,
              resetsAt: 1_800_000_000,
              windowDurationMinutes: 300,
            },
            {
              id: 'seven-day',
              label: '7d',
              usedPercent: 41,
              remainingPercent: 59,
              resetsAt: null,
              windowDurationMinutes: 10080,
            },
          ],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          tokens: { contextUsedPercent: 12, contextRemainingPercent: 88, totalCostUsd: 0.42 },
          metadata: { modelName: 'Sonnet 5' },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('27% used');
    expect(html).toContain('73% left');
    expect(html).toContain('41% used');
    expect(html).toContain('Not provided');
    expect(html).toContain('12% used, 88% left');
    expect(html).toContain('Sonnet 5');
    expect(html).toContain('$0.4200');
  });

  it('labels Claude windows explicitly and shows the metric-separation disclaimer in English and Turkish', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'ready',
          connected: true,
          plan: null,
          cliVersion: '2.1.241',
          usageWindows: [
            {
              id: 'five-hour',
              label: '5h',
              usedPercent: 0,
              remainingPercent: 100,
              resetsAt: null,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          checkedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          tokens: { contextUsedPercent: 5 },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Account limit — 5-hour window');
    expect(html).toContain('Current session context window');
    expect(html).toContain(
      'Session context usage and account rate-limit usage are separate metrics and may show different percentages.',
    );
    expect(html).toContain(
      'Oturum bağlam kullanımı ile hesap kullanım limiti farklı ölçümlerdir; yüzdeleri aynı olmak zorunda değildir.',
    );
  });

  it('never rounds a small nonzero percentage away to 0', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'ready',
          connected: true,
          plan: null,
          cliVersion: '2.1.241',
          usageWindows: [
            {
              id: 'five-hour',
              label: '5h',
              usedPercent: 0.4,
              remainingPercent: 99.6,
              resetsAt: null,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          checkedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('0.4% used');
  });

  it('keeps provider event, fallback refresh, and snapshot age in technical details', () => {
    const observedAt = Date.now();
    const html = renderDashboard(
      [
        {
          providerId: 'codex',
          providerName: 'Codex',
          availability: 'ready',
          connected: true,
          plan: 'Plus',
          cliVersion: '1.0',
          usageWindows: [
            {
              id: 'codex-0',
              label: '5h',
              usedPercent: 10,
              remainingPercent: 90,
              resetsAt: null,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Official Codex App Server',
          observedAt,
          checkedAt: observedAt,
          lastProviderEventAt: observedAt,
          nextFallbackRefreshAt: observedAt + 60_000,
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: false },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Last provider event');
    expect(html).toContain('Next fallback refresh');
    expect(html).toContain('Snapshot age');
  });

  it('explains the missing-subscription case instead of leaving rate limits blank', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'ready',
          connected: true,
          plan: null,
          cliVersion: '2.1.241',
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Pro/Max');
  });

  it('shows provider-specific recheck guidance for restart-required state', () => {
    const restartRequired = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'restart-required',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(restartRequired).toContain('Recheck integration');
    expect(restartRequired).toContain('data-action-id="refresh-claude"');
  });

  it('shows "Last check" without "Last successful data update" when no real data has been parsed', () => {
    const checkedAt = new Date('2026-08-23T10:00:00.000Z').getTime();
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'waiting-for-first-response',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: checkedAt,
          checkedAt,
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('Last check:');
    expect(html).not.toContain('Last successful data update');
  });

  it('collapses healthy freshness into one semantic summary', () => {
    const observedAt = new Date('2026-08-23T09:00:00.000Z').getTime();
    const checkedAt = new Date('2026-08-23T10:00:00.000Z').getTime();
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'ready',
          connected: true,
          plan: null,
          cliVersion: '2.1.241',
          usageWindows: [
            {
              id: 'five-hour',
              label: '5h',
              usedPercent: 10,
              remainingPercent: 90,
              resetsAt: null,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Official Claude Code status-line',
          observedAt,
          checkedAt,
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('<div class="freshness-summary"><span><strong>Data freshness:</strong>');
  });

  it('offers install-guide, terminal launch (when the CLI is present), and copy-diagnostics for upstream-statusline-not-invoked', () => {
    const withCli = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'upstream-statusline-not-invoked',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          metadata: { hostKind: 'standalone-cli' },
        },
      ],
      createNonce(),
    );
    expect(withCli).toContain('data-action-id="open-claude-install-guide"');
    expect(withCli).toContain('data-action-id="launch-claude-terminal"');
    expect(withCli).toContain('data-action-id="copy-claude-diagnostics"');

    const sidebarOnly = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'upstream-statusline-not-invoked',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          metadata: { hostKind: 'vscode-sidebar' },
        },
      ],
      createNonce(),
    );
    expect(sidebarOnly).not.toContain('data-action-id="launch-claude-terminal"');
    expect(sidebarOnly).toContain('data-action-id="open-claude-install-guide"');
  });

  it('renders the unsupported-surface message distinctly', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'unsupported-surface',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          warning:
            'AI Limit Ledger could not identify how Claude Code is running here, so usage data cannot be confirmed on this surface.',
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('could not identify how Claude Code is running');
    expect(html).toContain('data-action-id="copy-claude-diagnostics"');
  });

  it('renders a connected, non-error manual-only card for extension-only mode, with no CLI install prompt and no successful-update timestamp', () => {
    const checkedAt = new Date('2026-08-23T10:00:00.000Z').getTime();
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'manual-only',
          connected: true,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: checkedAt,
          checkedAt,
          stale: false,
          warning:
            'Automatic usage tracking is not available on this host. Use /usage in Claude Code to check usage manually.',
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          metadata: {
            accessMode: 'vscode-extension',
            hostKind: 'vscode-sidebar',
            extensionVersion: '2.1.241',
          },
        },
      ],
      createNonce(),
    );
    // Connected, not broken.
    expect(html).toContain('Claude Code extension connected');
    expect(html).toContain('<b>Connection:</b> Connected');
    expect(html).toContain('VS Code extension');
    expect(html).toContain('2.1.241');
    // CLI absence framed as optional, never as an installation requirement/error.
    expect(html).toContain('Not installed — optional');
    expect(html).not.toMatch(/install(ing)? (the )?(standalone )?CLI (is required|now)/i);
    expect(html).not.toContain('$(warning)');
    // Terminology corrections.
    expect(html).toContain('Account plan:</b> Not exposed by the VS Code extension');
    expect(html).toContain('Last check:');
    expect(html).not.toContain('Last successful data update');
    // Actions.
    expect(html).toContain('data-action-id="open-claude-code"');
    expect(html).toContain('data-action-id="copy-claude-usage"');
    expect(html).toContain('Recheck automatic tracking');
    expect(html).toContain('data-action-id="diagnose-claude"');
    expect(html).toContain('data-action-id="open-claude-enhanced-mode-docs"');
    // Capability comparison table, correctly labeled as not-yet-implemented for CLI mode.
    expect(html).toContain('Optional — coming in a later AI Limit Ledger update');
    // The CLI-enhanced-mode link itself must stay neutral — never "required"/"recommended"/"fix".
    const learnMoreButton =
      /<button[^>]+data-action-id="open-claude-enhanced-mode-docs"[^>]*>.*?<span class="action-button__label">([^<]*)<\/span>/.exec(
        html,
      )?.[1];
    expect(learnMoreButton).toBeTruthy();
    expect(learnMoreButton).not.toMatch(/required|recommended|\bfix\b/i);
  });

  it('never shows the Enable button or waiting/setup copy for manual-only mode', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'manual-only',
          connected: true,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          metadata: { accessMode: 'vscode-extension' },
        },
      ],
      createNonce(),
    );
    expect(html).not.toContain('data-action-id="enable-claude"');
    expect(html).not.toContain('Complete a Claude Code response');
  });

  it('drops the Enable button and shows the waiting message once integration is enabled', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'waiting-for-first-response',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: 0,
          stale: false,
          warning: 'Complete a Claude Code response to receive usage data.',
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).not.toContain('data-action-id="enable-claude"');
    expect(html).toContain('Complete a Claude Code response to receive usage data.');
  });

  it('allowlists the experimental CLI-free usage webview actions', () => {
    expect(isAllowedMessage(request('enable-claude-oauth'))).toBe(true);
    expect(isAllowedMessage(request('disable-claude-oauth'))).toBe(true);
    expect(isAllowedMessage(request('open-claude-oauth-docs'))).toBe(true);
  });

  it('consent-required renders an Enable CLI-free Claude Usage button calling the correct command', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'consent-required',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: 0,
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          metadata: { accountLimitsSource: 'none', oauthAvailability: 'consent-required' },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('data-action-id="enable-claude-oauth"');
    expect(html).not.toContain('data-action-id="disable-claude-oauth"');
  });

  it('ready-experimental renders Refresh/Disable/official-usage buttons and the experimental source label', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'ready-experimental',
          connected: true,
          plan: null,
          cliVersion: null,
          usageWindows: [
            {
              id: 'five-hour',
              label: '5h',
              usedPercent: 21,
              remainingPercent: 79,
              resetsAt: null,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Experimental — undocumented Anthropic usage endpoint',
          observedAt: Date.now(),
          checkedAt: Date.now(),
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          metadata: { accountLimitsSource: 'experimental-oauth' },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('data-action-id="refresh-all"');
    expect(html).toContain('data-action-id="disable-claude-oauth"');
    expect(html).toContain('data-action-id="open-claude-usage"');
    expect(html).toContain('Experimental — undocumented Anthropic usage endpoint');
    expect(html).not.toContain('data-action-id="enable-claude-oauth"');
  });

  it('rate-limited-experimental is labeled "showing last known usage" rather than a bare error', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'rate-limited-experimental',
          connected: true,
          plan: null,
          cliVersion: null,
          usageWindows: [
            {
              id: 'five-hour',
              label: '5h',
              usedPercent: 55,
              remainingPercent: 45,
              resetsAt: null,
              windowDurationMinutes: 300,
            },
          ],
          source: 'Experimental — undocumented Anthropic usage endpoint',
          observedAt: Date.now(),
          checkedAt: Date.now(),
          stale: true,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
          metadata: { accountLimitsSource: 'last-known-good-oauth' },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('rate-limited — showing last known usage');
  });

  it('authentication-required points the user back to official Claude Code sign-in, never a fabricated percentage', () => {
    const html = renderDashboard(
      [
        {
          providerId: 'claude',
          providerName: 'Claude Code',
          availability: 'authentication-required',
          connected: false,
          plan: null,
          cliVersion: null,
          usageWindows: [],
          source: 'Official Claude Code status-line',
          observedAt: 0,
          stale: false,
          capabilities: { rateLimits: true, usage: true, statusLine: true },
        },
      ],
      createNonce(),
    );
    expect(html).toContain('data-action-id="open-claude-code"');
    expect(html).not.toContain('data-action-id="disable-claude-oauth"');
  });
});
