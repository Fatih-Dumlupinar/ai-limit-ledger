import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, settingDefinition } from '../src/configuration/SettingsSchema';
import { SETTING_KEYS } from '../src/configuration/SettingsKeys';

describe('typed settings schema', () => {
  it('contains one definition per canonical key', () => {
    const keys = SETTINGS_SCHEMA.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(settingDefinition(SETTING_KEYS.displayLanguage)?.key).toBe('display.language');
  });

  it('defines display.language as a live window-scoped enum', () => {
    const language = settingDefinition(SETTING_KEYS.displayLanguage);
    expect(language).toMatchObject({
      type: 'string',
      default: 'auto',
      scope: 'window',
      live: true,
    });
    expect(language?.enum).toEqual(['auto', 'en', 'tr']);
    expect(language?.requiresProviderDetection).toBe(false);
    expect(language?.requiresTimerReschedule).toBe(false);
  });

  it('defines time format alongside language with all supported modes', () => {
    expect(settingDefinition(SETTING_KEYS.displayTimeFormat)?.enum).toEqual([
      'locale',
      'relative',
      'absolute',
      'both',
    ]);
  });

  it('marks executable paths sensitive and machine-scoped', () => {
    for (const key of [
      SETTING_KEYS.codexExecutablePath,
      SETTING_KEYS.copilotExecutablePath,
      SETTING_KEYS.grokExecutablePath,
    ]) {
      expect(settingDefinition(key)).toMatchObject({ sensitive: true, scope: 'machine' });
    }
  });

  it('keeps provider selection and order arrays unique', () => {
    expect(settingDefinition(SETTING_KEYS.providers)?.uniqueItems).toBe(true);
    expect(settingDefinition(SETTING_KEYS.dashboardProviderOrder)?.uniqueItems).toBe(true);
    expect(settingDefinition(SETTING_KEYS.statusBarProviderOrder)?.uniqueItems).toBe(true);
  });

  it('keeps legacy aliases registered for migration without making them runtime settings', () => {
    const legacy = SETTINGS_SCHEMA.filter((entry) => entry.legacy);
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.some((entry) => entry.migrationAliases.length > 0)).toBe(true);
  });
});
