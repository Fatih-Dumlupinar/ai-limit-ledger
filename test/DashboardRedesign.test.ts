import { describe, expect, it } from 'vitest';
import { createNonce, renderDashboard } from '../src/ui/DetailsView';
import { DASHBOARD_ACTION_ICON_IDS } from '../src/ui/DashboardIcons';
import { DASHBOARD_ACTION_REGISTRY } from '../src/ui/DashboardActionRegistry';
import {
  DASHBOARD_ICON_IDS,
  DASHBOARD_ICON_REGISTRY,
  renderDashboardIcon,
} from '../src/ui/DashboardIcons';
import type { ProviderSnapshot, UsageWindow } from '../src/providers/types';

const window = (
  id: string,
  usedPercent: number,
  remainingPercent = 100 - usedPercent,
): UsageWindow => ({
  id,
  label: id,
  usedPercent,
  remainingPercent,
  resetsAt: 1_900_000_000,
  windowDurationMinutes: 300,
});

function snapshot(
  providerId: string,
  availability: ProviderSnapshot['availability'],
  overrides: Partial<ProviderSnapshot> = {},
): ProviderSnapshot {
  return {
    providerId,
    providerName: providerId,
    availability,
    connected: availability !== 'not-selected' && availability !== 'cli-not-installed',
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Not connected',
    observedAt: 1_750_000_000_000,
    checkedAt: 1_750_000_000_000,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
    ...overrides,
  };
}

function providerArticle(html: string, providerId: string): string {
  const match = new RegExp(
    `<article class="(?:provider-card|setup-card)"[^>]+data-provider-id="${providerId}"[\\s\\S]*?<\\/article>`,
  ).exec(html);
  return match?.[0] ?? '';
}

describe('Task 5 dashboard redesign', () => {
  it('uses a complete fixed SVG icon registry with no external or executable content', () => {
    expect(new Set(DASHBOARD_ICON_IDS).size).toBe(DASHBOARD_ICON_IDS.length);
    expect(DASHBOARD_ICON_IDS).toHaveLength(19);

    for (const iconId of DASHBOARD_ICON_IDS) {
      const icon = renderDashboardIcon(iconId);
      expect(icon).toContain('<svg');
      expect(icon).toContain('viewBox="0 0 16 16"');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('focusable="false"');
      expect(icon).toContain('currentColor');
      expect(icon).not.toContain('<script');
      expect(icon).not.toMatch(/(?:https?:)?\/\//);
      expect(icon).not.toMatch(/\bon[a-z]+=/i);
      expect(DASHBOARD_ICON_REGISTRY[iconId]).toBeTruthy();
    }

    expect(renderDashboardIcon('unknown' as never)).toBe('');
  });

  it('maps every registered action to one allowlisted icon', () => {
    expect(Object.keys(DASHBOARD_ACTION_ICON_IDS)).toHaveLength(DASHBOARD_ACTION_REGISTRY.length);

    for (const definition of DASHBOARD_ACTION_REGISTRY) {
      const iconId = DASHBOARD_ACTION_ICON_IDS[definition.id];
      expect(DASHBOARD_ICON_IDS).toContain(iconId);
      expect(renderDashboardIcon(iconId)).toContain('currentColor');
    }
  });

  it('renders real leading, spinner, and result icons without the old glyph placeholders', () => {
    const base = [
      snapshot('codex', 'ready', {
        connected: true,
        usageWindows: [window('primary', 10)],
      }),
    ];
    const renderAction = (state: 'idle' | 'working' | 'success' | 'error' | 'throttled') => {
      const actionState =
        state === 'idle'
          ? []
          : [
              {
                actionId: 'refresh-codex' as const,
                requestId: 'request-1',
                correlationId: 'correlation-1',
                state,
                message: state === 'working' ? 'Refreshing Codex' : state,
                retryable: true,
              },
            ];
      const html = renderDashboard(base, createNonce(), actionState);
      return /<button[^>]+data-action-id="refresh-codex"[\s\S]*?<\/button>/.exec(
        providerArticle(html, 'codex'),
      )?.[0];
    };

    const idle = renderAction('idle');
    expect(idle).toContain('data-action-icon="refresh"');
    expect(idle).toContain('class="action-button__leading-icon"');
    expect(idle).toContain('class="action-button__spinner" aria-hidden="true" hidden');
    expect(idle).toContain('class="action-button__state-icon" aria-hidden="true" hidden');

    const working = renderAction('working');
    expect(working).toContain('class="action-button__leading-icon" aria-hidden="true" hidden');
    expect(working).toContain('class="action-button__spinner" aria-hidden="true"></span>');
    expect(working).toContain('aria-busy="true"');
    expect(working).toContain(' disabled');
    expect(working).toContain('class="action-button__state-icon" aria-hidden="true" hidden');

    for (const state of ['success', 'error', 'throttled'] as const) {
      const button = renderAction(state);
      expect(button).toContain(`data-state-icon="${state}"`);
      expect(button).not.toContain('class="action-button__leading-icon" aria-hidden="true">');
      expect(button).toContain('class="action-button__state-icon" aria-hidden="true">');
    }
  });

  it('uses a real More Actions icon while keeping the accessible label and menu actions', () => {
    const html = renderDashboard([], createNonce());

    expect(html).toContain('<summary aria-label="More actions">');
    expect(html).toContain('class="dashboard-icon more-actions__icon"');
    expect(html).toContain('data-action-icon="logs"');
    expect(html).toContain('data-action-icon="copy"');
    expect(html).toContain('data-action-icon="export"');
    expect(html).toContain('summary::after{content:none}');
    expect(html).not.toContain('>›Refresh');
    expect(html).not.toContain('>›Official usage');
  });

  it('renders active, available, and hidden providers in deterministic descriptor order', () => {
    const html = renderDashboard(
      [
        snapshot('grok', 'cli-not-installed'),
        snapshot('codex', 'ready', {
          connected: true,
          usageWindows: [window('primary', 15)],
          source: 'Official Codex App Server',
        }),
        snapshot('unknown-provider', 'ready'),
      ],
      createNonce(),
    );

    expect(html).toContain('data-provider-id="codex" data-provider-state="ready"');
    expect(html).toContain('Available Integrations');
    expect(html).toContain('data-provider-id="grok" data-provider-state="cli-not-installed"');
    expect(html).not.toContain('unknown-provider');
    expect(html.indexOf('data-provider-id="codex"')).toBeLessThan(
      html.indexOf('data-provider-id="grok"'),
    );
    expect(html).toContain('<main');
    expect(html).toContain('<header');
    expect(html).toContain('<footer');
  });

  it('renders accessible numeric progress with remaining width, used text, and severity classes', () => {
    const html = renderDashboard(
      [
        snapshot('codex', 'ready', {
          connected: true,
          usageWindows: [window('primary', 15), window('weekly', 72)],
          source: 'Official Codex App Server',
        }),
      ],
      createNonce(),
    );
    const card = providerArticle(html, 'codex');

    expect(card.match(/role="progressbar"/g)).toHaveLength(2);
    expect(card).toContain('style="width:85%"');
    expect(card).toContain('85% left · 15% used');
    expect(card).toContain('aria-valuetext="85% remaining, 15% used"');
    expect(card).toContain('usage-progress--warning');
    expect(card).toContain('aria-valuemin="0"');
    expect(card).toContain('aria-valuemax="100"');
    expect(card).toContain('aria-valuenow="85"');
    expect(card).toContain('aria-label="Codex primary account limit remaining"');
  });

  it('accepts zero, clamps finite values, and omits NaN progress', () => {
    const html = renderDashboard(
      [
        snapshot('codex', 'ready', {
          connected: true,
          usageWindows: [
            window('zero', 0),
            window('over', 180, -80),
            window('negative', -20, 120),
            window('invalid', Number.NaN, Number.NaN),
          ],
          source: 'Official Codex App Server',
        }),
      ],
      createNonce(),
    );
    const card = providerArticle(html, 'codex');

    expect(card).toContain('style="width:100%"');
    expect(card).toContain('style="width:0%"');
    expect(card).not.toContain('data-window-id="invalid"');
    expect(card).not.toContain('NaN');
    expect(card).not.toContain('undefined');
  });

  it('shrinks remaining fill and adds critical copy when capacity is nearly exhausted', () => {
    const html = renderDashboard(
      [
        snapshot('codex', 'ready', {
          connected: true,
          usageWindows: [window('critical', 95)],
          source: 'Official Codex App Server',
        }),
      ],
      createNonce(),
    );
    const card = providerArticle(html, 'codex');

    expect(card).toContain('95% used · critical');
    expect(card).toContain('style="width:5%"');
    expect(card).toContain('aria-valuenow="5"');
    expect(card).toContain('5% remaining, 95% used');
    expect(card).toContain('Critical');
  });

  it('renders Claude windows separately and removes duplicate buckets', () => {
    const html = renderDashboard(
      [
        snapshot('claude', 'ready', {
          connected: true,
          source: 'Official Claude Code status-line',
          usageWindows: [
            { ...window('five-hour', 20), label: '5h' },
            { ...window('seven-day', 40), label: '7d' },
            { ...window('five-hour', 25), label: 'duplicate' },
          ],
        }),
      ],
      createNonce(),
    );
    const card = providerArticle(html, 'claude');

    expect(card.match(/role="progressbar"/g)).toHaveLength(2);
    expect(card.match(/data-window-id="five-hour"/g)).toHaveLength(1);
    expect(card).toContain('Account limit — 5-hour window');
    expect(card).toContain('Account limit — 7-day window');
  });

  it('does not fabricate Copilot progress without a denominator and keeps zero raw metrics', () => {
    const html = renderDashboard(
      [
        snapshot('copilot', 'organization-managed', {
          connected: true,
          source: 'Official GitHub Billing REST API',
          credits: { used: 0, allowance: null, remaining: null },
          metadata: {
            premiumInteractionsCreditsUsed: 0,
            chatCreditsUsed: 0,
            completionsCreditsUsed: 36,
          },
        }),
      ],
      createNonce(),
    );
    const card = providerArticle(html, 'copilot');

    expect(card).not.toContain('role="progressbar"');
    expect(card).toContain('Monthly allowance not provided');
    expect(card).toContain('AI credits</dt><dd>0');
    expect(card).toContain('Premium interactions</dt><dd>0');
    expect(card).toContain('Completions quota</dt><dd>36');
  });

  it('shows Grok Free as connected without an empty or fake progress bar', () => {
    const html = renderDashboard(
      [
        snapshot('grok', 'connected-no-billing-method', {
          connected: true,
          plan: 'Free',
          source: 'Official Grok Build billing extension',
        }),
      ],
      createNonce(),
    );
    const card = providerArticle(html, 'grok');

    expect(card).toContain('Free plan');
    expect(card).toContain('Connected');
    expect(card).toContain('Numeric usage is not exposed by this source.');
    expect(card).not.toContain('role="progressbar"');
    expect(card).not.toContain('0% used');
  });

  it('keeps stale/LKG data visible, labels experimental sources, and shows valid backoff', () => {
    const html = renderDashboard(
      [
        snapshot('claude', 'rate-limited-experimental', {
          connected: true,
          stale: true,
          retryAt: 1_900_000_000_000,
          usageWindows: [window('five-hour', 55)],
          source: 'Experimental — undocumented Anthropic usage endpoint',
          metadata: { accountLimitsSource: 'last-known-good-oauth' },
          lastSuccessfulDataUpdate: 1_749_999_000_000,
        }),
      ],
      createNonce(),
    );
    const card = providerArticle(html, 'claude');

    expect(card).toContain('Stale data');
    expect(card).toContain('Showing last known usage.');
    expect(card).toContain('Experimental');
    expect(card).toContain('Experimental — undocumented Anthropic usage endpoint');
    expect(card).toContain('Refresh paused until');
    expect(card).toContain('role="progressbar"');
  });

  it('enforces one primary and one secondary action while preserving action IDs and feedback state', () => {
    const html = renderDashboard(
      [
        snapshot('codex', 'ready', {
          connected: true,
          usageWindows: [window('primary', 10)],
          source: 'Official Codex App Server',
        }),
      ],
      createNonce(),
      [
        {
          actionId: 'refresh-codex',
          requestId: 'request-1',
          correlationId: 'correlation-1',
          state: 'working',
          message: 'Refreshing Codex',
          retryable: true,
        },
      ],
    );
    const card = providerArticle(html, 'codex');

    expect(card.match(/data-action-role="primary"/g)).toHaveLength(1);
    expect(card.match(/data-action-role="secondary"/g)).toHaveLength(1);
    expect(card).toContain('More actions');
    expect(card).toContain('data-action-id="refresh-codex"');
    expect(card).toContain('data-action-state="working"');
    expect(card).toContain('aria-busy="true"');
    expect(card).toContain('disabled');
    expect(card).not.toContain('RefreshRestart');
  });

  it('uses semantic headings, logo URI, nonce CSP, safe DOM updates, theme tokens, and responsive accessibility CSS', () => {
    const nonce = createNonce();
    const html = renderDashboard(
      [snapshot('codex', 'ready', { connected: true, usageWindows: [window('primary', 10)] })],
      nonce,
      [],
      'vscode-webview-resource://extension/assets/icon.png',
      'vscode-webview://test',
    );

    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<h2 id="active-providers-heading">Active Providers</h2>');
    expect(html).toContain('<h3>Codex</h3>');
    expect(html).toContain('alt="AI Limit Ledger"');
    expect(html).toContain('src="vscode-webview-resource://extension/assets/icon.png"');
    expect(html).toContain(`img-src vscode-webview://test`);
    expect(html).toContain(`style-src 'nonce-${nonce}'`);
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('.innerHTML');
    expect(html).toContain('var(--vscode-editor-background)');
    expect(html).toContain('@media(forced-colors:active)');
    expect(html).toContain('@media(prefers-reduced-motion:reduce)');
    expect(html).toContain('minmax(min(100%,320px),1fr)');
    expect(html).toContain('focus-visible');
  });

  it('keeps an empty active section while showing all supported available integrations', () => {
    const html = renderDashboard([], createNonce());

    expect(html).toContain(
      'No active providers yet. Choose an integration below to start monitoring usage.',
    );
    expect(html).toContain('Available Integrations');
    expect((html.match(/class="setup-card"/g) ?? []).length).toBe(4);
  });

  it('does not turn a single provider error into a global dashboard error', () => {
    const html = renderDashboard(
      [snapshot('codex', 'error', { connected: true, source: 'Official Codex App Server' })],
      createNonce(),
    );

    expect(providerArticle(html, 'codex')).toContain('Error');
    expect(html).not.toContain('Usage data is temporarily unavailable.');
  });
});
