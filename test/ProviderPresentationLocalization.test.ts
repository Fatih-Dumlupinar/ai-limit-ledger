import { describe, expect, it } from 'vitest';
import {
  formatProviderCount,
  getUiTextCatalog,
  localizedProviderLinkLabel,
  localizedRateLimitWindowLabel,
} from '../src/ui/UiTextCatalog';
import { resolveProviderPresentation } from '../src/providers/ProviderCapabilityContract';
import { buildSafeDashboardDocumentModel, renderSafeDashboard } from '../src/ui/SafeDashboard';
import { task92Snapshots, TASK92_NOW } from './task92Fixtures';

describe('TASK 9.2 semantic provider presentation', () => {
  it('exposes localized status and explanation keys instead of provider message text', () => {
    const waiting = resolveProviderPresentation({
      snapshot: {
        ...task92Snapshots()[1]!,
        availability: 'waiting-for-first-response',
        usageWindows: [],
        warning: 'RAW WAITING MESSAGE MUST NOT BE USED AS UI COPY',
      },
    });
    const stale = resolveProviderPresentation({ snapshot: task92Snapshots()[1]! });
    expect(waiting.statusKey).toBe('setupRequired');
    expect(waiting.explanationKey).toBe('waitingForFirstResponse');
    expect(stale.explanationKey).toBe('showingLastKnownUsage');
    expect(waiting).not.toHaveProperty('warning');
  });

  it('localizes all known window kinds and falls back to a generic unknown window', () => {
    const en = getUiTextCatalog('en');
    const tr = getUiTextCatalog('tr');
    expect(localizedRateLimitWindowLabel('five-hour', '5h', null, en)).toBe('5-hour window');
    expect(localizedRateLimitWindowLabel('seven-day', '7d', null, tr)).toBe('7 günlük pencere');
    expect(localizedRateLimitWindowLabel('mystery', 'provider private label', null, tr)).toBe(
      'Kullanım penceresi',
    );
    expect(localizedRateLimitWindowLabel('weekly', 'weekly', null, en)).toBe('Weekly window');
    expect(localizedRateLimitWindowLabel('context', 'context', null, tr)).toBe('Bağlam penceresi');
    expect(localizedRateLimitWindowLabel('monthly', 'monthly', null, en)).toBe('Monthly window');
  });

  it('pluralizes provider counts with typed catalog templates for zero, one, and many', () => {
    const en = getUiTextCatalog('en');
    const tr = getUiTextCatalog('tr');
    expect(formatProviderCount(0, en)).toBe('0 active providers');
    expect(formatProviderCount(1, en)).toBe('1 active provider');
    expect(formatProviderCount(3, en)).toBe('3 active providers');
    expect(formatProviderCount(0, tr)).toBe('0 aktif sağlayıcı');
    expect(formatProviderCount(1, tr)).toBe('1 aktif sağlayıcı');
    expect(formatProviderCount(3, tr)).toBe('3 aktif sağlayıcı');
  });

  it('localizes link labels from stable link IDs without exposing registry English labels', () => {
    expect(localizedProviderLinkLabel('codex-usage', getUiTextCatalog('tr'))).toBe(
      'Codex kullanım panosunu aç',
    );
    expect(localizedProviderLinkLabel('grok-install', getUiTextCatalog('tr'))).toBe(
      'Grok Build kurulum rehberini aç',
    );
    expect(localizedProviderLinkLabel('copilot-billing', getUiTextCatalog('en'))).toBe(
      'Open GitHub billing',
    );
  });

  it('renders translated Safe Native enum labels while keeping configuration codes out of UI text', () => {
    const model = buildSafeDashboardDocumentModel(task92Snapshots(), {
      now: TASK92_NOW,
      language: 'tr',
      dashboardMode: 'safe-native',
      statusBarMode: 'compact',
      tooltipDensity: 'detailed',
      notificationLevel: 'warnings-and-errors',
      percentageMode: 'both',
      timeFormat: 'both',
    });
    const output = renderSafeDashboard(model);
    expect(output).toContain('Güvenli yerel');
    expect(output).toContain('Mutlak ve göreli zaman');
    expect(output).toContain('Uyarılar ve hatalar');
    expect(output).not.toContain('safe-native');
    expect(output).not.toContain('warnings-and-errors');
  });

  it('keeps raw warning/error/provider labels out of both semantic renderers', async () => {
    const raw = 'RAW ERROR PROVIDER LABEL 9.2';
    const snapshots = task92Snapshots().map((snapshot) => ({ ...snapshot, warning: raw }));
    const model = buildSafeDashboardDocumentModel(snapshots, { now: TASK92_NOW, language: 'tr' });
    const safe = renderSafeDashboard(model);
    expect(safe).not.toContain(raw);
    expect(
      model.activeProviders.every((provider) => provider.explanationKey || provider.statusKey),
    ).toBe(true);
    expect(
      (await import('../src/ui/DetailsView')).renderDashboard(snapshots, 'nonce'),
    ).not.toContain(raw);
  });
});
