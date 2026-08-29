import { describe, expect, it } from 'vitest';
import { createNonce, renderDashboard, setDashboardRenderSettings } from '../src/ui/DetailsView';
import {
  DASHBOARD_ICON_IDS,
  DASHBOARD_ICON_REGISTRY,
  renderDashboardIcon,
} from '../src/ui/DashboardIcons';
import type { DashboardActionState } from '../src/ui/DashboardActionRunner';
import { task92Snapshots } from './task92Fixtures';

describe('TASK 9.2 typed SVG icon visibility', () => {
  it('keeps every registry icon static, hidden from assistive technology, and non-focusable', () => {
    for (const iconId of DASHBOARD_ICON_IDS) {
      const icon = renderDashboardIcon(iconId);
      expect(icon).toContain(DASHBOARD_ICON_REGISTRY[iconId]);
      expect(icon).toMatch(/^<svg\b/);
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('focusable="false"');
      expect(icon).toContain('viewBox="0 0 16 16"');
      expect(icon).not.toContain('<script');
      expect(icon).not.toMatch(/\bon[a-z]+=/i);
    }
  });

  it('rejects unknown icon IDs without serializing arbitrary markup', () => {
    expect(renderDashboardIcon('svg' as never)).toBe('');
    expect(renderDashboardIcon('unknown' as never)).toBe('');
  });

  it('retains the leading icon slot through idle, working, success, error, and throttled states', () => {
    setDashboardRenderSettings({ language: 'tr' });
    const states: DashboardActionState['state'][] = [
      'idle',
      'working',
      'success',
      'error',
      'throttled',
    ];
    for (const state of states) {
      const actionState =
        state === 'idle'
          ? []
          : [
              {
                actionId: 'refresh-codex' as const,
                requestId: `request-${state}`,
                correlationId: `correlation-${state}`,
                state,
                message: state,
                retryable: true,
              },
            ];
      const html = renderDashboard(task92Snapshots(), createNonce(), actionState);
      const button =
        /<button[^>]+data-action-id="refresh-codex"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
      expect(button).toContain('class="action-button__leading-icon"');
      expect(button).toContain('<svg');
      expect(button).not.toContain('&lt;svg');
      expect(button).not.toContain('>svg<');
      expect(button).not.toContain('innerHTML');
      if (state !== 'idle') expect(button).toContain(`data-request-id="request-${state}"`);
    }
  });

  it('does not create a second SVG when an action enters a result state', () => {
    const html = renderDashboard(task92Snapshots(), createNonce(), [
      {
        actionId: 'refresh-codex',
        requestId: 'request-success',
        correlationId: 'correlation-success',
        state: 'success',
        message: 'Updated',
        retryable: false,
      },
    ]);
    const button =
      /<button[^>]+data-action-id="refresh-codex"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    expect((button.match(/<svg\b/g) ?? []).length).toBe(5);
    expect(button).toContain('data-state-icon="success"');
    expect(button).toContain('hidden');
  });

  it('keeps icon markup outside the translation replacement chain', () => {
    setDashboardRenderSettings({ language: 'tr' });
    const html = renderDashboard(task92Snapshots(), createNonce());
    expect(html).not.toContain('&lt;svg');
    expect(html).not.toContain('&gt;svg');
    expect(html).not.toContain('<title>');
    expect(html).toContain('aria-hidden="true"');
  });

  it('uses only allowlisted action icon names in rendered buttons', () => {
    const html = renderDashboard(task92Snapshots(), createNonce());
    const ids = [...html.matchAll(/data-action-icon="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids)
      expect(DASHBOARD_ICON_IDS).toContain(id as (typeof DASHBOARD_ICON_IDS)[number]);
  });
});
