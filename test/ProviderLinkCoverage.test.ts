import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('provider link source coverage', () => {
  it('keeps provider product/documentation URLs in ProviderLinkRegistry only', () => {
    const srcRoot = join(process.cwd(), 'src');
    const providerHostUrl =
      /https:\/\/(?:chatgpt\.com|learn\.chatgpt\.com|claude\.ai|code\.claude\.com|github\.com|docs\.github\.com|marketplace\.visualstudio\.com|docs\.x\.ai|grok\.com)\b/gi;
    const offenders = sourceFiles(srcRoot)
      .filter(
        (path) =>
          !path.endsWith('src\\links\\ProviderLinkRegistry.ts') &&
          !path.endsWith('src/links/ProviderLinkRegistry.ts'),
      )
      .flatMap((path) => {
        const matches = readFileSync(path, 'utf8').match(providerHostUrl) ?? [];
        return matches.map((match) => `${relative(process.cwd(), path)}:${match}`);
      });

    expect(offenders).toEqual([]);
  });
});
