import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import { inspectWorkflow, ACTION_RELEASES } from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const source = readFileSync(resolve(ROOT, '.github/workflows/finalize-release.yml'), 'utf8');
const { document, errors } = inspectWorkflow('finalize-release.yml', source);
type YamlMap = Record<string, unknown>;
const workflow = document.value as YamlMap;
const jobs = workflow.jobs as YamlMap;
const finalize = jobs.finalize as YamlMap;
const finalizeText = JSON.stringify(finalize);

describe('Task 14: finalize-release.yml workflow policy', () => {
  it('passes the repository workflow policy verifier with no errors', () => {
    expect(errors as string[]).toEqual([]);
  });

  it('triggers only on workflow_dispatch, never automatically', () => {
    expect(Object.keys(workflow.on as YamlMap)).toEqual(['workflow_dispatch']);
  });

  it('requires the full strict input set', () => {
    const inputs = ((workflow.on as YamlMap).workflow_dispatch as YamlMap).inputs as YamlMap;
    for (const name of [
      'version',
      'candidate_run_id',
      'commit_sha',
      'marketplace_url',
      'marketplace_confirmation',
    ]) {
      expect(inputs, `missing input ${name}`).toHaveProperty(name);
      expect((inputs[name] as YamlMap).required).toBe(true);
    }
  });

  it('requires a version-scoped Marketplace confirmation phrase, derived not hardcoded', () => {
    expect(source).toContain('I_HAVE_VERIFIED_MARKETPLACE_');
    expect(source).toContain('expected_confirmation="${CONFIRMATION_PREFIX}${INPUT_VERSION}"');
    // A frozen phrase would keep accepting the previous release's confirmation for the next
    // version, so only a `description:` example may carry a concrete version.
    for (const line of source.split('\n')) {
      if (/^\s*description:/.test(line)) continue;
      expect(line).not.toMatch(/I_HAVE_VERIFIED_MARKETPLACE_\d+\.\d+\.\d+/);
    }
  });

  it('requires the exact Marketplace listing URL', () => {
    expect(source).toContain(
      'https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger',
    );
  });

  it('runs the finalize job under the production-release environment', () => {
    expect(finalize.environment).toBe('production-release');
  });

  it('does not create the production-release environment itself', () => {
    expect(source).not.toMatch(/create[- ]environment|gh api.*environments/i);
  });

  it('declares only minimal, job-scoped write permissions', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(finalize.permissions).toEqual({ contents: 'write', actions: 'read' });
  });

  it('does not request id-token: write (not needed for tag/release creation)', () => {
    expect(source).not.toMatch(/id-token:\s*write/);
  });

  it('uses a version-scoped, non-cancelling concurrency group', () => {
    const concurrency = workflow.concurrency as YamlMap;
    expect(String(concurrency.group)).toContain('inputs.version');
    expect(concurrency['cancel-in-progress']).toBe(false);
  });

  it('verifies the candidate run, downloads its artifact, and re-audits it', () => {
    for (const command of [
      'gh run view',
      'gh run download',
      'gh api',
      'gh release create',
      'release-audit.mjs',
      'merge-base --is-ancestor',
    ]) {
      expect(finalizeText).toContain(command);
    }
  });

  it('never force-moves a tag or overwrites a release asset', () => {
    expect(source).not.toContain('--force');
    expect(source).not.toContain('--clobber');
    expect(source).not.toMatch(/git\s+push\s+.*--force/);
  });

  it('never publishes to the Marketplace or npm', () => {
    expect(source).not.toMatch(/vsce\s+publish|npm\s+publish/i);
  });

  it('never unpublishes or removes a Marketplace/GitHub release', () => {
    expect(source).not.toMatch(/gh release delete|unpublish/i);
  });

  it('reads no repository secret directly (relies only on the ambient job-scoped token)', () => {
    expect(source).not.toMatch(/secrets\./);
    expect(source).toContain('github.token');
  });

  it('checks out full history only for the ancestry check', () => {
    expect(source).toMatch(/fetch-depth:\s*0/);
  });

  it('pins every action to the approved full-SHA release table', () => {
    for (const usesLine of source.match(/uses:\s*[^\n]+/g) ?? []) {
      const action = usesLine.replace('uses:', '').replace(/#.*$/, '').trim();
      const [repo, ref] = action.split('@');
      expect(Object.keys(ACTION_RELEASES)).toContain(repo);
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('never interpolates untrusted event/input context directly into a shell command', () => {
    expect(errors.some((e: string) => e.includes('untrusted event/input'))).toBe(false);
    const runBlocks = source.match(/run:\s*\|[\s\S]*?(?=\n\s{2,}- name:|\n\s{2,}- uses:|$)/g) ?? [];
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{\s*inputs\./);
      expect(block).not.toMatch(/\$\{\{\s*github\.(event|sha|ref|ref_name|actor)/);
    }
  });
});
