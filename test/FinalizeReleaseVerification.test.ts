import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectWorkflow,
  EXPECTED_MARKETPLACE_URL,
  FORBIDDEN_PUBLISH_CREDENTIAL_PATTERNS,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const source = readFileSync(resolve(ROOT, '.github/workflows/finalize-release.yml'), 'utf8');
const { document } = inspectWorkflow('finalize-release.yml', source);
type YamlMap = Record<string, unknown>;
const workflow = document.value as YamlMap;
const finalize = (workflow.jobs as YamlMap).finalize as YamlMap;
const finalizeText = JSON.stringify(finalize);

/**
 * Finalization is the only step in this repository that can create a public artifact, so every
 * claim it relies on — which run produced the candidate, which commit that run built, what the
 * artifact contains, and whether a human actually verified the Marketplace listing — has to be
 * re-proved inside the workflow rather than trusted from the dispatch form.
 */
describe('Task 14.1: finalize-release candidate-run verification', () => {
  it('validates candidate_run_id as a bare positive integer', () => {
    expect(source).toContain("grep -Eq '^[0-9]+$'");
    expect(source).toContain('candidate_run_id must be a positive integer');
  });

  it('validates commit_sha as a full 40-character lowercase hex SHA', () => {
    expect(source).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(source).toContain('commit_sha must be a full 40-character lowercase hex SHA');
  });

  it('requires the candidate run to be a Release Candidate run in this repository', () => {
    expect(finalizeText).toContain('gh run view');
    expect(finalizeText).toContain('--repo \\"$GITHUB_REPOSITORY\\"');
    expect(source).toContain('[ "$workflow_name" = "Release Candidate" ]');
  });

  it('requires the candidate run to have been dispatched, not triggered automatically', () => {
    expect(source).toContain('[ "$event_name" = "workflow_dispatch" ]');
  });

  it('requires the candidate run to have concluded successfully', () => {
    expect(source).toContain('[ "$conclusion" = "success" ]');
  });

  it('requires the candidate run head SHA to equal the commit_sha input', () => {
    expect(source).toContain('[ "$head_sha" = "$COMMIT_SHA" ]');
  });

  it("proves the commit is part of main's history before releasing it", () => {
    expect(source).toContain('git merge-base --is-ancestor "$COMMIT_SHA" origin/main');
    expect(source).toMatch(/fetch-depth:\s*0/);
  });

  it('selects the candidate artifact by the requested version, not by position', () => {
    expect(source).toContain('startswith(\\"ai-limit-ledger-${RELEASE_VERSION}-rc-\\")');
    expect(source).toContain('no release-candidate artifact for $RELEASE_VERSION found');
  });

  it('requires the candidate artifact to contain exactly the five expected files', () => {
    expect(source).toContain('candidate artifact contents do not match the expected file set');
    for (const name of [
      'ai-limit-ledger-${RELEASE_VERSION}.vsix',
      'SHA256SUMS.txt',
      'release-manifest.json',
      'sbom.cdx.json',
      'RELEASE_NOTES.md',
    ]) {
      expect(source, name).toContain(name);
    }
  });
});

describe('Task 14.1: finalize-release artifact integrity', () => {
  it('recomputes the VSIX SHA-256 rather than trusting the recorded one', () => {
    expect(source).toContain('computed_sha="$(sha256sum "$vsix" | awk \'{print $1}\')"');
  });

  it('requires the recomputed hash to match SHA256SUMS.txt', () => {
    expect(source).toContain('[ "$computed_sha" = "$recorded_sha" ]');
    expect(source).toContain('does not match SHA256SUMS.txt');
  });

  it('requires the recomputed hash to match the release manifest', () => {
    expect(source).toContain('[ "$computed_sha" = "$manifest_sha" ]');
    expect(source).toContain('does not match release-manifest.json');
  });

  it('requires the manifest version to equal the validated version input', () => {
    expect(source).toContain('[ "$manifest_version" = "$RELEASE_VERSION" ]');
  });

  it('requires the manifest commit to equal the commit_sha input', () => {
    expect(source).toContain('[ "$manifest_commit" = "$COMMIT_SHA" ]');
  });

  it('requires the manifest publisher and extension ID to be the expected identity', () => {
    expect(source).toContain('[ "$manifest_publisher" = "$EXPECTED_PUBLISHER" ]');
    expect(source).toContain('[ "$manifest_extension_id" = "$EXPECTED_EXTENSION_ID" ]');
    expect(source).toContain('EXPECTED_PUBLISHER: fatihdumlupinar-dev');
    expect(source).toContain('EXPECTED_EXTENSION_ID: fatihdumlupinar-dev.ai-limit-ledger');
  });

  it('re-runs the VSIX release audit on the downloaded artifact', () => {
    expect(source).toContain('node scripts/release-audit.mjs "$VSIX_PATH"');
  });
});

describe('Task 14.1: finalize-release tag and release idempotency', () => {
  it('leaves an existing release ref alone when it already points at the right commit', () => {
    expect(source).toContain('already exists and matches commit_sha; leaving it untouched');
  });

  it('fails closed when an existing release ref points at a different commit', () => {
    expect(source).toContain('refusing to move it');
    expect(source).not.toContain('--force');
    expect(source).not.toContain('--clobber');
    expect(source).not.toMatch(/gh release delete|git\s+push\s+.*--force|--delete/i);
  });

  it('resolves an annotated ref object through to its commit before comparing', () => {
    expect(source).toContain('if [ "$object_type" = "tag" ]');
    expect(source).toContain('git/tags/$object_sha');
  });

  it('creates the release as a version-titled pre-release from the candidate notes', () => {
    expect(source).toContain('--title "AI Limit Ledger $RELEASE_TAG (Preview)"');
    expect(source).toContain('--notes-file "$RC_DIR/RELEASE_NOTES.md"');
    expect(source).toContain('--prerelease');
  });

  it('verifies an existing release resolves to the same commit before touching it', () => {
    expect(source).toContain('[ "$release_commit" != "$COMMIT_SHA" ]');
    expect(source).toContain('will only add missing assets');
  });

  it('never overwrites an existing release asset, only adds missing ones', () => {
    expect(source).toContain('already present on release $RELEASE_TAG; skipping (no overwrite)');
    expect(source).toContain('grep -qxF "$base"');
  });
});

describe('Task 14.1: finalize-release remains publish-incapable', () => {
  it('requires the exact Marketplace listing URL and never writes to the Marketplace', () => {
    expect(source).toContain(EXPECTED_MARKETPLACE_URL);
    expect(source).toContain('[ "$INPUT_MARKETPLACE_URL" = "$EXPECTED_MARKETPLACE_URL" ]');
    expect(source).not.toMatch(/vsce\s+publish|vsce\s+login|ovsx\s+publish|npm\s+publish/i);
    expect(source).not.toMatch(/curl[^\n]*marketplace|POST[^\n]*gallery/i);
  });

  it('references no publishing credential, PAT, or OIDC flow of any shape', () => {
    for (const { name, pattern } of FORBIDDEN_PUBLISH_CREDENTIAL_PATTERNS as Array<{
      name: string;
      pattern: RegExp;
    }>) {
      expect(pattern.test(source), name).toBe(false);
    }
    expect(source).not.toMatch(/secrets\./);
    expect(source).toContain('github.token');
  });

  it('runs behind the production-release environment with minimal job-scoped permissions', () => {
    expect(finalize.environment).toBe('production-release');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(finalize.permissions).toEqual({ contents: 'write', actions: 'read' });
    expect(source).not.toMatch(/id-token:\s*write/);
  });

  it('never persists checkout credentials for a later step to reuse', () => {
    expect(source).toContain('persist-credentials: false');
  });
});
