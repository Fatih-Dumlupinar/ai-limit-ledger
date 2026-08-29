import { afterEach, describe, expect, it } from 'vitest';
import { createNonce, renderDashboard, setDashboardRenderSettings } from '../src/ui/DetailsView';
import { buildSafeDashboardDocumentModel, renderSafeDashboard } from '../src/ui/SafeDashboard';
import { task92Snapshots, TASK92_NOW } from './task92Fixtures';

function visibleText(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

afterEach(() => setDashboardRenderSettings({}));

describe('TASK 9.2 localization completeness', () => {
  it('localizes the four-provider Rich dashboard without leaking raw provider text', () => {
    setDashboardRenderSettings({
      language: 'tr',
      percentageMode: 'both',
      timeFormat: 'both',
      showAvailableIntegrations: true,
    });
    const text = visibleText(renderDashboard(task92Snapshots(), createNonce()));

    expect(text).toContain('4 aktif sağlayıcı');
    expect(text).toContain('Sonraki yedek yenileme');
    expect(text).toContain('Kullanım penceresi');
    expect(text).not.toContain('Next fallback refresh');
    expect(text).not.toContain('Available integrations');
    expect(text).not.toContain('Account limit');
    expect(text).not.toContain('Not applicable');
    expect(text).not.toContain('SECRET RAW PROVIDER WARNING');
    expect(text).not.toContain('raw-provider-window-label');
  });

  it('keeps Safe Native and Rich dashboard terminology aligned in Turkish', () => {
    setDashboardRenderSettings({ language: 'tr', percentageMode: 'both', timeFormat: 'both' });
    const rich = visibleText(renderDashboard(task92Snapshots(), createNonce()));
    const safe = renderSafeDashboard(
      buildSafeDashboardDocumentModel(task92Snapshots(), {
        now: TASK92_NOW,
        language: 'tr',
        percentageMode: 'both',
        timeFormat: 'both',
      }),
    );

    for (const phrase of ['Deneysel', 'Bilinen son kullanım', 'Sonraki otomatik kontrol']) {
      expect(rich + safe).toContain(phrase);
    }
    expect(safe).not.toContain('SECRET COPILOT BILLING MESSAGE');
    expect(safe).not.toContain('Experimental — undocumented Anthropic usage endpoint');
  });

  it('does not display English UI labels when Turkish is selected for no-data/setup cards', () => {
    setDashboardRenderSettings({ language: 'tr', showAvailableIntegrations: true });
    const html = renderDashboard(
      task92Snapshots().map((snapshot) => ({
        ...snapshot,
        availability:
          snapshot.providerId === 'grok' ? ('cli-not-installed' as const) : snapshot.availability,
        usageWindows: snapshot.providerId === 'codex' ? [] : snapshot.usageWindows,
      })),
      createNonce(),
    );
    const text = visibleText(html);
    expect(text).toContain('Entegrasyonlar');
    expect(text).not.toContain('Usage data is not available yet.');
    expect(text).not.toContain('Setup required');
    expect(text).not.toContain('Recheck installation');
  });

  it('keeps English as a stable language and still redacts provider warnings', () => {
    setDashboardRenderSettings({ language: 'en', percentageMode: 'both', timeFormat: 'both' });
    const text = visibleText(renderDashboard(task92Snapshots(), createNonce()));
    expect(text).toContain('Next fallback refresh');
    expect(text).toContain('Account limit');
    expect(text).toContain('Experimental');
    expect(text).not.toContain('SECRET RAW PROVIDER WARNING');
    expect(text).not.toContain('raw-provider-window-label');
  });

  it('uses semantic status/explanation text after a live language switch without changing snapshots', () => {
    const snapshots = task92Snapshots();
    setDashboardRenderSettings({ language: 'tr' });
    const turkish = visibleText(renderDashboard(snapshots, createNonce()));
    setDashboardRenderSettings({ language: 'en' });
    const english = visibleText(renderDashboard(snapshots, createNonce()));

    expect(turkish).toContain('Bilinen son kullanım');
    expect(english).toContain('Showing last known usage');
    expect(turkish).not.toContain('Showing last known usage');
    expect(snapshots[0]?.warning).toBe(
      'SECRET RAW PROVIDER WARNING MUST NEVER REACH THE DASHBOARD',
    );
  });

  it('renders all supported window kinds through the generic localized vocabulary', () => {
    setDashboardRenderSettings({ language: 'tr' });
    const html = renderDashboard(
      [
        {
          ...task92Snapshots()[0],
          usageWindows: [
            {
              ...task92Snapshots()[0]!.usageWindows[0]!,
              id: 'five-hour',
              label: '5h',
              windowDurationMinutes: 300,
            },
            {
              ...task92Snapshots()[0]!.usageWindows[0]!,
              id: 'seven-day',
              label: '7d',
              windowDurationMinutes: 10080,
            },
            {
              ...task92Snapshots()[0]!.usageWindows[0]!,
              id: 'weekly',
              label: 'weekly',
              windowDurationMinutes: null,
            },
            {
              ...task92Snapshots()[0]!.usageWindows[0]!,
              id: 'context',
              label: 'context',
              windowDurationMinutes: null,
            },
            {
              ...task92Snapshots()[0]!.usageWindows[0]!,
              id: 'monthly',
              label: 'monthly',
              windowDurationMinutes: null,
            },
          ],
        },
      ],
      createNonce(),
    );
    const text = visibleText(html);
    expect(text).toContain('5 saatlik pencere');
    expect(text).toContain('7 günlük pencere');
    expect(text).toContain('Haftalık pencere');
    expect(text).toContain('Bağlam penceresi');
    expect(text).toContain('Aylık pencere');
  });
});
