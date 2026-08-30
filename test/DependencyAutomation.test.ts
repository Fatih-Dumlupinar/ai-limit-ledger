import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import {
  inspectWorkflow,
  parseYamlDocument,
  verifyRepository,
} from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const dependencySource = readFileSync(
  resolve(ROOT, '.github/workflows/dependency-review.yml'),
  'utf8',
);
const dependabotSource = readFileSync(resolve(ROOT, '.github/dependabot.yml'), 'utf8');
type YamlMap = Record<string, unknown>;
const dependency = inspectWorkflow('dependency-review.yml', dependencySource).document
  .value as YamlMap;
const dependabot = parseYamlDocument(dependabotSource).value as YamlMap;
const dependabotUpdates = dependabot.updates as YamlMap[];

describe('Dependency Review and Dependabot automation', () => {
  it('runs Dependency Review only for pull requests to main', () => {
    expect(dependency.name).toBe('Dependency Review');
    const triggers = dependency.on as YamlMap;
    const pullRequest = triggers.pull_request as YamlMap;
    expect(Object.keys(triggers)).toEqual(['pull_request']);
    expect(pullRequest.branches).toEqual(['main']);
  });

  it('uses contents read and fails at moderate severity', () => {
    expect(dependency.permissions).toEqual({ contents: 'read' });
    const jobs = dependency.jobs as YamlMap;
    const review = jobs.review as YamlMap;
    const steps = review.steps as YamlMap[];
    const options = steps[0].with as YamlMap;
    expect(options['fail-on-severity']).toBe('moderate');
  });

  it('does not add a speculative license denylist or PR write permission', () => {
    expect(dependencySource).not.toMatch(/deny-licenses|allow-licenses|pull-requests:\s*write/i);
    expect(dependencySource).not.toContain('comment-summary-in-pr: always');
  });

  it('uses the pinned official Dependency Review action', () => {
    expect(dependencySource).toContain(
      'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0',
    );
  });

  it('configures weekly npm Dependabot updates on main with a bounded PR limit', () => {
    const npm = dependabotUpdates.find((entry) => entry['package-ecosystem'] === 'npm') as YamlMap;
    expect(npm.directory).toBe('/');
    expect(npm['target-branch']).toBe('main');
    expect(npm.schedule.interval).toBe('weekly');
    expect(npm['open-pull-requests-limit']).toBe(5);
  });

  it('groups npm development minor and patch updates while leaving majors separate', () => {
    const npm = dependabotUpdates.find((entry) => entry['package-ecosystem'] === 'npm') as YamlMap;
    const groups = npm.groups as YamlMap;
    const group = groups['npm-development-minor-patch'] as YamlMap;
    expect(group['dependency-type']).toBe('development');
    expect(group['update-types']).toEqual(['minor', 'patch']);
    expect(JSON.stringify(group)).not.toContain('major');
  });

  it('ignores npm normal semver-major updates without disabling security updates', () => {
    const npm = dependabotUpdates.find((entry) => entry['package-ecosystem'] === 'npm') as YamlMap;
    expect(npm.ignore).toEqual([
      {
        'dependency-name': '*',
        'update-types': ['version-update:semver-major'],
      },
    ]);
    expect(dependabotSource).not.toMatch(/security-updates\s*:\s*false/i);
  });

  it('configures weekly GitHub Actions updates with SHA-friendly minor/patch grouping', () => {
    const actions = dependabotUpdates.find(
      (entry) => entry['package-ecosystem'] === 'github-actions',
    ) as YamlMap;
    const groups = actions.groups as YamlMap;
    const group = groups['github-actions-minor-patch'] as YamlMap;
    expect(actions.directory).toBe('/');
    expect(actions['target-branch']).toBe('main');
    expect(actions.schedule.interval).toBe('weekly');
    expect(group['update-types']).toEqual(['minor', 'patch']);
    expect(group.patterns).toEqual(['*']);
  });

  it('does not configure automatic merging and keeps runtime behavior out of CI policy', () => {
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const workflows = ['ci.yml', 'codeql.yml', 'secret-scan.yml', 'dependency-review.yml']
      .map((name) => readFileSync(resolve(ROOT, '.github/workflows', name), 'utf8'))
      .join('\n');
    expect(readFileSync(resolve(ROOT, '.github/dependabot.yml'), 'utf8')).not.toMatch(
      /auto[-_ ]?merge|merge-method/i,
    );
    expect(workflows).not.toMatch(/src[\\/]providers|from ['"][^'"]*providers/i);
    expect(packageJson.version).toBe('0.7.1');
    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(verifyRepository(ROOT).ok).toBe(true);
  });
});
