import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import { buildManifest } from '../scripts/generate-release-manifest.mjs';

/** Minimal, valid, zero-entry ZIP (a well-formed empty archive, just the End Of Central
 * Directory record) — enough for the manifest generator's own ZIP entry-count reader. */
function emptyZipBuffer(): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0); // EOCD signature
  buf.writeUInt16LE(0, 4); // disk number
  buf.writeUInt16LE(0, 6); // disk where CD starts
  buf.writeUInt16LE(0, 8); // CD records on this disk
  buf.writeUInt16LE(0, 10); // total CD records
  buf.writeUInt32LE(0, 12); // size of CD
  buf.writeUInt32LE(0, 16); // offset of CD
  buf.writeUInt16LE(0, 20); // comment length
  return buf;
}

describe('Task 14: scripts/generate-release-manifest.mjs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-limit-ledger-manifest-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixtures() {
    const vsixPath = join(dir, 'ai-limit-ledger-0.7.0.vsix');
    writeFileSync(vsixPath, emptyZipBuffer());

    const vitestJsonPath = join(dir, 'vitest-report.json');
    writeFileSync(vitestJsonPath, JSON.stringify({ numTotalTestSuites: 101, numTotalTests: 1040 }));

    const auditAllPath = join(dir, 'npm-audit-all.json');
    writeFileSync(
      auditAllPath,
      JSON.stringify({
        metadata: { vulnerabilities: { total: 0, critical: 0, high: 0, moderate: 0, low: 0 } },
      }),
    );

    const auditProdPath = join(dir, 'npm-audit-prod.json');
    writeFileSync(
      auditProdPath,
      JSON.stringify({
        metadata: { vulnerabilities: { total: 0, critical: 0, high: 0, moderate: 0, low: 0 } },
      }),
    );

    return { vsixPath, vitestJsonPath, auditAllPath, auditProdPath };
  }

  const env = {
    RELEASE_GIT_COMMIT: 'a'.repeat(40),
    RELEASE_NODE_VERSION: 'v24.20.0',
    RELEASE_NPM_VERSION: '10.9.4',
    RELEASE_WORKFLOW_RUN_ID: '123456789',
    RELEASE_REPOSITORY: 'Fatih-Dumlupinar/ai-limit-ledger',
  };
  const pkg = { name: 'ai-limit-ledger', publisher: 'fatihdumlupinar-dev', version: '0.7.0' };

  it('builds a manifest with exactly the documented safe fields', () => {
    const { vsixPath, vitestJsonPath, auditAllPath, auditProdPath } = writeFixtures();
    const manifest = buildManifest({
      pkg,
      vsixPath,
      vitestJsonPath,
      auditAllPath,
      auditProdPath,
      env,
    });

    expect(manifest.version).toBe('0.7.0');
    expect(manifest.publisher).toBe('fatihdumlupinar-dev');
    expect(manifest.extensionId).toBe('fatihdumlupinar-dev.ai-limit-ledger');
    expect(manifest.gitCommit).toBe(env.RELEASE_GIT_COMMIT);
    expect(manifest.nodeVersion).toBe(env.RELEASE_NODE_VERSION);
    expect(manifest.npmVersion).toBe(env.RELEASE_NPM_VERSION);
    expect(manifest.package.filename).toBe('ai-limit-ledger-0.7.0.vsix');
    expect(manifest.package.sizeBytes).toBe(22);
    expect(manifest.package.fileCount).toBe(0);
    expect(manifest.tests.fileCount).toBe(101);
    expect(manifest.tests.testCount).toBe(1040);
    expect(manifest.audit.all.total).toBe(0);
    expect(manifest.audit.productionOnly.total).toBe(0);
    expect(manifest.workflowRunId).toBe(env.RELEASE_WORKFLOW_RUN_ID);
    expect(manifest.repository).toBe(env.RELEASE_REPOSITORY);
    expect(() => new Date(manifest.buildTimestampUtc).toISOString()).not.toThrow();
  });

  it('computes a real SHA-256 of the VSIX bytes, not a placeholder', () => {
    const { vsixPath, vitestJsonPath, auditAllPath, auditProdPath } = writeFixtures();
    const manifest = buildManifest({
      pkg,
      vsixPath,
      vitestJsonPath,
      auditAllPath,
      auditProdPath,
      env,
    });
    const expectedSha = createHash('sha256').update(emptyZipBuffer()).digest('hex');
    expect(manifest.package.sha256).toBe(expectedSha);
  });

  it('never includes a user path, credential, or runner-temp path', () => {
    const { vsixPath, vitestJsonPath, auditAllPath, auditProdPath } = writeFixtures();
    const manifest = buildManifest({
      pkg,
      vsixPath,
      vitestJsonPath,
      auditAllPath,
      auditProdPath,
      env,
    });
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(text).not.toMatch(/\/home\//);
    expect(text).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'version',
        'publisher',
        'extensionId',
        'gitCommit',
        'nodeVersion',
        'npmVersion',
        'package',
        'tests',
        'audit',
        'buildTimestampUtc',
        'workflowRunId',
        'repository',
      ].sort(),
    );
  });
});
