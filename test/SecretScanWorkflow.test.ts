import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module, no type declarations
import {
  checkGitleaksConfig,
  GITLEAKS_RELEASE,
  inspectWorkflow,
} from '../scripts/verify-workflows.mjs';

const ROOT = resolve(__dirname, '..');
const source = readFileSync(resolve(ROOT, '.github/workflows/secret-scan.yml'), 'utf8');
const { document } = inspectWorkflow('secret-scan.yml', source);
type YamlMap = Record<string, unknown>;
const workflow = document.value as YamlMap;

describe('independent secret scan workflow', () => {
  it('uses the expected name and safe PR/push/manual triggers', () => {
    expect(workflow.name).toBe('Secret Scan');
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(source).not.toContain('pull_request_target');
  });

  it('checks out the complete Git history and does not use a broad path allowlist', () => {
    expect(source).toContain('fetch-depth: 0');
    expect(workflow.on.pull_request).not.toHaveProperty('paths');
    expect(workflow.on.push).not.toHaveProperty('paths');
  });

  it('pins the official Linux release asset and its recorded SHA-256', () => {
    expect(source).toContain(`v${GITLEAKS_RELEASE.version}/${GITLEAKS_RELEASE.archive}`);
    expect(source).toContain(GITLEAKS_RELEASE.sha256);
    expect(source).toContain('gitleaks_8.30.1_checksums.txt');
  });

  it('verifies the official checksum before extracting the binary', () => {
    expect(source).toContain('sha256sum --check --status');
    expect(source).toContain('test "$checksum" = "$GITLEAKS_SHA256"');
    expect(source).toContain('tar -xzf');
  });

  it('scans the complete source with redaction and a failing exit code', () => {
    expect(source).toContain('git "$GITHUB_WORKSPACE"');
    expect(source).toContain('--config "$GITHUB_WORKSPACE/.gitleaks.toml"');
    expect(source).toContain('--redact');
    expect(source).toContain('--report-format sarif');
    expect(source).toContain('--exit-code 1');
  });

  it('uploads only the redacted report with bounded retention', () => {
    expect(source).toContain('gitleaks.sarif');
    expect(source).toContain('if-no-files-found: ignore');
    expect(source).toContain('retention-days: 7');
  });

  it('uses only a narrow historical fixture allowlist and excludes it from the VSIX', () => {
    const config = readFileSync(resolve(ROOT, '.gitleaks.toml'), 'utf8');
    const vscodeIgnore = readFileSync(resolve(ROOT, '.vscodeignore'), 'utf8');
    expect(config).toContain('useDefault = true');
    expect(config).toContain('^test/ReleaseAudit\\.test\\.ts$');
    expect(config).toContain('AK(?:IA)ABCDEFGHIJKLMNOP');
    expect(config).not.toMatch(/src\/\*\*|docs\/\*\*|test\/\*\*/);
    expect(vscodeIgnore.split(/\r?\n/)).toContain('.gitleaks.toml');
  });

  it('rejects a broad source-tree Gitleaks allowlist', () => {
    const errors = checkGitleaksConfig(`
useDefault = true
[[allowlists]]
paths = ['''^src/**$''']
`);
    expect(errors).toContain('broad Gitleaks path allowlists are forbidden');
  });

  it('has no credentials, release publishing, or runtime/provider imports', () => {
    expect(source).not.toMatch(/secrets\.|npm publish|vsce publish|src\/providers|C:\\Users\\/i);
  });
});
