import { describe, expect, it } from 'vitest';
import {
  LocalizationService,
  resolveRuntimeLanguage,
} from '../src/localization/LocalizationService';

describe('LocalizationService', () => {
  it.each(['tr', 'tr-TR', 'tr_TR', 'TR-tr', 'tr_tr'])(
    'resolves auto locale %s to Turkish',
    (locale) => {
      expect(resolveRuntimeLanguage('auto', locale)).toBe('tr');
    },
  );

  it.each(['en', 'en-US', 'de', 'fr', '', 'not-a-locale'])(
    'falls back unsupported auto locale %s to English',
    (locale) => {
      expect(resolveRuntimeLanguage('auto', locale)).toBe('en');
    },
  );

  it('explicit language wins over the VS Code language', () => {
    expect(resolveRuntimeLanguage('tr', 'en-US')).toBe('tr');
    expect(resolveRuntimeLanguage('en', 'tr-TR')).toBe('en');
  });

  it('provides typed translations and never exposes a raw missing key', () => {
    const service = new LocalizationService('tr', 'en-US');
    expect(service.language).toBe('tr');
    expect(service.t('refresh')).toBe('Yenile');
    expect(service.t('diagnosticsWritten', { provider: 'Codex\nsecret' })).toContain(
      'Codex secret',
    );
    expect(service.t('diagnosticsWritten', { provider: 'Codex\nsecret' })).not.toContain('\n');
    expect(service.t('refresh')).not.toBe('refresh');
    service.dispose();
  });

  it('emits one event only when the resolved runtime language changes', () => {
    const service = new LocalizationService('auto', 'en-US');
    const events: Array<{ previousLanguage: string; language: string }> = [];
    service.onDidChange((event) => events.push(event));
    expect(service.setLanguage('auto', 'en-GB')).toBe(false);
    expect(service.setLanguage('tr', 'en-GB')).toBe(true);
    expect(service.setLanguage('tr', 'tr-TR')).toBe(false);
    expect(events).toEqual([{ previousLanguage: 'en', language: 'tr', preference: 'tr' }]);
    service.dispose();
  });

  it('maps runtime languages to the documented locales', () => {
    const service = new LocalizationService('tr', 'en');
    expect(service.locale).toBe('tr-TR');
    service.setLanguage('en', 'tr-TR');
    expect(service.locale).toBe('en-US');
    service.dispose();
  });

  it('formats the required compact relative examples in both languages', () => {
    const now = Date.parse('2026-08-25T12:00:00.000Z');
    const turkish = new LocalizationService('tr', 'en');
    expect(turkish.formatRelativeTime(now - 1_000, now)).toBe('az önce');
    expect(turkish.formatRelativeTime(now - 3 * 60_000, now)).toBe('3 dk');
    expect(turkish.formatRelativeTime(now - (2 * 60 + 15) * 60_000, now)).toBe('2 sa 15 dk');
    expect(turkish.formatRelativeTime(now - (5 * 24 + 4) * 60 * 60_000, now)).toBe('5 gün 4 sa');
    turkish.setLanguage('en', 'tr-TR');
    expect(turkish.formatRelativeTime(now - 1_000, now)).toBe('just now');
    expect(turkish.formatRelativeTime(now - 3 * 60_000, now)).toBe('3m');
    expect(turkish.formatRelativeTime(now - (2 * 60 + 15) * 60_000, now)).toBe('2h 15m');
    expect(turkish.formatRelativeTime(now - (5 * 24 + 4) * 60 * 60_000, now)).toBe('5d 4h');
    turkish.dispose();
  });

  it('supports locale, relative, absolute and both date modes', () => {
    const service = new LocalizationService('tr', 'en');
    const timestamp = Date.parse('2026-08-25T12:00:00.000Z');
    const now = timestamp - 3 * 60_000;
    expect(service.formatDate(timestamp, 'relative', now)).toBe('3 dk');
    expect(service.formatDate(timestamp, 'locale', now)).not.toBe('3 dk');
    expect(service.formatDate(timestamp, 'absolute', now)).not.toBe('3 dk');
    expect(service.formatDate(timestamp, 'both', now)).toContain('3 dk');
    expect(service.formatDate(undefined)).toBe('Sağlanmadı');
    service.dispose();
  });

  it('clamps numeric percentages and returns a localized unavailable value', () => {
    const service = new LocalizationService('en', 'tr-TR');
    expect(service.formatPercent(120)).toBe('100');
    expect(service.formatPercent(-2)).toBe('0');
    expect(service.formatPercent(undefined)).toBe('Not provided');
    service.setLanguage('tr', 'en-US');
    expect(service.formatPercent(undefined)).toBe('Sağlanmadı');
    service.dispose();
  });
});
