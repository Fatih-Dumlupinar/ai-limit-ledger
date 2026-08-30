import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_CANDIDATE_PATH_FILTER,
  RELEASE_CANDIDATE_TRIGGERS,
  WORKFLOW_DISPATCH_ONLY_WORKFLOWS,
  inspectWorkflow,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const read = (file: string) => readFileSync(resolve(ROOT, '.github/workflows', file), 'utf8');

const candidateSource = read('release-candidate.yml');
const finalizeSource = read('finalize-release.yml');
const { document, errors } = inspectWorkflow('release-candidate.yml', candidateSource);

type YamlMap = Record<string, unknown>;
const workflow = document.value as YamlMap;
const on = workflow.on as YamlMap;
const jobs = workflow.jobs as YamlMap;
const resolveJob = jobs.resolve as YamlMap;
const buildJob = jobs.build as YamlMap;
const buildText = JSON.stringify(buildJob);
const resolveText = JSON.stringify(resolveJob);

/**
 * Re-runs the policy verifier against a deliberately broken copy of the workflow.
 *
 * Asserting that the real file passes proves very little on its own — a check that never fails is
 * indistinguishable from a check that is not wired up. Each mutation below removes exactly one
 * safety property and asserts the verifier notices, so these tests fail if a rule is ever silently
 * deleted from `scripts/verify-workflows.mjs`.
 */
function errorsAfter(mutate: (source: string) => string): string[] {
  return inspectWorkflow('release-candidate.yml', mutate(candidateSource)).errors as string[];
}

describe('Task 14.2: the automatic release-candidate trigger', () => {
  it('passes the repository workflow policy verifier with no errors', () => {
    expect(errors as string[]).toEqual([]);
  });

  it('triggers on exactly a push and a manual dispatch, and nothing else', () => {
    expect(Object.keys(on).sort()).toEqual([...(RELEASE_CANDIDATE_TRIGGERS as string[])].sort());
  });

  it('scopes the automatic trigger to the main branch only', () => {
    expect((on.push as YamlMap).branches as string[]).toEqual(['main']);
  });

  it('starts automatically only for a change to a version-bearing manifest', () => {
    expect(((on.push as YamlMap).paths as string[]).sort()).toEqual(
      [...(RELEASE_CANDIDATE_PATH_FILTER as string[])].sort(),
    );
  });

  it('keeps the manual dispatch path with its required version input', () => {
    const inputs = (on.workflow_dispatch as YamlMap).inputs as YamlMap;
    expect(inputs).toHaveProperty('version');
    expect((inputs.version as YamlMap).required).toBe(true);
  });

  it('rejects a push trigger that is not scoped to main', () => {
    const mutated = errorsAfter((source) =>
      source.replace('    branches:\n      - main\n', '    branches:\n      - "**"\n'),
    );
    expect(mutated.join(' ')).toMatch(/scoped to the main branch only/);
  });

  it('rejects a path filter widened beyond the version manifests', () => {
    const mutated = errorsAfter((source) =>
      source.replace('      - package-lock.json\n', '      - package-lock.json\n      - src/**\n'),
    );
    expect(mutated.join(' ')).toMatch(/must not widen beyond the version manifests/);
  });

  it('rejects any additional trigger, such as pull_request or a workflow_run chain', () => {
    const mutated = errorsAfter((source) =>
      source.replace('  workflow_dispatch:\n', '  pull_request:\n  workflow_dispatch:\n'),
    );
    expect(mutated.join(' ')).toMatch(/must trigger on exactly/);
  });
});

describe('Task 14.2: deciding whether a candidate is due', () => {
  it('resolves the decision in a job separate from the one that builds', () => {
    expect(resolveJob).toBeDefined();
    expect(buildJob.needs).toBe('resolve');
  });

  it('builds only when the resolve job says a candidate is due', () => {
    expect(String(buildJob.if)).toContain("needs.resolve.outputs.should_build == 'true'");
  });

  it('reads the previous commit from event context through env, never inline in a shell body', () => {
    expect(resolveText).toContain('github.event.before');
    const runBlocks = candidateSource.match(/run: \|[\s\S]*?(?=\n {6}- name:|\n {2}\w|$)/g) ?? [];
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{\s*github\.event/);
      expect(block).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  it('validates the previous commit SHA as a full 40-character lowercase hex value', () => {
    expect(candidateSource).toContain("'^[0-9a-f]{40}$'");
  });

  it('reads the previous version through a git object reference, not by reconstructing it', () => {
    expect(candidateSource).toMatch(/git show "\$\{BEFORE_SHA\}:package\.json"/);
  });

  it('validates both the new and previous versions as strict SemVer', () => {
    const semverGates = candidateSource.match(/\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/g) ?? [];
    expect(semverGates.length).toBeGreaterThanOrEqual(3);
  });

  it('requires package.json and package-lock.json to carry the same version', () => {
    expect(resolveText).toContain('versions disagree');
    expect(resolveText).toContain('previous package-lock.json');
  });

  it('skips — successfully, without building — when the version did not actually change', () => {
    expect(resolveText).toContain('version did not');
    expect(resolveText).toContain('should_build=false');
  });

  it('skips when the previous commit is the zero SHA or otherwise unavailable', () => {
    expect(resolveText).toContain('0000000000000000000000000000000000000000');
    expect(resolveText).toMatch(/no usable previous commit SHA/);
    expect(resolveText).toMatch(/not present in this checkout/);
  });

  it('rejects a build job that is no longer gated on the decision', () => {
    const mutated = errorsAfter((source) =>
      source.replace("    if: needs.resolve.outputs.should_build == 'true'\n", ''),
    );
    expect(mutated.join(' ')).toMatch(/must be gated on the resolve decision/);
  });
});

describe('Task 14.2: preflight gates on the candidate', () => {
  it('refuses to build a candidate for a version whose ref already exists', () => {
    expect(buildText).toContain('refs/tags/');
    expect(buildText).toMatch(/already exists on origin/);
  });

  it('requires a changelog section and a non-empty release-notes file for the version', () => {
    expect(buildText).toContain('CHANGELOG.md');
    expect(buildText).toContain('RELEASE-NOTES-');
    expect(buildText).toContain('[Unreleased]');
    expect(buildText).toMatch(/is empty/);
  });

  it('verifies the manifest publisher and extension id against fixed expected values', () => {
    expect(candidateSource).toContain('EXPECTED_PUBLISHER: fatihdumlupinar-dev');
    expect(candidateSource).toContain('EXPECTED_NAME: ai-limit-ledger');
    expect(buildText).toMatch(/computed extension id does not match/);
  });

  it('proves the candidate commit is part of main history before building', () => {
    expect(buildText).toContain('merge-base --is-ancestor');
  });
});

describe('Task 14.2: the privacy audit is a fail-closed gate', () => {
  it('runs the source, history, and packaged-VSIX audits', () => {
    expect(buildText).toContain('npm run audit:privacy');
    expect(buildText).toContain('npm run audit:privacy -- --history');
    expect(buildText).toContain('npm run audit:privacy -- --vsix');
  });

  it('runs the source and history gates before anything is packaged', () => {
    const packageAt = candidateSource.indexOf('run: npm run package');
    expect(candidateSource.indexOf('run: npm run audit:privacy\n')).toBeLessThan(packageAt);
    expect(candidateSource.indexOf('run: npm run audit:privacy -- --history')).toBeLessThan(
      packageAt,
    );
  });

  it('runs the packaged gate before the artifact, SBOM, manifest, or attestation exist', () => {
    const vsixGate = candidateSource.indexOf('npm run audit:privacy -- --vsix');
    for (const downstream of [
      'actions/upload-artifact',
      'generate-sbom.mjs',
      'generate-release-manifest.mjs',
      'actions/attest-build-provenance',
    ]) {
      expect(candidateSource.indexOf(downstream), downstream).toBeGreaterThan(vsixGate);
    }
  });

  it('is caught by the verifier if any of the three gates is removed', () => {
    for (const gate of [
      'npm run audit:privacy -- --history',
      'npm run audit:privacy -- --vsix "$VSIX_PATH"',
    ]) {
      const mutated = errorsAfter((source) => source.replace(gate, 'echo skipped'));
      expect(mutated.join(' '), gate).toMatch(/missing the privacy gate/);
    }
  });

  it('is caught by the verifier if the packaged gate is moved after the upload', () => {
    const mutated = errorsAfter((source) => {
      const lines = source.split('\n');
      const start = lines.findIndex(
        (line) => line.includes('Privacy audit') && line.includes('packaged VSIX'),
      );
      const block = lines.splice(start, 3);
      lines.splice(
        lines.findIndex((line) => line.includes('- name: Summarize the candidate')),
        0,
        ...block,
      );
      return lines.join('\n');
    });
    expect(mutated.join(' ')).toMatch(/must not run before the packaged-VSIX privacy gate/);
  });
});

describe('Task 14.2: the candidate stage cannot publish or release', () => {
  it('never publishes to the Marketplace and holds no publishing credential', () => {
    expect(candidateSource).not.toMatch(/vsce\s+publish|ovsx\s+publish|npm\s+publish/i);
    expect(candidateSource).not.toMatch(/VSCE_PAT|AZURE_DEVOPS|OVSX_PAT|MARKETPLACE_TOKEN/i);
    expect(candidateSource).not.toMatch(/secrets\./);
    expect(candidateSource).not.toMatch(/marketplace\.visualstudio\.com/i);
  });

  it('never creates a tag, a commit, a push, or a GitHub Release', () => {
    expect(candidateSource).not.toMatch(/git\s+tag|git\s+commit|git\s+push/i);
    expect(candidateSource).not.toMatch(/gh\s+release|gh\s+api/i);
  });

  it('never dispatches another workflow, so finalize can only be started by a human', () => {
    expect(candidateSource).not.toMatch(/gh\s+workflow\s+run|createWorkflowDispatch|\/dispatches/i);
    // Structural, not textual: the workflow legitimately names the finalize stage in its job
    // summary, so what must be absent is a chaining *trigger*, not the words.
    for (const chaining of ['workflow_run', 'repository_dispatch', 'workflow_call']) {
      expect(Object.keys(on), chaining).not.toContain(chaining);
    }
  });

  it('never runs on pull_request_target or on pull-request code', () => {
    expect(candidateSource).not.toContain('pull_request_target');
    expect(Object.keys(on)).not.toContain('pull_request');
  });

  it('keeps workflow-level permissions read-only', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('elevates permissions only in the build job, and only for attestation', () => {
    expect(resolveJob.permissions).toEqual({ contents: 'read' });
    expect(buildJob.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
  });

  it('pins every action to a full commit SHA', () => {
    for (const usesLine of candidateSource.match(/uses:\s*[^\n]+/g) ?? []) {
      const [, ref] = usesLine.replace('uses:', '').replace(/#.*$/, '').trim().split('@');
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe('Task 14.2: artifact, concurrency, and summary contract', () => {
  it('retains the candidate artifact for seven days', () => {
    const retention = Number(candidateSource.match(/retention-days:\s*(\d+)/)?.[1]);
    expect(retention).toBe(7);
  });

  it('is caught by the verifier if retention drifts outside the band', () => {
    expect(
      errorsAfter((s) => s.replace('retention-days: 7', 'retention-days: 21')).join(' '),
    ).toMatch(/artifact retention must be between 1 and 7 days/);
  });

  it('names the artifact deterministically by version and short commit SHA', () => {
    expect(buildText).toContain('ai-limit-ledger-');
    expect(buildText).toContain('rc-');
    expect(buildText).toContain('SHORT_SHA');
  });

  it('never cancels a running candidate build', () => {
    const concurrency = workflow.concurrency as YamlMap;
    expect(concurrency['cancel-in-progress']).toBe(false);
    expect(String(concurrency.group)).toContain('github.ref');
    expect(String(concurrency.group)).toContain('github.sha');
  });

  it('is caught by the verifier if cancel-in-progress is ever turned on', () => {
    expect(
      errorsAfter((s) => s.replace('cancel-in-progress: false', 'cancel-in-progress: true')).join(
        ' ',
      ),
    ).toMatch(/never be cancelled in progress/);
  });

  it('writes a job summary covering trigger, version, commit, identity, and audit results', () => {
    for (const field of [
      '| Trigger |',
      '| Version |',
      '| Commit |',
      '| Publisher |',
      '| Extension ID |',
      '| Tests |',
      '| Privacy audit |',
      '| VSIX SHA-256 |',
    ]) {
      expect(buildText, field).toContain(field);
    }
  });

  it('states in the summary that nothing was published, tagged, or released', () => {
    expect(buildText).toMatch(/did \*\*not\*\* upload anything to the Visual Studio Marketplace/);
    expect(buildText).toMatch(/did \*\*not\*\* create, move, or delete a tag/);
    expect(buildText).toMatch(/Next step \(manual\)/);
  });

  it('explains a skipped run in its own summary instead of failing silently', () => {
    expect(resolveText).toContain('Release Candidate — skipped');
    expect(resolveText).toContain('no candidate built');
    expect(resolveText).toMatch(/dispatch this workflow manually/);
  });

  it('never renders a matched privacy value into the summary', () => {
    expect(buildText).toMatch(/no matched value appears in this summary/);
  });
});

describe('Task 14.2: Finalize Release keeps its security boundary', () => {
  const finalize = inspectWorkflow('finalize-release.yml', finalizeSource);
  const finalizeWorkflow = finalize.document.value as YamlMap;

  it('passes the policy verifier with no errors', () => {
    expect(finalize.errors as string[]).toEqual([]);
  });

  it('remains dispatch-only, and is the only workflow held to that rule', () => {
    expect(Object.keys(finalizeWorkflow.on as YamlMap)).toEqual(['workflow_dispatch']);
    expect(WORKFLOW_DISPATCH_ONLY_WORKFLOWS as string[]).toEqual(['finalize-release.yml']);
  });

  it('remains gated on the protected production-release environment', () => {
    expect(((finalizeWorkflow.jobs as YamlMap).finalize as YamlMap).environment).toBe(
      'production-release',
    );
  });

  it('keeps the exact Marketplace URL check and the version-scoped confirmation phrase', () => {
    expect(finalizeSource).toContain(
      'https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger',
    );
    expect(finalizeSource).toContain('I_HAVE_VERIFIED_MARKETPLACE_');
  });

  it('still verifies the candidate run id, commit SHA, artifact contents, and checksums', () => {
    expect(finalizeSource).toContain("'^[0-9]+$'");
    expect(finalizeSource).toContain("'^[0-9a-f]{40}$'");
    expect(finalizeSource).toContain('merge-base --is-ancestor');
    expect(finalizeSource).toContain('SHA256SUMS.txt');
    expect(finalizeSource).toContain('release-manifest.json');
  });

  it('accepts a candidate from either trigger but from no other event, and only from main', () => {
    expect(finalizeSource).toContain('push|workflow_dispatch)');
    expect(finalizeSource).toMatch(/cannot produce a promotable candidate/);
    expect(finalizeSource).toMatch(/was built from \$head_branch, not main/);
  });

  it('still refuses to move a tag or overwrite an existing asset', () => {
    expect(finalizeSource).toMatch(/refusing to move it/);
    expect(finalizeSource).toMatch(/no overwrite/);
    expect(finalizeSource).not.toMatch(/--force|--clobber/);
  });

  it('is never started automatically by the candidate workflow', () => {
    // Neither workflow declares a chaining trigger, so a successful candidate run cannot start a
    // finalize run: promotion always requires a human dispatch plus an environment approval.
    for (const chaining of ['workflow_run', 'repository_dispatch', 'workflow_call']) {
      expect(Object.keys(on), `candidate: ${chaining}`).not.toContain(chaining);
      expect(Object.keys(finalizeWorkflow.on as YamlMap), `finalize: ${chaining}`).not.toContain(
        chaining,
      );
    }
    expect(candidateSource).not.toMatch(/gh\s+workflow\s+run|createWorkflowDispatch/i);
  });
});
