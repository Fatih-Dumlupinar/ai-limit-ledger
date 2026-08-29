import { afterEach, describe, expect, it } from 'vitest';
import { createNonce, renderDashboard, setDashboardRenderSettings } from '../src/ui/DetailsView';
import { task92Snapshots } from './task92Fixtures';

function providerArticle(html: string, providerId: string): string {
  return (
    new RegExp(
      `<article class="(?:provider-card|setup-card)"[^>]+data-provider-id="${providerId}"[\\s\\S]*?<\\/article>`,
    ).exec(html)?.[0] ?? ''
  );
}

function badges(article: string): string[] {
  return [...article.matchAll(/data-badge="([^"]+)"/g)].map((match) => match[1]!);
}

afterEach(() => setDashboardRenderSettings({}));

describe('TASK 9.2 typed provider badges', () => {
  it('renders exactly one experimental badge for an experimental stale provider', () => {
    const article = providerArticle(renderDashboard(task92Snapshots(), createNonce()), 'claude');
    const ids = badges(article);
    expect(ids.filter((id) => id === 'experimental')).toHaveLength(1);
    expect(ids).not.toContain('official');
  });

  it('renders last-known-good separately from the status badge', () => {
    const article = providerArticle(renderDashboard(task92Snapshots(), createNonce()), 'claude');
    const ids = badges(article);
    expect(ids).toContain('status');
    expect(ids).toContain('last-known-good');
    expect(ids.indexOf('status')).toBeLessThan(ids.indexOf('last-known-good'));
  });

  it('uses a stale badge when there is stale data without a known-good timestamp', () => {
    const snapshots = task92Snapshots().map((snapshot) =>
      snapshot.providerId === 'claude'
        ? { ...snapshot, lastSuccessfulDataUpdate: undefined, lastSuccessfulUpdateAt: undefined }
        : snapshot,
    );
    const article = providerArticle(renderDashboard(snapshots, createNonce()), 'claude');
    expect(badges(article)).toContain('stale');
    expect(badges(article)).not.toContain('last-known-good');
  });

  it('never combines official and experimental source badges for one provider', () => {
    for (const providerId of ['codex', 'claude', 'copilot', 'grok']) {
      const ids = badges(
        providerArticle(renderDashboard(task92Snapshots(), createNonce()), providerId),
      );
      expect(ids.includes('official') && ids.includes('experimental')).toBe(false);
    }
  });

  it('keeps badge order deterministic across repeated renders', () => {
    const first = providerArticle(renderDashboard(task92Snapshots(), createNonce()), 'claude');
    const second = providerArticle(renderDashboard(task92Snapshots(), createNonce()), 'claude');
    expect(badges(first)).toEqual(badges(second));
  });

  it('deduplicates the semantic warning badge even when stale and warning attention overlap', () => {
    const snapshots = task92Snapshots().map((snapshot) =>
      snapshot.providerId === 'claude'
        ? { ...snapshot, lastSuccessfulDataUpdate: undefined, warning: 'raw warning' }
        : snapshot,
    );
    const ids = badges(providerArticle(renderDashboard(snapshots, createNonce()), 'claude'));
    expect(ids.filter((id) => id === 'warning')).toHaveLength(1);
    expect(ids.filter((id) => id === 'stale')).toHaveLength(1);
  });
});
