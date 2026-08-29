import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import {
  ACTION_RELEASES,
  checkActionReference,
  inspectWorkflow,
  parseYamlDocument,
  verifyRepository,
} from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const SHA = ACTION_RELEASES['actions/checkout'].sha;

function minimalWorkflow(overrides = ''): string {
  return `name: Dependency Review
on:
  pull_request:
    branches:
      - main
permissions:
  contents: read
concurrency:
  group: test-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Check
        uses: actions/checkout@${SHA} # v7.0.1
${overrides}`;
}

describe('workflow policy parser and action references', () => {
  it('parses nested maps, arrays, booleans, and block scalars structurally', () => {
    const document = parseYamlDocument(`name: Sample
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  check:
    timeout-minutes: 5
    steps:
      - name: Run
        run: |
          set -euo pipefail
          npm ci
`);
    expect(document.value).toMatchObject({
      name: 'Sample',
      jobs: {
        check: {
          'timeout-minutes': 5,
          steps: [{ name: 'Run', run: 'set -euo pipefail\nnpm ci\n' }],
        },
      },
    });
    expect(document.locations.some((location: { key: string }) => location.key === 'run')).toBe(
      true,
    );
  });

  it('accepts a full 40-character SHA with a release comment', () => {
    expect(checkActionReference(`actions/checkout@${SHA}`, '# v7.0.1').ok).toBe(true);
  });

  it('rejects a short SHA', () => {
    expect(checkActionReference('actions/checkout@0123456789abcdef', '# v7.0.1').ok).toBe(false);
  });

  it('rejects mutable tags and major-only tags', () => {
    expect(checkActionReference('actions/checkout@main', '# v7.0.1').ok).toBe(false);
    expect(checkActionReference('actions/checkout@v7', '# v7').ok).toBe(false);
  });

  it('rejects a pinned action without a version comment', () => {
    expect(checkActionReference(`actions/checkout@${SHA}`, '').ok).toBe(false);
  });

  it('rejects an unapproved action repository or release commit', () => {
    expect(checkActionReference(`evil/checkout@${SHA}`, '# v7.0.1').ok).toBe(false);
    expect(checkActionReference(`actions/checkout@${'f'.repeat(40)}`, '# v7.0.1').ok).toBe(false);
  });

  it('rejects pull_request_target structurally wherever it appears', () => {
    const result = inspectWorkflow(
      'dependency-review.yml',
      minimalWorkflow('pull_request_target: true\n'),
    );
    expect(result.errors.some((error: string) => error.includes('pull_request_target'))).toBe(true);
  });

  it('rejects write permissions outside the CodeQL security-events permission', () => {
    const result = inspectWorkflow(
      'dependency-review.yml',
      minimalWorkflow('').replace('contents: read', 'contents: write'),
    );
    expect(result.errors.some((error: string) => error.includes('write permission'))).toBe(true);
  });

  it('rejects repository secret references', () => {
    const result = inspectWorkflow(
      'dependency-review.yml',
      minimalWorkflow('env:\n  CHECK: ${{ secrets.CHECK }}\n'),
    );
    expect(result.errors.some((error: string) => error.includes('repository secrets'))).toBe(true);
  });

  it('rejects direct interpolation of untrusted event input into a shell command', () => {
    const result = inspectWorkflow(
      'dependency-review.yml',
      minimalWorkflow('      - run: echo "${{ github.event.pull_request.title }}"\n'),
    );
    expect(result.errors.some((error: string) => error.includes('untrusted event/input'))).toBe(
      true,
    );
  });

  it('requires branch/ref-based concurrency and positive job timeouts', () => {
    const result = inspectWorkflow(
      'dependency-review.yml',
      `name: Dependency Review
on:
  pull_request:
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 0
`,
    );
    expect(result.errors.some((error: string) => error.includes('concurrency'))).toBe(true);
    expect(result.errors.some((error: string) => error.includes('timeout-minutes'))).toBe(true);
  });

  it('accepts the complete repository workflow policy', () => {
    const result = verifyRepository(ROOT);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not allow a non-secret workflow to request fetch-depth zero', () => {
    const result = inspectWorkflow(
      'dependency-review.yml',
      minimalWorkflow('        with:\n          fetch-depth: 0\n'),
    );
    expect(result.errors.some((error: string) => error.includes('fetch-depth'))).toBe(true);
  });

  it('keeps all action references on the approved release SHA set', () => {
    const result = verifyRepository(ROOT);
    expect(result.errors.filter((error: string) => error.includes('full 40-character'))).toEqual(
      [],
    );
    const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  });
});
