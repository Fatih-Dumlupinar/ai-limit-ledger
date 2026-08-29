import { describe, expect, it } from 'vitest';
import { SettingsService, type ConfigurationLike } from '../src/configuration/SettingsService';

function configuration(values: Record<string, unknown>): ConfigurationLike {
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (values[key] as T | undefined) ?? (defaultValue as T);
    },
    inspect<T>(key: string) {
      return values[key] === undefined ? undefined : { globalValue: values[key] as T };
    },
  };
}

describe('SettingsService language reconciliation', () => {
  it('normalizes the initial display.language value through the typed settings snapshot', () => {
    const service = new SettingsService({
      configuration: configuration({ 'display.language': 'tr' }),
    });
    expect(service.settings.display.language).toBe('tr');
    service.dispose();
  });

  it('reports display.language as a display-category change with previous settings', () => {
    const values: Record<string, unknown> = { 'display.language': 'en' };
    const service = new SettingsService({ configuration: configuration(values), debounceMs: 0 });
    const events: Array<Parameters<SettingsService['onDidChange']>[0]> = [];
    service.onDidChange((event) => events.push(event));
    values['display.language'] = 'tr';
    service.handleConfigurationChange({
      affectsConfiguration: (key) => key === 'aiLimitLedger.display.language',
    });
    service.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.changedKeys).toContain('display.language');
    expect(events[0]?.categories).toContain('display');
    expect(events[0]?.previousSettings.display.language).toBe('en');
    expect(events[0]?.settings.display.language).toBe('tr');
    expect(events[0]?.languageChanged).toBe(true);
    expect(events[0]?.requiresProviderReconcile).toBe(false);
    service.dispose();
  });

  it('does not mark an unchanged language as a language transition', () => {
    const values: Record<string, unknown> = { 'display.language': 'tr' };
    const service = new SettingsService({ configuration: configuration(values) });
    let languageChanged = true;
    service.onDidChange((event) => (languageChanged = event.languageChanged));
    service.handleConfigurationChange({ affectsConfiguration: () => true });
    service.flush();
    expect(languageChanged).toBe(false);
    service.dispose();
  });

  it('ignores unknown configuration changes without emitting a phantom event', () => {
    const service = new SettingsService({ configuration: configuration({}), debounceMs: 0 });
    let calls = 0;
    service.onDidChange(() => calls++);
    service.handleConfigurationChange({ affectsConfiguration: () => false });
    service.flush();
    expect(calls).toBe(0);
    service.dispose();
  });
});
