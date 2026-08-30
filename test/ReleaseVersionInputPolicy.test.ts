import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STRICT_SEMVER_SOURCE,
  STRICT_SEMVER_SHELL_PATTERN,
  isStrictReleaseVersion,
  buildMarketplaceConfirmation,
  MARKETPLACE_CONFIRMATION_PREFIX,
  inspectWorkflow,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const candidate = readFileSync(resolve(ROOT, '.github/workflows/release-candidate.yml'), 'utf8');
const finalize = readFileSync(resolve(ROOT, '.github/workflows/finalize-release.yml'), 'utf8');

/**
 * The workflows validate their `version` input in a POSIX shell with `grep -Eq` against the exact
 * pattern exported as STRICT_SEMVER_SHELL_PATTERN. `isStrictReleaseVersion` is the same grammar
 * expressed as a pure predicate, so the accept/reject table below is testable directly rather than
 * only structurally — and the workflows are separately asserted to still carry the literal
 * pattern, so the two can never silently drift apart.
 */
describe('Task 14.1: strict release version grammar', () => {
  it('is the same anchored pattern the shell steps use', () => {
    expect(STRICT_SEMVER_SOURCE).toBe('^[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(STRICT_SEMVER_SHELL_PATTERN).toBe("'^[0-9]+\\.[0-9]+\\.[0-9]+$'");
  });

  it('accepts a plain patch version', () => {
    expect(isStrictReleaseVersion('0.7.1')).toBe(true);
  });

  it('accepts a minor version bump', () => {
    expect(isStrictReleaseVersion('0.8.0')).toBe(true);
  });

  it('accepts a major version bump and multi-digit parts', () => {
    expect(isStrictReleaseVersion('1.0.0')).toBe(true);
    expect(isStrictReleaseVersion('2.4.12')).toBe(true);
    expect(isStrictReleaseVersion('10.20.30')).toBe(true);
  });

  it('rejects a v-prefixed version', () => {
    expect(isStrictReleaseVersion('v0.7.1')).toBe(false);
  });

  it('rejects a two-part version', () => {
    expect(isStrictReleaseVersion('0.7')).toBe(false);
    expect(isStrictReleaseVersion('1')).toBe(false);
  });

  it('rejects a prerelease suffix', () => {
    expect(isStrictReleaseVersion('0.7.1-beta')).toBe(false);
    expect(isStrictReleaseVersion('0.7.1-rc.1')).toBe(false);
  });

  it('rejects build metadata', () => {
    expect(isStrictReleaseVersion('0.7.1+build')).toBe(false);
    expect(isStrictReleaseVersion('0.7.1+20260830')).toBe(false);
  });

  it('rejects symbolic refs and empty input', () => {
    for (const value of ['latest', 'main', 'HEAD', '', '   ']) {
      expect(isStrictReleaseVersion(value), value).toBe(false);
    }
  });

  it('rejects any value carrying a shell metacharacter', () => {
    for (const value of [
      '0.7.1;rm -rf /',
      '0.7.1 && curl evil',
      '0.7.1|tee',
      '$(id)',
      '`id`',
      '0.7.1\nrm',
      '../../etc/passwd',
      '0.7.1/../0.7.0',
      "0.7.1'",
      '0.7.1"',
    ]) {
      expect(isStrictReleaseVersion(value), value).toBe(false);
    }
  });

  it('rejects surrounding whitespace, so an anchored match cannot be smuggled past', () => {
    expect(isStrictReleaseVersion(' 0.7.1')).toBe(false);
    expect(isStrictReleaseVersion('0.7.1 ')).toBe(false);
  });

  it('rejects a non-string value outright', () => {
    expect(isStrictReleaseVersion(undefined as unknown as string)).toBe(false);
    expect(isStrictReleaseVersion(7 as unknown as string)).toBe(false);
  });
});

describe('Task 14.1: derived Marketplace confirmation phrase', () => {
  it('derives the phrase from the version rather than freezing one release', () => {
    expect(buildMarketplaceConfirmation('0.7.1')).toBe('I_HAVE_VERIFIED_MARKETPLACE_0.7.1');
    expect(buildMarketplaceConfirmation('1.0.0')).toBe('I_HAVE_VERIFIED_MARKETPLACE_1.0.0');
    expect(MARKETPLACE_CONFIRMATION_PREFIX).toBe('I_HAVE_VERIFIED_MARKETPLACE_');
  });

  it('refuses to build a phrase for a version that has not passed the strict gate', () => {
    for (const value of ['v0.7.1', '0.7', '0.7.1-beta', 'latest', '']) {
      expect(() => buildMarketplaceConfirmation(value), value).toThrow(
        /strict major\.minor\.patch/,
      );
    }
  });
});

describe('Task 14.1: release-candidate.yml is version-generic', () => {
  it('validates the version input against the exact strict pattern before using it', () => {
    expect(candidate).toContain(STRICT_SEMVER_SHELL_PATTERN);
    const validationIndex = candidate.indexOf(STRICT_SEMVER_SHELL_PATTERN);
    // Nothing may consume the version before it has been validated.
    expect(validationIndex).toBeGreaterThan(-1);
    expect(candidate.indexOf('RELEASE_VERSION=$INPUT_VERSION')).toBeGreaterThan(validationIndex);
    expect(candidate.indexOf('docs/RELEASE-NOTES-${RELEASE_VERSION}.md')).toBeGreaterThan(
      validationIndex,
    );
  });

  it('carries no hardcoded release version constant anywhere', () => {
    expect(candidate).not.toMatch(/EXPECTED_VERSION:\s*\d+\.\d+\.\d+/);
    expect(candidate).not.toMatch(/TAG_NAME:\s*v\d+\.\d+\.\d+/);
    const { errors } = inspectWorkflow('release-candidate.yml', candidate);
    expect(errors as string[]).toEqual([]);
  });

  it('names the artifact dynamically from the version and short commit SHA', () => {
    expect(candidate).toContain(
      'name: ai-limit-ledger-${{ env.RELEASE_VERSION }}-rc-${{ env.SHORT_SHA }}',
    );
    expect(candidate).not.toMatch(/name:\s*ai-limit-ledger-\d+\.\d+\.\d+-rc-/);
  });

  it('resolves the release notes path dynamically, only from the validated version', () => {
    expect(candidate).toContain('cp "docs/RELEASE-NOTES-${RELEASE_VERSION}.md" RELEASE_NOTES.md');
    expect(candidate).not.toMatch(/docs\/RELEASE-NOTES-\d+\.\d+\.\d+\.md/);
  });

  it('verifies the manifest, lockfile, and lockfile root all match the requested version', () => {
    expect(candidate).toContain('const expectedVersion = process.env.RELEASE_VERSION');
    expect(candidate).toContain('lock.packages[""].version !== expectedVersion');
    expect(candidate).toContain('pkg.preview !== true');
    expect(candidate).toContain('pkg.private !== true');
    expect(candidate).toContain('EXPECTED_PUBLISHER');
    expect(candidate).toContain('EXPECTED_NAME');
  });

  it('requires a changelog section, a non-empty release notes file, and a kept [Unreleased]', () => {
    expect(candidate).toContain('CHANGELOG.md');
    expect(candidate).toContain('has no "## ${version}" section heading');
    expect(candidate).toContain('is missing');
    expect(candidate).toContain('is empty');
    expect(candidate).toContain('[Unreleased]');
  });

  it('refuses to build a candidate when the release ref already exists', () => {
    expect(candidate).toContain('refs/tags/$RELEASE_TAG');
    expect(candidate).toMatch(/refusing to build a candidate for a released version/);
  });

  it('never publishes to the Marketplace and never mentions a publishing credential', () => {
    expect(candidate).not.toMatch(/vsce\s+publish|vsce\s+login|npm\s+publish|VSCE_PAT|--oidc/i);
    expect(candidate).not.toMatch(/marketplace\.visualstudio/i);
    expect(candidate).not.toMatch(/secrets\./);
  });

  it('never creates a ref, a release, a commit, or a push', () => {
    expect(candidate).not.toMatch(/\bgit\s+(?:tag|commit|push)\b/i);
    expect(candidate).not.toMatch(/gh\s+release/i);
    expect(candidate).not.toMatch(/gh\s+api/i);
  });

  it('passes every dispatch input through env: and never into a run: body', () => {
    const runBlocks =
      candidate.match(/run:\s*\|[\s\S]*?(?=\n\s{2,}- name:|\n\s{2,}- uses:|$)/g) ?? [];
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{\s*inputs\./);
      expect(block).not.toMatch(/\$\{\{\s*github\.(event|sha|ref|ref_name|actor)/);
    }
    expect(candidate).toContain('INPUT_VERSION: ${{ inputs.version }}');
  });
});

describe('Task 14.1: finalize-release.yml is version-generic', () => {
  it('validates the version input against the same strict pattern', () => {
    expect(finalize).toContain(STRICT_SEMVER_SHELL_PATTERN);
  });

  it('carries no hardcoded release version constant anywhere', () => {
    expect(finalize).not.toMatch(/EXPECTED_VERSION:\s*\d+\.\d+\.\d+/);
    expect(finalize).not.toMatch(/TAG_NAME:\s*v\d+\.\d+\.\d+/);
    const { errors } = inspectWorkflow('finalize-release.yml', finalize);
    expect(errors as string[]).toEqual([]);
  });

  it('derives both the release ref name and the confirmation phrase from the validated version', () => {
    expect(finalize).toContain('echo "RELEASE_TAG=v$INPUT_VERSION" >> "$GITHUB_ENV"');
    expect(finalize).toContain('expected_confirmation="${CONFIRMATION_PREFIX}${INPUT_VERSION}"');
  });
});
