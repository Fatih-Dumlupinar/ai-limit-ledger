import { describe, expect, it } from 'vitest';
import { LOCALIZATION_KEYS } from '../src/localization/LocalizationKeys';
import { EN } from '../src/localization/locales/en';
import { TR } from '../src/localization/locales/tr';

describe('localization catalog coverage', () => {
  it('has a unique typed key list', () => {
    expect(new Set(LOCALIZATION_KEYS).size).toBe(LOCALIZATION_KEYS.length);
  });

  it('keeps English and Turkish key sets exactly equal', () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(TR).sort());
    expect(Object.keys(EN).sort()).toEqual([...LOCALIZATION_KEYS].sort());
  });

  it('contains no empty translation values', () => {
    for (const key of LOCALIZATION_KEYS) {
      expect(EN[key].trim(), `empty English translation: ${key}`).not.toBe('');
      expect(TR[key].trim(), `empty Turkish translation: ${key}`).not.toBe('');
    }
  });

  it('keeps interpolation placeholders aligned between locales', () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
    for (const key of LOCALIZATION_KEYS)
      expect(placeholders(TR[key]), `placeholder mismatch: ${key}`).toEqual(placeholders(EN[key]));
  });

  it('does not use HTML or raw key fallback text in translations', () => {
    for (const key of LOCALIZATION_KEYS) {
      expect(`${EN[key]} ${TR[key]}`).not.toMatch(/<\/?(?:script|style|iframe|img)\b/i);
    }
    expect(EN.refresh).not.toBe('refresh');
    expect(TR.refresh).not.toBe('refresh');
  });
});
