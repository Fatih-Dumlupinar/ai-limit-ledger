import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VSIX_DENYLIST_PATTERNS,
  VSIX_REQUIRED_ENTRIES,
  PUBLISH_INVOCATION_PATTERN,
  EXPECTED_EXTENSION_ID,
  EXPECTED_MARKETPLACE_PUBLISHER,
  EXPECTED_PACKAGE_NAME,
  readZipEntries,
  readZipEntryContent,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const ROOT = resolve(__dirname, '..');
const denied = (name: string) => (VSIX_DENYLIST_PATTERNS as RegExp[]).some((p) => p.test(name));

describe('Task 13: VSIX denylist covers new Marketplace-prep paths', () => {
  it.each([
    'extension/test/Foo.test.ts',
    'extension/test/fixtures/sample.json',
    'extension/.github/workflows/ci.yml',
    'extension/.github/dependabot.yml',
    'extension/assets/marketplace/dashboard-dark-en.png',
    'extension/docs/MARKETPLACE-LISTING.md',
    'extension/docs/MARKETPLACE-ASSET-INVENTORY.md',
    'extension/docs/MARKETPLACE-PREFLIGHT.md',
    'extension/docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md',
    'extension/.claude/scheduled_tasks.lock', // Task 13.1: found actually leaking into a real VSIX
    'extension/.claude/settings.local.json',
  ])('flags %s as denylisted', (name) => {
    expect(denied(name)).toBe(true);
  });

  it.each([
    'extension/out/extension.js',
    'extension/package.json',
    'extension/readme.md',
    'extension/assets/icon.png',
    'extension/docs/SETTINGS.md',
    'extension/docs/PROVIDER_CAPABILITY_MATRIX.md',
  ])('does not flag runtime/required-doc path %s', (name) => {
    expect(denied(name)).toBe(false);
  });

  it('the "MARKETPLACE-" docs prefix pattern does not accidentally deny unrelated docs starting with a similar name', () => {
    expect(denied('extension/docs/MARKETPLACE_CAPABILITY_MATRIX.md')).toBe(false);
  });
});

describe('Task 13: no vsce/ovsx publish invocation anywhere in the source tree', () => {
  it.each([
    'vsce publish',
    'vsce  publish', // extra internal whitespace
    'vsce publish --pat $TOKEN',
    'vsce.publish()',
    'vsce.publish( )',
    'ovsx publish',
  ])('flags "%s" as a publish invocation', (line) => {
    expect(PUBLISH_INVOCATION_PATTERN.test(line)).toBe(true);
  });

  it.each(['vsce package', 'npm run package', 'vsce ls', 'publish the README to the wiki'])(
    'does not flag ordinary text "%s"',
    (line) => {
      expect(PUBLISH_INVOCATION_PATTERN.test(line)).toBe(false);
    },
  );

  it('package.json has no script invoking a Marketplace publish command', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(PUBLISH_INVOCATION_PATTERN.test(cmd), `script "${name}" invokes publish`).toBe(false);
    }
  });

  it('no GitHub Actions workflow invokes a Marketplace publish command', () => {
    const workflowDir = resolve(ROOT, '.github/workflows');
    const files = readdirSync(workflowDir);
    for (const file of files) {
      const content = readFileSync(resolve(workflowDir, file), 'utf8');
      expect(PUBLISH_INVOCATION_PATTERN.test(content), `${file} invokes publish`).toBe(false);
    }
  });
});

describe('Task 13: .vscodeignore excludes Marketplace-prep-only content from the package', () => {
  const vscodeignore = readFileSync(resolve(ROOT, '.vscodeignore'), 'utf8');

  it('excludes the new Marketplace documentation files', () => {
    for (const doc of [
      'docs/MARKETPLACE-LISTING.md',
      'docs/MARKETPLACE-ASSET-INVENTORY.md',
      'docs/MARKETPLACE-PREFLIGHT.md',
      'docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md',
    ]) {
      expect(vscodeignore).toContain(doc);
    }
  });

  it('excludes the Marketplace screenshot directory', () => {
    expect(vscodeignore).toMatch(/assets\/marketplace\/\*\*/);
  });

  it('still excludes test/, scripts/, and .github/ (pre-existing Task 10/12 policy, unchanged)', () => {
    expect(vscodeignore).toMatch(/^test\/\*\*$/m);
    expect(vscodeignore).toMatch(/^scripts\/\*\*$/m);
    expect(vscodeignore).toMatch(/^\.github\/\*\*$/m);
  });

  it('excludes .claude/ (editor/agent-tooling scratch state, found leaking into a real VSIX)', () => {
    expect(vscodeignore).toMatch(/^\.claude\/\*\*$/m);
  });
});

describe('Task 13: if a current-version VSIX has been built, it reflects the new identity', () => {
  // Follows the same "skip gracefully if not built yet" convention as
  // test/ReleaseAuditNotPackaged.test.ts — the three required `npm test` runs in this task's
  // validation chain all happen before `npm run package`, so this normally skips; it becomes a
  // real assertion once the VSIX exists (see the PR's own VSIX audit for the authoritative run).
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  const vsixPath = resolve(ROOT, `ai-limit-ledger-${pkg.version}.vsix`);

  it('packaged manifest publisher/name/id match the expected Marketplace identity', () => {
    if (!existsSync(vsixPath)) {
      expect(existsSync(vsixPath)).toBe(false);
      return;
    }
    const buffer = readFileSync(vsixPath);
    const entries = readZipEntries(buffer);
    const pkgEntry = entries.find(
      (e: { fileName: string }) => e.fileName === 'extension/package.json',
    );
    expect(pkgEntry).toBeDefined();
    const packaged = JSON.parse(readZipEntryContent(buffer, pkgEntry).toString('utf8'));
    expect(packaged.publisher).toBe(EXPECTED_MARKETPLACE_PUBLISHER);
    expect(packaged.name).toBe(EXPECTED_PACKAGE_NAME);
    expect(`${packaged.publisher}.${packaged.name}`).toBe(EXPECTED_EXTENSION_ID);
  });

  it('packaged VSIX does not include scripts/, test/, .github/, .claude/, or assets/marketplace/', () => {
    if (!existsSync(vsixPath)) {
      expect(existsSync(vsixPath)).toBe(false);
      return;
    }
    const buffer = readFileSync(vsixPath);
    const entries = readZipEntries(buffer) as Array<{ fileName: string }>;
    const forbidden = entries.filter(
      (e) =>
        e.fileName.startsWith('extension/scripts/') ||
        e.fileName.startsWith('extension/test/') ||
        e.fileName.startsWith('extension/.github/') ||
        e.fileName.startsWith('extension/.claude/') ||
        e.fileName.startsWith('extension/assets/marketplace/'),
    );
    expect(forbidden.map((e) => e.fileName)).toEqual([]);
  });

  it('packaged README, icon, runtime bundle, and localization catalogs are present', () => {
    if (!existsSync(vsixPath)) {
      expect(existsSync(vsixPath)).toBe(false);
      return;
    }
    const buffer = readFileSync(vsixPath);
    const entries = readZipEntries(buffer) as Array<{ fileName: string }>;
    const names = new Set(entries.map((e) => e.fileName.toLowerCase()));
    for (const required of VSIX_REQUIRED_ENTRIES as string[]) {
      expect(names.has(required.toLowerCase()), `missing ${required}`).toBe(true);
    }
    expect(names.has('extension/assets/icon.png')).toBe(true);
  });
});
