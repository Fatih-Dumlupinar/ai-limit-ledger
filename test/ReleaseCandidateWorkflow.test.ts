import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import { inspectWorkflow, ACTION_RELEASES } from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const source = readFileSync(resolve(ROOT, '.github/workflows/release-candidate.yml'), 'utf8');
const { document, errors } = inspectWorkflow('release-candidate.yml', source);
type YamlMap = Record<string, unknown>;
const workflow = document.value as YamlMap;
const jobs = workflow.jobs as YamlMap;
const build = jobs.build as YamlMap;
const buildText = JSON.stringify(build);

describe('Task 14: release-candidate.yml workflow policy', () => {
  it('passes the repository workflow policy verifier with no errors', () => {
    expect(errors as string[]).toEqual([]);
  });

  it('triggers only on workflow_dispatch, never automatically', () => {
    expect(Object.keys(workflow.on as YamlMap)).toEqual(['workflow_dispatch']);
  });

  it('requires an exact "version" input', () => {
    const inputs = ((workflow.on as YamlMap).workflow_dispatch as YamlMap).inputs as YamlMap;
    expect(inputs).toHaveProperty('version');
    expect((inputs.version as YamlMap).required).toBe(true);
  });

  it('declares only read permissions at the workflow level', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('elevates permissions only at job level, only for attestation', () => {
    expect(build.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
  });

  it('uses a version-scoped, ref-scoped, non-cancelling concurrency group', () => {
    const concurrency = workflow.concurrency as YamlMap;
    expect(String(concurrency.group)).toContain('github.ref');
    expect(String(concurrency.group)).toContain('inputs.version');
    expect(concurrency['cancel-in-progress']).toBe(false);
  });

  it('runs the full required verification chain before packaging', () => {
    for (const command of [
      'npm ci',
      'npm run compile',
      'npm run lint',
      'npm run format:check',
      'npm run verify:workflows',
      'npm audit',
      'npm audit --omit=dev',
      'npm run audit:release',
      'npm test',
      'npm run package',
    ]) {
      expect(buildText).toContain(command);
    }
  });

  it('never installs, publishes, releases, or reads a repository secret', () => {
    expect(source).not.toMatch(/npm install|npm publish|vsce publish|gh release|secrets\./i);
    expect(source).not.toContain('pull_request_target');
  });

  it('never creates a tag or a commit', () => {
    expect(source).not.toMatch(/git\s+tag|git\s+commit|git\s+push/i);
  });

  it('generates a checksum, SBOM, release manifest, and provenance attestation', () => {
    expect(buildText).toContain('sha256sum');
    expect(buildText).toContain('generate-sbom.mjs');
    expect(buildText).toContain('generate-release-manifest.mjs');
    expect(buildText).toContain('actions/attest-build-provenance');
  });

  it('uploads a retention-bounded artifact named with the version and short commit SHA', () => {
    expect(buildText).toContain('actions/upload-artifact');
    expect(buildText).toContain('ai-limit-ledger-');
    expect(buildText).toContain('rc-');
    const retentionMatch = source.match(/retention-days:\s*(\d+)/);
    expect(retentionMatch).not.toBeNull();
    const retentionDays = Number(retentionMatch?.[1]);
    expect(retentionDays).toBeGreaterThanOrEqual(14);
    expect(retentionDays).toBeLessThanOrEqual(30);
  });

  it('never interpolates untrusted event/input context directly into a shell command', () => {
    expect(errors.some((e: string) => e.includes('untrusted event/input'))).toBe(false);
    // Belt-and-suspenders literal check: every ${{ }} in a run: step must reference an env var,
    // never inputs.*/github.event.*/github.sha/github.ref/etc directly.
    const runBlocks = source.match(/run:\s*\|[\s\S]*?(?=\n\s{2,}- name:|\n\s{2,}- uses:|$)/g) ?? [];
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{\s*inputs\./);
      expect(block).not.toMatch(/\$\{\{\s*github\.(event|sha|ref|ref_name|actor)/);
    }
  });

  it('pins every action to the approved full-SHA release table', () => {
    for (const usesLine of source.match(/uses:\s*[^\n]+/g) ?? []) {
      const action = usesLine.replace('uses:', '').replace(/#.*$/, '').trim();
      const [repo, ref] = action.split('@');
      expect(Object.keys(ACTION_RELEASES)).toContain(repo);
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
