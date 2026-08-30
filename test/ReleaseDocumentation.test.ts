import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const migration = readFileSync(resolve(ROOT, 'docs/INSTALLATION-MIGRATION-0.7.0.md'), 'utf8');
const rollback = readFileSync(resolve(ROOT, 'docs/ROLLBACK.md'), 'utf8');
const process_ = readFileSync(resolve(ROOT, 'docs/RELEASE-PROCESS.md'), 'utf8');
const status = readFileSync(resolve(ROOT, 'docs/FIRST-MARKETPLACE-RELEASE-0.7.0.md'), 'utf8');
const security = readFileSync(resolve(ROOT, 'SECURITY.md'), 'utf8');
const publishing = readFileSync(resolve(ROOT, 'PUBLISHING.md'), 'utf8');

describe('Task 14: installation migration documentation', () => {
  it('names both the old and new extension identities', () => {
    expect(migration).toContain('local.ai-limit-ledger');
    expect(migration).toContain('fatihdumlupinar-dev.ai-limit-ledger');
  });

  it('states that globalState/SecretStorage are not automatically migrated', () => {
    expect(migration).toMatch(/not\s+automatically\s+migrat/i);
    expect(migration).toContain('SecretStorage');
    expect(migration).toContain('globalState');
  });

  it('warns against installing both identities at once', () => {
    expect(migration).toMatch(/do not install both|not.{0,20}simultaneously|not supported/i);
    expect(migration).toMatch(/duplicate/i);
  });

  it('instructs re-running provider consent/repair flows under the new identity', () => {
    expect(migration).toMatch(/re-run|redo/i);
    expect(migration).toMatch(/consent/i);
  });

  it('documents a fallback if the migration goes wrong', () => {
    expect(migration).toMatch(/if something goes wrong/i);
  });

  it('does not perform a default-profile migration as part of this task', () => {
    expect(migration).toMatch(/does not.{0,40}default profile|separately/i);
  });
});

describe('Task 14: rollback documentation', () => {
  it('covers every required failure scenario', () => {
    for (const scenario of [
      /candidate.{0,20}(build|test|audit).{0,20}fail/i,
      /Marketplace upload validation failed/i,
      /Marketplace published.{0,60}before creating the tag/i,
      /tag was created but the GitHub Release/i,
      /critical runtime bug/i,
    ]) {
      expect(rollback).toMatch(scenario);
    }
  });

  it('asserts tag and release-asset immutability', () => {
    expect(rollback).toMatch(/immutable/i);
    expect(rollback).toMatch(/force-move/i);
  });

  it('states the Marketplace does not allow re-publishing the same version number', () => {
    expect(rollback).toMatch(/does not allow re-publishing the same version/i);
  });

  it('never automates a destructive rollback step', () => {
    expect(rollback).toMatch(
      /never automated|not something either workflow automates|not automated/i,
    );
    expect(rollback).not.toMatch(/gh release delete/i);
    expect(rollback).not.toMatch(/git tag -d|git push .*--delete/i);
  });

  it('never instructs unpublishing/removing a Marketplace version from a workflow', () => {
    expect(rollback).toMatch(/publisher portal/i);
    expect(rollback).not.toMatch(/workflow.{0,30}unpublish/i);
  });
});

describe('Task 14: release process documentation', () => {
  it('documents every step from PR merge through post-release smoke test', () => {
    for (const phrase of [
      /Merge the pull request/i,
      /release-candidate\.yml/,
      /SHA-256/,
      /Marketplace/,
      /production-release/,
      /finalize-release\.yml/,
      /smoke test/i,
    ]) {
      expect(process_).toMatch(phrase);
    }
  });

  it('states no PAT is created and explains why', () => {
    expect(process_).toMatch(/does not.{0,40}create.{0,20}PAT|no PAT/i);
  });
});

describe('Task 14: status tracker and SECURITY.md/PUBLISHING.md updates', () => {
  it('the 0.7.0 status document records the version and identity decisions', () => {
    expect(status).toContain('0.7.0');
    expect(status).toContain('fatihdumlupinar-dev.ai-limit-ledger');
    expect(status).toMatch(/preview/i);
  });

  it('SECURITY.md documents the release workflows and their permissions', () => {
    expect(security).toContain('release-candidate.yml');
    expect(security).toContain('finalize-release.yml');
    expect(security).toContain('production-release');
    expect(security).not.toMatch(/VSCE_PAT\s*[:=]\s*['"]?[A-Za-z0-9]/);
  });

  it('PUBLISHING.md no longer defers the release workflow to a future task', () => {
    expect(publishing).toContain('release-candidate.yml');
    expect(publishing).toContain('finalize-release.yml');
    expect(publishing).toMatch(/does not create a PAT|deliberately does not create/i);
  });
});
