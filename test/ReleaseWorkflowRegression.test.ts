import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  verifyRepository,
  inspectWorkflow,
  EXPECTED_WORKFLOWS,
  ACTION_RELEASES,
  FORBIDDEN_PUBLISH_CREDENTIAL_PATTERNS,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const read = (file: string) => readFileSync(resolve(ROOT, '.github/workflows', file), 'utf8');
const sources = new Map<string, string>(
  (EXPECTED_WORKFLOWS as string[]).map((file) => [file, read(file)]),
);

/**
 * Task 14.1 generalized two workflows and added a development environment. These are the
 * invariants that must survive that change untouched — the properties the earlier hardening tasks
 * established, re-asserted here so a future edit to the reusable release machinery cannot quietly
 * relax one of them.
 */
describe('Task 14.1: workflow regression invariants', () => {
  it('keeps the whole repository policy verifier at zero errors', () => {
    const result = verifyRepository(ROOT) as { ok: boolean; errors: string[] };
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('pins every action in every workflow to an approved full-SHA release', () => {
    for (const [file, source] of sources) {
      for (const usesLine of source.match(/uses:\s*[^\n]+/g) ?? []) {
        const action = usesLine.replace('uses:', '').replace(/#.*$/, '').trim();
        const [path, ref] = action.split('@');
        // codeql-action publishes sub-actions (…/init, …/analyze) under one release table entry.
        const repo = path.split('/').slice(0, 2).join('/');
        expect(Object.keys(ACTION_RELEASES), `${file}: ${repo}`).toContain(repo);
        expect(ref, `${file}: ${repo}`).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it('keeps top-level permissions read-only in every workflow but CodeQL', () => {
    for (const [file, source] of sources) {
      const { document } = inspectWorkflow(file, source);
      const permissions = (document.value as Record<string, unknown>).permissions as Record<
        string,
        string
      >;
      for (const [name, level] of Object.entries(permissions ?? {})) {
        // CodeQL's `security-events: write` is its documented, workflow-level requirement for
        // uploading SARIF; every other workflow stays read-only at the top level and elevates
        // only inside the one job that needs it.
        if (file === 'codeql.yml' && name === 'security-events') continue;
        expect(level, `${file}: ${name}`).not.toBe('write');
        expect(level, `${file}: ${name}`).not.toBe('write-all');
      }
    }
  });

  it('grants each job-level elevated permission to exactly one job in exactly one workflow', () => {
    const elevated: string[] = [];
    for (const [file, source] of sources) {
      const { document } = inspectWorkflow(file, source);
      const jobs = ((document.value as Record<string, unknown>).jobs ?? {}) as Record<
        string,
        { permissions?: Record<string, string> }
      >;
      for (const [jobId, job] of Object.entries(jobs)) {
        for (const [name, level] of Object.entries(job.permissions ?? {})) {
          if (level === 'write') elevated.push(`${file}:${jobId}:${name}`);
        }
      }
    }
    expect(elevated.sort()).toEqual([
      'finalize-release.yml:finalize:contents',
      'release-candidate.yml:build:attestations',
      'release-candidate.yml:build:id-token',
    ]);
  });

  it('never references a publishing credential in any workflow', () => {
    for (const [file, source] of sources) {
      for (const { name, pattern } of FORBIDDEN_PUBLISH_CREDENTIAL_PATTERNS as Array<{
        name: string;
        pattern: RegExp;
      }>) {
        expect(pattern.test(source), `${file} [${name}]`).toBe(false);
      }
      expect(source, file).not.toMatch(/secrets\./);
      expect(source, file).not.toContain('pull_request_target');
    }
  });

  it('sets persist-credentials: false on every checkout in every workflow', () => {
    for (const [file, source] of sources) {
      const checkouts = (source.match(/uses:\s*actions\/checkout@/g) ?? []).length;
      const persists = (source.match(/persist-credentials:\s*false/g) ?? []).length;
      expect(persists, file).toBe(checkouts);
    }
  });

  it('leaves the four non-release workflows triggered and scoped exactly as before', () => {
    for (const file of ['ci.yml', 'codeql.yml', 'secret-scan.yml', 'dependency-review.yml']) {
      const { document, errors } = inspectWorkflow(file, sources.get(file) as string);
      expect(errors as string[], file).toEqual([]);
      const on = (document.value as Record<string, unknown>).on as Record<string, unknown>;
      if (file === 'dependency-review.yml') {
        expect(Object.keys(on)).toEqual(['pull_request']);
      } else {
        expect(Object.keys(on)).toContain('pull_request');
        expect(Object.keys(on)).toContain('push');
      }
      // Only the two release workflows may mention a release/publish concept at all.
      expect(sources.get(file), file).not.toMatch(/gh\s+release|marketplace\.visualstudio/i);
    }
  });

  it('keeps both release workflows dispatch-only', () => {
    for (const file of ['release-candidate.yml', 'finalize-release.yml']) {
      const { document } = inspectWorkflow(file, sources.get(file) as string);
      const on = (document.value as Record<string, unknown>).on as Record<string, unknown>;
      expect(Object.keys(on), file).toEqual(['workflow_dispatch']);
    }
  });

  it('keeps the release-candidate artifact retention inside the 14-30 day band', () => {
    const retention = Number(
      (sources.get('release-candidate.yml') as string).match(/retention-days:\s*(\d+)/)?.[1],
    );
    expect(retention).toBeGreaterThanOrEqual(14);
    expect(retention).toBeLessThanOrEqual(30);
  });

  it('reports zero failing checks from the source-tree release audit', () => {
    const output = execFileSync(process.execPath, [resolve(ROOT, 'scripts/release-audit.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toMatch(/\d+ checks: \d+ pass, \d+ warn, 0 fail/);
    expect(output).not.toMatch(/^\[✗\]/m);
  });

  it('leaves the extension runtime untouched — no source file changed for this task', () => {
    const changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    // A process/documentation task must not touch the extension runtime. If this ever fails, the
    // change under review is no longer behavior-neutral and needs runtime test coverage too.
    expect(changed.filter((f) => f.startsWith('src/'))).toEqual([]);
    expect(changed.filter((f) => /^package\.nls(\.tr)?\.json$/.test(f))).toEqual([]);
  });
});
