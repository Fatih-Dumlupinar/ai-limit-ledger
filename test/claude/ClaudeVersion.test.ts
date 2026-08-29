import { describe, expect, it } from 'vitest';
import { compareVersions, isVersionAtLeast } from '../../src/providers/claude/ClaudeVersion';

describe('ClaudeVersion', () => {
  it('compares numeric triplets', () => {
    expect(compareVersions('2.1.80', '2.1.80')).toBe(0);
    expect(compareVersions('2.1.81', '2.1.80')).toBeGreaterThan(0);
    expect(compareVersions('2.0.99', '2.1.80')).toBeLessThan(0);
    expect(compareVersions('2.1.241', '2.1.80')).toBeGreaterThan(0);
  });

  it('returns null for unparseable versions instead of guessing', () => {
    expect(isVersionAtLeast(null, '2.1.80')).toBeNull();
    expect(isVersionAtLeast(undefined, '2.1.80')).toBeNull();
    expect(isVersionAtLeast('nightly', '2.1.80')).toBeNull();
  });

  it('reports compatibility against the documented statusline contract floor', () => {
    expect(isVersionAtLeast('2.1.241', '2.1.80')).toBe(true);
    expect(isVersionAtLeast('1.9.0', '2.1.80')).toBe(false);
  });
});
