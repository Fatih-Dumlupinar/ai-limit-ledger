import { describe, expect, it } from 'vitest';
import { diagnostic, SettingsDiagnostics } from '../src/configuration/SettingsDiagnostics';
import { normalizeSettings, redactEffectiveSettings } from '../src/configuration/EffectiveSettings';

describe('settings diagnostics', () => {
  it('deduplicates equivalent safe diagnostic entries', () => {
    const diagnostics = new SettingsDiagnostics();
    diagnostics.add(diagnostic('invalid-type', 'display.language'));
    diagnostics.add(diagnostic('invalid-type', 'display.language'));
    diagnostics.addAll([diagnostic('invalid-enum', 'display.timeFormat')]);
    expect(diagnostics.size).toBe(2);
    expect(diagnostics.toArray()).toEqual([
      { code: 'invalid-type', key: 'display.language' },
      { code: 'invalid-enum', key: 'display.timeFormat' },
    ]);
  });

  it('never retains invalid raw values in normalized diagnostics', () => {
    const settings = normalizeSettings({ 'display.language': 'Bearer secret-token' });
    expect(JSON.stringify(settings.diagnostics)).not.toContain('secret-token');
    expect(settings.diagnostics[0]?.code).toBe('invalid-enum');
  });

  it('redacted settings preserve categories but hide configured paths', () => {
    const settings = normalizeSettings({ codexExecutablePath: 'C:\\Users\\person\\codex.exe' });
    const redacted = redactEffectiveSettings(settings);
    expect(redacted.executables).toEqual({ codex: 'configured', copilot: 'auto', grok: 'auto' });
    expect(redacted.diagnostics).toEqual([]);
  });

  it('records bounded category/key data for invalid values', () => {
    const settings = normalizeSettings({
      providers: ['unknown-provider'],
      'thresholds.warningRemainingPercent': 'huge',
    });
    for (const entry of settings.diagnostics) {
      expect(entry.code.length).toBeLessThan(40);
      expect(entry.key?.length ?? 0).toBeLessThan(100);
      expect(entry.detail).toBeUndefined();
    }
  });
});
