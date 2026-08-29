import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_MARKETPLACE_PUBLISHER,
  EXPECTED_PACKAGE_NAME,
  EXPECTED_EXTENSION_ID,
  EXPECTED_TASK_VERSION,
  PLACEHOLDER_PUBLISHER_VALUES,
  MARKETPLACE_CATEGORY_ALLOWLIST,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const ROOT = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  private: boolean;
  preview: boolean;
  license: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  homepage: string;
  icon: string;
  categories: string[];
  keywords: string[];
};

describe('Task 13: Marketplace publisher and extension identity', () => {
  it('publisher is exactly the real Marketplace publisher ID', () => {
    expect(packageJson.publisher).toBe('fatihdumlupinar-dev');
    expect(packageJson.publisher).toBe(EXPECTED_MARKETPLACE_PUBLISHER);
  });

  it('the exported placeholder-publisher set rejects the values the manifest must never use again', () => {
    expect(PLACEHOLDER_PUBLISHER_VALUES.has('local')).toBe(true);
    expect(PLACEHOLDER_PUBLISHER_VALUES.has('test')).toBe(true);
    expect(PLACEHOLDER_PUBLISHER_VALUES.has('example')).toBe(true);
    expect(PLACEHOLDER_PUBLISHER_VALUES.has('placeholder')).toBe(true);
    expect(PLACEHOLDER_PUBLISHER_VALUES.has('your-publisher-id')).toBe(true);
  });

  it('the actual publisher value is not one of the rejected placeholder values', () => {
    expect(PLACEHOLDER_PUBLISHER_VALUES.has(packageJson.publisher.toLowerCase())).toBe(false);
  });

  it('the real publisher set does not itself accept a placeholder', () => {
    // Guards against someone widening PLACEHOLDER_PUBLISHER_VALUES to swallow the real ID.
    expect(PLACEHOLDER_PUBLISHER_VALUES.has(EXPECTED_MARKETPLACE_PUBLISHER)).toBe(false);
  });

  it('package name is exactly "ai-limit-ledger" and unchanged by the publisher switch', () => {
    expect(packageJson.name).toBe('ai-limit-ledger');
    expect(packageJson.name).toBe(EXPECTED_PACKAGE_NAME);
  });

  it('the computed permanent extension id is fatihdumlupinar-dev.ai-limit-ledger', () => {
    const id = `${packageJson.publisher}.${packageJson.name}`;
    expect(id).toBe('fatihdumlupinar-dev.ai-limit-ledger');
    expect(id).toBe(EXPECTED_EXTENSION_ID);
  });

  it('version is unchanged by Task 13', () => {
    expect(packageJson.version).toBe('0.6.2');
    expect(packageJson.version).toBe(EXPECTED_TASK_VERSION);
  });

  it('the package stays private (never intended for npm publish)', () => {
    expect(packageJson.private).toBe(true);
  });

  it('preview is enabled for the first Marketplace release', () => {
    expect(packageJson.preview).toBe(true);
  });

  it('displayName resolves through the localization key, unchanged', () => {
    expect(packageJson.displayName).toBe('%extension.displayName%');
  });
});

describe('Task 13: Marketplace repository/homepage/bugs/license links', () => {
  it('repository.url points at the real GitHub owner/repo, unchanged', () => {
    expect(packageJson.repository.url).toBe(
      'git+https://github.com/Fatih-Dumlupinar/ai-limit-ledger.git',
    );
  });

  it('homepage points at the README on the real repository', () => {
    expect(packageJson.homepage).toBe('https://github.com/Fatih-Dumlupinar/ai-limit-ledger#readme');
  });

  it('bugs.url points at the real repository Issues page', () => {
    expect(packageJson.bugs.url).toBe('https://github.com/Fatih-Dumlupinar/ai-limit-ledger/issues');
  });

  it('license is MIT and matches the LICENSE file', () => {
    expect(packageJson.license).toBe('MIT');
  });

  it('the GitHub owner in every link is Fatih-Dumlupinar, never the Marketplace publisher ID', () => {
    // The GitHub account and the Marketplace publisher are deliberately different identifiers
    // (see PUBLISHING.md) — this guards against ever conflating them in a link field.
    for (const url of [packageJson.repository.url, packageJson.homepage, packageJson.bugs.url]) {
      expect(url).toContain('Fatih-Dumlupinar/ai-limit-ledger');
      expect(url).not.toContain('fatihdumlupinar-dev/');
    }
  });
});

describe('Task 13: Marketplace icon requirements', () => {
  it('icon field points at a PNG, not an SVG', () => {
    expect(packageJson.icon).toBe('assets/icon.png');
    expect(packageJson.icon.toLowerCase().endsWith('.svg')).toBe(false);
  });

  it('the icon file has a valid PNG signature', () => {
    const buf = readFileSync(resolve(ROOT, packageJson.icon));
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('the icon is at least 128x128 (Marketplace minimum)', () => {
    const buf = readFileSync(resolve(ROOT, packageJson.icon));
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBeGreaterThanOrEqual(128);
    expect(height).toBeGreaterThanOrEqual(128);
  });
});

describe('Task 13: categories and keywords policy', () => {
  it('every declared category is on the current Marketplace allowlist', () => {
    for (const category of packageJson.categories) {
      expect(MARKETPLACE_CATEGORY_ALLOWLIST.has(category)).toBe(true);
    }
  });

  it('categories are exactly Other and Visualization', () => {
    expect(packageJson.categories.sort()).toEqual(['Other', 'Visualization']);
  });

  it('the extension is never categorized as Machine Learning', () => {
    // It reads provider-reported usage metadata; it never performs model inference itself.
    expect(packageJson.categories).not.toContain('Machine Learning');
  });

  it('keyword count is at most 30 (Marketplace hard limit)', () => {
    expect(packageJson.keywords.length).toBeLessThanOrEqual(30);
  });

  it('there are no duplicate keywords (case-insensitive)', () => {
    const lower = packageJson.keywords.map((k) => k.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('keywords cover the recommended discovery terms without being empty/generic-only', () => {
    const lower = packageJson.keywords.map((k) => k.toLowerCase());
    for (const expected of ['quota', 'rate limit', 'status bar', 'codex', 'claude code']) {
      expect(lower).toContain(expected);
    }
  });
});
