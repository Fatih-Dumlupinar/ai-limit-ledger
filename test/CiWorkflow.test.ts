import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import { inspectWorkflow } from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const source = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const { document } = inspectWorkflow('ci.yml', source);
type YamlMap = Record<string, unknown>;
const workflow = document.value as YamlMap;
const jobs = workflow.jobs as YamlMap;
const quality = jobs.quality as YamlMap;
const packageJob = jobs.package as YamlMap;
const qualityText = JSON.stringify(quality);
const packageText = JSON.stringify(packageJob);

describe('CI workflow', () => {
  it('has the stable CI name and main PR/push/manual triggers', () => {
    expect(workflow.name).toBe('CI');
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('runs quality on both Ubuntu and Windows', () => {
    const strategy = quality.strategy as YamlMap;
    const matrix = strategy.matrix as YamlMap;
    expect(matrix.os).toEqual(['ubuntu-latest', 'windows-latest']);
  });

  it('uses the repository Node 24 file and npm cache key', () => {
    expect(qualityText).toContain('node-version-file');
    expect(qualityText).toContain('.nvmrc');
    expect(qualityText).toContain('cache-dependency-path');
    expect(qualityText).toContain('package-lock.json');
  });

  it('runs every required quality command', () => {
    for (const command of [
      'npm ci',
      'npm run compile',
      'npm run lint',
      'npm run format:check',
      'npm run audit:release',
      'npm test',
    ]) {
      expect(qualityText).toContain(command);
    }
  });

  it('runs both moderate-level npm audits on Ubuntu', () => {
    expect(source).toContain('npm audit --audit-level=moderate');
    expect(source).toContain('npm audit --omit=dev --audit-level=moderate');
    expect(source).not.toContain('continue-on-error');
  });

  it('packages only after quality and audits the generated VSIX', () => {
    expect(packageJob.needs).toBe('quality');
    expect(packageText).toContain('npm run package');
    expect(packageText).toContain('audit:release');
  });

  it('uploads the VSIX with retention no greater than seven days', () => {
    expect(packageText).toContain('actions/upload-artifact');
    expect(
      (packageJob.steps as unknown[]).some((step) => {
        const withOptions = (step as YamlMap).with as YamlMap | undefined;
        const retention = withOptions?.['retention-days'];
        return typeof retention === 'number' && retention <= 7;
      }),
    ).toBe(true);
  });

  it('does not install, publish, release, or use repository secrets', () => {
    expect(source).not.toMatch(/npm install|npm publish|vsce publish|gh release|secrets\./i);
    expect(source).not.toContain('pull_request_target');
  });
});
