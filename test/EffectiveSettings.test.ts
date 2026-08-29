import { describe, expect, it } from 'vitest';
import {
  isCacheExpired,
  normalizeSettings,
  redactEffectiveSettings,
} from '../src/configuration/EffectiveSettings';
import { SETTING_KEYS } from '../src/configuration/SettingsKeys';

describe('effective settings normalization', () => {
  it('uses safe defaults for an empty settings object', () => {
    const settings = normalizeSettings();
    expect(settings.display.language).toBe('auto');
    expect(settings.display.timeFormat).toBe('both');
    expect(settings.providers).toEqual(['codex', 'claude', 'copilot', 'grok']);
  });

  it('accepts only the supported language values', () => {
    expect(normalizeSettings({ [SETTING_KEYS.displayLanguage]: 'tr' }).display.language).toBe('tr');
    expect(normalizeSettings({ [SETTING_KEYS.displayLanguage]: 'en' }).display.language).toBe('en');
    expect(normalizeSettings({ [SETTING_KEYS.displayLanguage]: 'de' }).display.language).toBe(
      'auto',
    );
  });

  it('records invalid language values without retaining their raw value', () => {
    const settings = normalizeSettings({ [SETTING_KEYS.displayLanguage]: 'secret-token' });
    expect(settings.diagnostics).toContainEqual({ code: 'invalid-enum', key: 'display.language' });
    expect(JSON.stringify(settings.diagnostics)).not.toContain('secret-token');
  });

  it('deduplicates provider aliases and drops unknown providers', () => {
    const settings = normalizeSettings({
      providers: ['github-copilot', 'copilot', 'unknown', 'codex'],
    });
    expect(settings.providers).toContain('copilot');
    expect(settings.providers).toContain('codex');
    expect(settings.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['duplicate-provider', 'unknown-provider']),
    );
  });

  it('bounds refresh values and retains a safe threshold order', () => {
    const settings = normalizeSettings({
      [SETTING_KEYS.codexFallbackRefreshSeconds]: 1,
      [SETTING_KEYS.warningRemainingPercent]: 90,
      [SETTING_KEYS.criticalRemainingPercent]: 95,
    });
    expect(settings.refresh.codexFallbackSeconds).toBe(30);
    expect(settings.thresholds).toEqual({
      warningRemainingPercent: 30,
      criticalRemainingPercent: 10,
    });
    expect(settings.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['below-minimum', 'invalid-threshold-order']),
    );
  });

  it('redacts configured executable paths to state labels', () => {
    const settings = normalizeSettings({
      [SETTING_KEYS.codexExecutablePath]: 'C:\\secret\\codex.exe',
    });
    const redacted = redactEffectiveSettings(settings);
    expect(redacted.executables).toEqual({ codex: 'configured', copilot: 'auto', grok: 'auto' });
    expect(JSON.stringify(redacted)).not.toContain('codex.exe');
  });

  it('expires only invalid or older-than-policy cache timestamps', () => {
    const now = 10_000_000;
    expect(isCacheExpired(now - 23 * 3_600_000, now, 24)).toBe(false);
    expect(isCacheExpired(now - 25 * 3_600_000, now, 24)).toBe(true);
    expect(isCacheExpired(undefined, now, 24)).toBe(true);
  });

  it('normalizes machine executable auto values without accepting workspace-only semantics', () => {
    const settings = normalizeSettings({ [SETTING_KEYS.grokExecutablePath]: '  auto  ' });
    expect(settings.executables.grok).toBe('auto');
  });
});
