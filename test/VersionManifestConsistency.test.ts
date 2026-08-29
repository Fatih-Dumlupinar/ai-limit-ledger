import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  version: string;
  engines: { vscode: string };
  scripts: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8')) as {
  version: string;
  lockfileVersion: number;
  packages: Record<string, { version?: string }>;
};
const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
const vscodeignore = readFileSync(resolve(ROOT, '.vscodeignore'), 'utf8');

describe('Task 10 release: version consistency across manifest and lockfile', () => {
  it('package.json version and package-lock.json root version match', () => {
    expect(packageLock.version).toBe(packageJson.version);
  });

  it('package-lock.json packages[""].version matches package.json version', () => {
    expect(packageLock.packages[''].version).toBe(packageJson.version);
  });

  it('lockfileVersion is the lockfile FORMAT, not the project version, and is never conflated with it', () => {
    // A common mistake this test guards against: `lockfileVersion` (3 = npm's lockfile schema)
    // must never be read or reported as if it were the project's semantic version.
    expect(packageLock.lockfileVersion).not.toBe(packageJson.version);
    expect(typeof packageLock.lockfileVersion).toBe('number');
  });

  it('the current version has a matching CHANGELOG.md entry', () => {
    expect(changelog).toMatch(new RegExp(`##\\s*${packageJson.version.replace(/\./g, '\\.')}`));
  });

  it('the CHANGELOG entry for the current version is the first (most recent) one', () => {
    const firstHeading = changelog.match(/^##\s*(\S+)/m);
    expect(firstHeading?.[1]).toBe(packageJson.version);
  });

  it('package.json declares a semantic version (major.minor.patch)', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the npm scripts required for the release chain all exist', () => {
    for (const script of ['compile', 'lint', 'format:check', 'test', 'package', 'audit:release']) {
      expect(packageJson.scripts[script], `missing npm script "${script}"`).toBeDefined();
    }
  });

  it('.vscodeignore excludes compiled source maps from the packaged VSIX', () => {
    // Source maps reference "../../src/*.ts" paths that are never shipped, so they add bytes
    // with zero runtime debugging value once installed from the Marketplace/VSIX.
    expect(vscodeignore).toMatch(/\*\*\/\*\.map|out\/.*\.map/);
  });

  it('.vscodeignore excludes local audit/dependency-tree scratch artifacts', () => {
    expect(vscodeignore).toMatch(/audit\.json|-audit\.json/);
    expect(vscodeignore).toMatch(/-tree\.json/);
  });
});
