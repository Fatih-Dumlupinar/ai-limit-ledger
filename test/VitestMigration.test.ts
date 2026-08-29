import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
};

function installedVersion(pkg: string): string | undefined {
  return packageLock.packages[`node_modules/${pkg}`]?.version;
}

const PRERELEASE_PATTERN = /-(alpha|beta|rc|canary|next|dev)\b/i;

describe('Task 10.1: controlled Vitest 2 -> 4 upgrade', () => {
  it('vitest is pinned to a stable, non-prerelease 4.x line in package.json', () => {
    const range = packageJson.devDependencies.vitest;
    expect(range).toMatch(/^[\^~]?4\./);
    expect(PRERELEASE_PATTERN.test(range)).toBe(false);
  });

  it('the vulnerable Vitest 2.x major is no longer used anywhere in the lockfile', () => {
    const vitestVersion = installedVersion('vitest');
    expect(vitestVersion).toBeDefined();
    expect(vitestVersion?.startsWith('2.')).toBe(false);
    expect(vitestVersion?.startsWith('4.')).toBe(true);
  });

  it('no installed vitest-family package resolves to a beta/rc/canary prerelease', () => {
    const vitestFamily = Object.entries(packageLock.packages).filter(([name]) =>
      /node_modules\/(vitest|@vitest\/)/.test(name),
    );
    expect(vitestFamily.length).toBeGreaterThan(0);
    for (const [name, entry] of vitestFamily) {
      expect(PRERELEASE_PATTERN.test(entry.version ?? ''), `${name}@${entry.version}`).toBe(false);
    }
  });

  it('vite (pulled in transitively by vitest) resolves to a version compatible with Vitest 4 (>= 6)', () => {
    const viteVersion = installedVersion('vite');
    expect(viteVersion).toBeDefined();
    const major = Number(viteVersion?.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(6);
  });

  it('vite is still not a direct dependency of this project (only vitest depends on it)', () => {
    expect(packageJson.devDependencies.vite).toBeUndefined();
  });

  it("vite-node is gone (Vitest 4 replaced it with Vite's own Module Runner)", () => {
    expect(installedVersion('vite-node')).toBeUndefined();
  });

  it('every vitest-family lockfile entry has an integrity hash and resolves to the npm registry', () => {
    const vitestFamily = Object.entries(packageLock.packages).filter(([name]) =>
      /node_modules\/(vitest|@vitest\/|vite)$/.test(name),
    );
    for (const [name, entry] of vitestFamily) {
      expect(entry.integrity, `${name} missing integrity`).toBeDefined();
      expect(entry.resolved, `${name} missing resolved URL`).toMatch(
        /^https:\/\/registry\.npmjs\.org\//,
      );
    }
  });

  it('vitest.config.mts uses no Vitest-4-removed options (poolOptions, singleThread, singleFork, workspace)', () => {
    const config = readFileSync(resolve(ROOT, 'vitest.config.mts'), 'utf8');
    expect(config).not.toMatch(/poolOptions|singleThread|singleFork|\bworkspace\s*:/);
  });

  it('no test file relies on Vitest-4-removed coverage options (coverage.all, coverage.extensions, coverage.ignoreEmptyLines)', () => {
    const config = existsSync(resolve(ROOT, 'vitest.config.mts'))
      ? readFileSync(resolve(ROOT, 'vitest.config.mts'), 'utf8')
      : '';
    expect(config).not.toMatch(/coverage\.(all|extensions|ignoreEmptyLines)/);
  });
});
