import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  engines: { vscode: string; node?: string };
  devDependencies: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
};
const docFiles = [
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'PRIVACY.md',
  'SUPPORT.md',
  'PUBLISHING.md',
  'docs/DEPENDENCY-RISK-REGISTER.md',
].filter((f) => existsSync(resolve(ROOT, f)));

describe('Task 10.1: supported Node LTS development policy', () => {
  it('package.json declares a development engines.node requirement', () => {
    expect(packageJson.engines.node).toBeDefined();
  });

  it('the declared minimum Node version is on a currently supported LTS line (>= 22), not EOL Node 20', () => {
    const match = packageJson.engines.node?.match(/(\d+)\.(\d+)\.(\d+)/);
    expect(
      match,
      `engines.node "${packageJson.engines.node}" should contain a semver floor`,
    ).not.toBeNull();
    const major = Number(match?.[1]);
    expect(major).toBeGreaterThanOrEqual(22);
  });

  it('engines.vscode is unchanged by the Node policy update', () => {
    expect(packageJson.engines.vscode).toBe('^1.95.0');
  });

  it('.nvmrc and .node-version exist and declare the same major LTS line', () => {
    const nvmrc = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();
    const nodeVersion = readFileSync(resolve(ROOT, '.node-version'), 'utf8').trim();
    expect(nvmrc).toBe(nodeVersion);
  });

  it(".nvmrc declares the preferred major LTS line (24), matching engines.node's minimum-supported alternative", () => {
    const nvmrc = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();
    expect(nvmrc).toBe('24');
  });

  it('.nvmrc and .node-version are excluded from the packaged VSIX (development-only files)', () => {
    const vscodeignore = readFileSync(resolve(ROOT, '.vscodeignore'), 'utf8');
    expect(vscodeignore).toMatch(/\.nvmrc/);
    expect(vscodeignore).toMatch(/\.node-version/);
  });

  it('no project documentation recommends EOL Node 20 as a development target', () => {
    const eolNode20Recommendation =
      /node\s*(?:\.js)?\s*20(?!\d)(?!\.\d+\.\d+ (?:reached|is end|was end))/i;
    const offenders: string[] = [];
    for (const file of docFiles) {
      const content = readFileSync(resolve(ROOT, file), 'utf8');
      // Look specifically for phrasing that recommends/requires Node 20 for development
      // (e.g. "requires Node.js 20", "Node 20.18.1 or newer"), not incidental historical
      // mentions of Node 20 having been used, being EOL, or being unsupported.
      const recommending = /(?:requires?|use|install|target(?:s|ing)?)\s+node(?:\.js)?\s*20\b/i;
      if (recommending.test(content)) offenders.push(file);
      void eolNode20Recommendation;
    }
    expect(offenders).toEqual([]);
  });

  it('README documents Node 24 as preferred and Node 22 as the minimum supported development runtime', () => {
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/Node 24/);
    expect(readme).toMatch(/Node 22/);
  });

  it('README distinguishes the development Node requirement from the VS Code extension host runtime', () => {
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/extension host/i);
    expect(readme).toMatch(/zero production dependencies/i);
  });

  it('keeps Node development engines separate from Node 20 and VS Code extension-host types', () => {
    expect(packageJson.engines.node).toBe('>=22.12.0');
    expect(packageJson.engines.vscode).toBe('^1.95.0');
    expect(packageJson.devDependencies['@types/node']).toBe('^20.17.0');
    expect(packageJson.devDependencies['@types/vscode']).toBe('^1.95.0');
    expect(packageLock.packages['node_modules/@types/node']?.version).toMatch(/^20\./);
    expect(packageLock.packages['node_modules/@types/vscode']?.version).toMatch(/^1\./);
  });

  it('preserves the Task 12.0 toolchain majors and the Task 12 Dependabot update', () => {
    expect(packageJson.devDependencies['@typescript-eslint/eslint-plugin']).toBe('^8.68.0');
    expect(packageJson.devDependencies['@typescript-eslint/parser']).toBe('^8.18.0');
    expect(packageJson.devDependencies.typescript).toMatch(/^\^5\./);
    expect(packageJson.devDependencies.eslint).toMatch(/^\^9\./);
    expect(packageJson.devDependencies.typescript).not.toMatch(/^\^7\./);
    expect(packageJson.devDependencies.eslint).not.toMatch(/^\^10\./);
    expect(packageLock.packages['']?.devDependencies).toEqual(packageJson.devDependencies);
  });
});
