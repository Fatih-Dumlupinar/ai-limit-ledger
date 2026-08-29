import { describe, expect, it } from 'vitest';
import { LocalizationService } from '../src/localization/LocalizationService';
import { formatConfiguredTime, getUiTextCatalog } from '../src/ui/UiTextCatalog';

const NOW = Date.parse('2026-08-26T10:00:00.000Z');

describe('TASK 9.2 direction-aware timestamps', () => {
  it('formats a past provider event with an ago suffix in English', () => {
    const service = new LocalizationService('en', 'en-US');
    expect(service.formatRelativeTime(NOW - 5 * 60_000, NOW, 'past-event')).toBe('5m ago');
    service.dispose();
  });

  it('formats a future target with an in suffix in English', () => {
    const service = new LocalizationService('en', 'en-US');
    expect(service.formatRelativeTime(NOW + 60_000, NOW, 'future-target')).toBe('in 1m');
    service.dispose();
  });

  it('formats an overdue deadline as overdue by rather than a negative countdown', () => {
    const service = new LocalizationService('en', 'en-US');
    expect(service.formatRelativeTime(NOW - 5 * 60_000, NOW, 'deadline')).toBe('overdue by 5m');
    expect(service.formatRelativeTime(NOW - 5 * 60_000, NOW, 'deadline')).not.toContain('-');
    service.dispose();
  });

  it('uses Turkish sonra/gecikti semantics for future and overdue timestamps', () => {
    const service = new LocalizationService('tr', 'tr-TR');
    expect(service.formatRelativeTime(NOW + 60_000, NOW, 'future-target')).toBe('1 dk sonra');
    expect(service.formatRelativeTime(NOW - 5 * 60_000, NOW, 'deadline')).toBe('5 dk gecikti');
    service.dispose();
  });

  it('reserves az önce/just now for past events while future seconds stay directional', () => {
    const service = new LocalizationService('tr', 'tr-TR');
    expect(service.formatRelativeTime(NOW - 2_000, NOW, 'past-event')).toBe('az önce');
    expect(service.formatRelativeTime(NOW + 2_000, NOW, 'future-target')).toBe('2 sn sonra');
    expect(service.formatRelativeTime(NOW + 2_000, NOW, 'future-target')).not.toBe('az önce');
    service.dispose();
  });

  it('keeps snapshot age unsigned and combines absolute plus relative time when requested', () => {
    const catalog = getUiTextCatalog('en');
    expect(formatConfiguredTime(NOW - 5 * 60_000, NOW, 'relative', catalog, 'snapshot-age')).toBe(
      '5m',
    );
    const both = formatConfiguredTime(NOW + 60_000, NOW, 'both', catalog, 'future-target');
    expect(both).toContain('(in 1m)');
    expect(both).not.toContain('ago');
  });
});
