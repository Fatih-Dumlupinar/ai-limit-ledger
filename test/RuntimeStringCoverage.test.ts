import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = [
  'src/ui/DetailsView.ts',
  'src/ui/SafeDashboard.ts',
  'src/ui/StatusBarFormatter.ts',
  'src/ui/ProviderStatusBarTooltip.ts',
  'src/infrastructure/SafeErrorPresenter.ts',
];

describe('runtime string localization guardrails', () => {
  it('all primary runtime renderers import the shared catalog/service', () => {
    for (const file of files.slice(0, 4)) {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      expect(source, file).toMatch(/UiTextCatalog|LocalizationService/);
    }
  });

  it('runtime translation values are not inserted through innerHTML', () => {
    const source = files
      .map((file) => readFileSync(resolve(__dirname, '..', file), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/(?:translation|localization)[\s\S]{0,80}innerHTML/i);
  });

  it('Rich and Safe surfaces expose one render-only language boundary', () => {
    const rich = readFileSync(resolve(__dirname, '../src/ui/DetailsView.ts'), 'utf8');
    const safe = readFileSync(resolve(__dirname, '../src/ui/SafeDashboard.ts'), 'utf8');
    expect(rich).toContain('getUiTextCatalog');
    expect(safe).toContain('getUiTextCatalog');
    expect(safe).toContain('changeEmitter.fire(SAFE_DASHBOARD_URI)');
  });

  it('stable identifiers remain outside translation catalogs', () => {
    const keys = readFileSync(
      resolve(__dirname, '../src/localization/LocalizationKeys.ts'),
      'utf8',
    );
    expect(keys).not.toContain('codex-provider-id');
    expect(keys).not.toContain('api.anthropic.com');
    expect(keys).toContain("'sourceUnavailable'");
  });

  it('provider names and raw provider values are passed as dynamic data', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/SafeDashboard.ts'), 'utf8');
    expect(source).toContain('model.displayName');
    expect(source).toContain('model.plan');
    expect(source).toContain('model.cliVersion');
  });
});
