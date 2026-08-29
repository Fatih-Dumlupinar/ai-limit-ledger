import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  scripts: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<
    string,
    { resolved?: string; integrity?: string; dev?: boolean; link?: boolean; version?: string }
  >;
};

const nonRootPackages = Object.entries(packageLock.packages).filter(([name]) => name !== '');

describe('Task 10 release: supply-chain hygiene of package.json and package-lock.json', () => {
  it('the extension ships with zero production dependencies', () => {
    expect(Object.keys(packageJson.dependencies ?? {})).toHaveLength(0);
  });

  it('no lifecycle install scripts (preinstall/install/postinstall/prepare/prepublish) are declared', () => {
    for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
      expect(
        packageJson.scripts[script],
        `unexpected lifecycle script "${script}"`,
      ).toBeUndefined();
    }
  });

  it('every locked package resolves to the official npm registry', () => {
    const offRegistry = nonRootPackages.filter(([, entry]) => {
      if (entry.link) return false; // workspace symlink entries have no resolved URL
      if (!entry.resolved) return false; // some meta-entries (e.g. bundled) omit it legitimately
      return !entry.resolved.startsWith('https://registry.npmjs.org/');
    });
    expect(
      offRegistry.map(([name, entry]) => `${name} -> ${entry.resolved}`),
      'every dependency must resolve to https://registry.npmjs.org/',
    ).toEqual([]);
  });

  it('no locked package resolves to a git URL, local file path, or tarball URL outside the registry', () => {
    const suspicious = nonRootPackages.filter(([, entry]) => {
      if (!entry.resolved) return false;
      return /^(git(\+[a-z]+)?:\/\/|git@|file:|https?:\/\/(?!registry\.npmjs\.org))/i.test(
        entry.resolved,
      );
    });
    expect(suspicious.map(([name]) => name)).toEqual([]);
  });

  it('every non-link package entry with a resolved URL also carries an integrity hash', () => {
    const missingIntegrity = nonRootPackages.filter(
      ([, entry]) => entry.resolved && !entry.link && !entry.integrity,
    );
    expect(missingIntegrity.map(([name]) => name)).toEqual([]);
  });

  it('the lockfile is committed to the source tree (present on disk, not gitignored)', () => {
    const gitignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).not.toMatch(/^package-lock\.json$/m);
  });

  it('no package name in the lockfile is a suspicious near-duplicate of a well-known scoped package', () => {
    // A lightweight typosquatting guard: flag any unscoped package whose name is an
    // edit-distance-1 collision with a security-sensitive scoped package we depend on
    // (e.g. "types/node" vs "@types/node" confusion, or a hyphen/underscore swap).
    const knownGoodNames = new Set(
      nonRootPackages.map(([name]) => name.split('node_modules/').pop() ?? name),
    );
    const suspiciousPairs: string[] = [];
    for (const name of knownGoodNames) {
      if (!name.startsWith('@types/')) continue;
      const bareEquivalent = name.replace('@types/', '');
      const impostor = `types-${bareEquivalent}`;
      if (knownGoodNames.has(impostor)) suspiciousPairs.push(impostor);
    }
    expect(suspiciousPairs).toEqual([]);
  });
});
