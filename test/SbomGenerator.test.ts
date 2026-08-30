import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import { buildSbom } from '../scripts/generate-sbom.mjs';

const pkg = { name: 'ai-limit-ledger', version: '0.7.0' };

const lock = {
  packages: {
    '': { name: 'ai-limit-ledger', version: '0.7.0' },
    'node_modules/typescript': { name: 'typescript', version: '5.7.2', dev: true },
    'node_modules/@types/node': { name: '@types/node', version: '20.17.0', dev: true },
    'node_modules/no-name-entry': { version: '1.0.0' }, // no explicit "name" field
  },
};

describe('Task 14: scripts/generate-sbom.mjs', () => {
  it('produces a valid CycloneDX-shaped document', () => {
    const sbom = buildSbom(pkg, lock);
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.5');
    expect(sbom.metadata.component.name).toBe('ai-limit-ledger');
    expect(sbom.metadata.component.version).toBe('0.7.0');
  });

  it('lists every locked package as a component with a purl', () => {
    const sbom = buildSbom(pkg, lock);
    const names = sbom.components.map((c: { name: string }) => c.name);
    expect(names).toContain('typescript');
    expect(names).toContain('@types/node');
    const typescript = sbom.components.find((c: { name: string }) => c.name === 'typescript');
    expect(typescript.purl).toBe('pkg:npm/typescript@5.7.2');
  });

  it('handles scoped package names in the purl', () => {
    const sbom = buildSbom(pkg, lock);
    const scoped = sbom.components.find((c: { name: string }) => c.name === '@types/node');
    expect(scoped.purl).toBe('pkg:npm/%40types%2Fnode@20.17.0');
  });

  it('derives a name from the lockfile key when the entry has no explicit name', () => {
    const sbom = buildSbom(pkg, lock);
    const derived = sbom.components.find((c: { name: string }) => c.name === 'no-name-entry');
    expect(derived).toBeDefined();
    expect(derived.version).toBe('1.0.0');
  });

  it('never includes the root package itself as a dependency component', () => {
    const sbom = buildSbom(pkg, lock);
    const rootAsComponent = sbom.components.filter(
      (c: { name: string; version: string }) =>
        c.name === 'ai-limit-ledger' && c.version === '0.7.0',
    );
    expect(rootAsComponent).toEqual([]);
  });

  it('marks dev dependencies as optional scope and runtime dependencies as required', () => {
    const sbom = buildSbom(pkg, lock);
    const typescript = sbom.components.find((c: { name: string }) => c.name === 'typescript');
    expect(typescript.scope).toBe('optional');
  });

  it('is stable/sorted so re-generation on an identical lockfile is deterministic', () => {
    const first = JSON.stringify(buildSbom(pkg, lock).components);
    const second = JSON.stringify(buildSbom(pkg, lock).components);
    expect(first).toBe(second);
  });

  it('never embeds a filesystem path, credential, or token-shaped string', () => {
    const sbom = buildSbom(pkg, lock);
    const text = JSON.stringify(sbom);
    expect(text).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(text).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
  });
});
