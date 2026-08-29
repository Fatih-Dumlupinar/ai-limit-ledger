import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import { inspectWorkflow } from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const source = readFileSync(resolve(ROOT, '.github/workflows/codeql.yml'), 'utf8');
const { document } = inspectWorkflow('codeql.yml', source);
type YamlMap = Record<string, unknown>;
const workflow = document.value as YamlMap;

describe('CodeQL workflow', () => {
  it('runs on main PRs, main pushes, weekly schedule, and manual dispatch', () => {
    expect(workflow.name).toBe('CodeQL');
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).toHaveProperty('schedule');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('uses the JavaScript/TypeScript language pack', () => {
    expect(source).toContain('languages: javascript-typescript');
  });

  it('uses build-mode none without a custom build or provider call', () => {
    expect(source).toContain('build-mode: none');
    expect(source).not.toMatch(/npm run|provider|src\/providers|secrets\./i);
  });

  it('uses only read contents and CodeQL security-events write permissions', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', 'security-events': 'write' });
    expect(source).not.toContain('write-all');
  });

  it('keeps scheduled analysis on the default main branch', () => {
    expect(source).toContain("github.event_name != 'schedule' || github.ref == 'refs/heads/main'");
    const jobs = workflow.jobs as YamlMap;
    const analyze = jobs.analyze as YamlMap;
    expect(analyze['timeout-minutes']).toBeGreaterThan(0);
  });
});
