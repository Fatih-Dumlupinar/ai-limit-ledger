import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VSIX_DENYLIST_PATTERNS,
  VSIX_REQUIRED_ENTRIES,
  readZipEntries,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const ROOT = resolve(__dirname, '..');

describe('Task 10.1: release-audit tooling stays a dev-only tool, never a packaged one', () => {
  it('scripts/release-audit.mjs exists in the source tree', () => {
    expect(existsSync(resolve(ROOT, 'scripts/release-audit.mjs'))).toBe(true);
  });

  it('.vscodeignore excludes the entire scripts/ directory from the VSIX', () => {
    const vscodeignore = readFileSync(resolve(ROOT, '.vscodeignore'), 'utf8');
    expect(vscodeignore).toMatch(/^scripts\/\*\*$/m);
  });

  it('the VSIX denylist explicitly flags a packaged release-audit script, not just relies on it being absent', () => {
    const denied = (name: string) => VSIX_DENYLIST_PATTERNS.some((p: RegExp) => p.test(name));
    expect(denied('extension/scripts/release-audit.mjs')).toBe(true);
    expect(denied('extension/scripts/anything-else.mjs')).toBe(true);
  });

  it('the VSIX denylist also flags packaged .nvmrc/.node-version (development-only files)', () => {
    const denied = (name: string) => VSIX_DENYLIST_PATTERNS.some((p: RegExp) => p.test(name));
    expect(denied('extension/.nvmrc')).toBe(true);
    expect(denied('extension/.node-version')).toBe(true);
  });

  it('runtime entrypoint requirements do not include the release-audit script or Node policy files', () => {
    const requiresDevTooling = VSIX_REQUIRED_ENTRIES.some((entry: string) =>
      /scripts\/|\.nvmrc|\.node-version/.test(entry),
    );
    expect(requiresDevTooling).toBe(false);
  });

  it('required runtime entrypoints (out/extension.js, manifest, NLS catalogs) are still required regardless of the scripts/ exclusion', () => {
    expect(VSIX_REQUIRED_ENTRIES).toContain('extension/out/extension.js');
    expect(VSIX_REQUIRED_ENTRIES).toContain('extension/package.json');
    expect(VSIX_REQUIRED_ENTRIES).toContain('extension/package.nls.json');
    expect(VSIX_REQUIRED_ENTRIES).toContain('extension/package.nls.tr.json');
  });

  it('if a built VSIX is present in the repo root, it genuinely does not contain scripts/release-audit.mjs', () => {
    const vsixFiles = readdirSync(ROOT).filter((f) => f.endsWith('.vsix'));
    if (vsixFiles.length === 0) {
      // No VSIX built yet in this test run (e.g. before `npm run package`) — nothing to check.
      expect(vsixFiles).toEqual([]);
      return;
    }
    for (const file of vsixFiles) {
      const buffer = readFileSync(resolve(ROOT, file));
      const entries = readZipEntries(buffer);
      const scriptEntries = entries.filter((e: { fileName: string }) =>
        e.fileName.startsWith('extension/scripts/'),
      );
      expect(scriptEntries, `${file} unexpectedly packages scripts/`).toEqual([]);
    }
  });
});
