#!/usr/bin/env node
/**
 * Builds the release-candidate manifest for AI Limit Ledger (Task 14).
 *
 * Design constraints (matching scripts/release-audit.mjs and scripts/generate-sbom.mjs):
 * - No new dependency: Node built-ins only.
 * - No network access.
 * - Never writes a user path, credential, token, or runner-temp path into the manifest — only the
 *   safe fields listed in docs/RELEASE-PROCESS.md.
 *
 * Reads its inputs from environment variables (set by the calling workflow step) plus a vitest
 * JSON reporter file and the packaged VSIX, and writes a single release-manifest.json.
 *
 * Required environment variables:
 *   RELEASE_VSIX_PATH        - path to the packaged .vsix file
 *   RELEASE_VITEST_JSON_PATH - path to a `vitest run --reporter=json` output file
 *   RELEASE_GIT_COMMIT       - full commit SHA the candidate was built from
 *   RELEASE_NODE_VERSION     - `node --version` output
 *   RELEASE_NPM_VERSION      - `npm --version` output
 *   RELEASE_WORKFLOW_RUN_ID  - GitHub Actions run id
 *   RELEASE_REPOSITORY       - "owner/repo"
 *   RELEASE_AUDIT_ALL_JSON   - path to a `npm audit --json` output file (all dependencies)
 *   RELEASE_AUDIT_PROD_JSON  - path to a `npm audit --omit=dev --json` output file
 *
 * Usage:
 *   node scripts/generate-release-manifest.mjs <output-file.json>
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Minimal ZIP central-directory entry count reader (kept in sync in spirit with
// scripts/release-audit.mjs's readZipEntries, duplicated here to avoid a workflow-time import of
// the audit script's larger surface for a single count).
function countZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1)
    throw new Error('not a valid ZIP/VSIX: End Of Central Directory not found');
  return buffer.readUInt16LE(eocdOffset + 10);
}

function summarizeAudit(auditJsonPath) {
  const raw = JSON.parse(readFileSync(auditJsonPath, 'utf8'));
  const vulnerabilities = raw.metadata?.vulnerabilities ?? {};
  return {
    total: vulnerabilities.total ?? 0,
    critical: vulnerabilities.critical ?? 0,
    high: vulnerabilities.high ?? 0,
    moderate: vulnerabilities.moderate ?? 0,
    low: vulnerabilities.low ?? 0,
  };
}

export function buildManifest({ pkg, vsixPath, vitestJsonPath, auditAllPath, auditProdPath, env }) {
  const vsixBuffer = readFileSync(vsixPath);
  const vitestReport = JSON.parse(readFileSync(vitestJsonPath, 'utf8'));

  return {
    version: pkg.version,
    publisher: pkg.publisher,
    extensionId: `${pkg.publisher}.${pkg.name}`,
    gitCommit: env.RELEASE_GIT_COMMIT,
    nodeVersion: env.RELEASE_NODE_VERSION,
    npmVersion: env.RELEASE_NPM_VERSION,
    package: {
      filename: path.basename(vsixPath),
      sha256: sha256(vsixBuffer),
      sizeBytes: statSync(vsixPath).size,
      fileCount: countZipEntries(vsixBuffer),
    },
    tests: {
      fileCount: vitestReport.numTotalTestSuites ?? 0,
      testCount: vitestReport.numTotalTests ?? 0,
    },
    audit: {
      all: summarizeAudit(auditAllPath),
      productionOnly: summarizeAudit(auditProdPath),
    },
    buildTimestampUtc: new Date().toISOString(),
    workflowRunId: env.RELEASE_WORKFLOW_RUN_ID,
    repository: env.RELEASE_REPOSITORY,
  };
}

function main() {
  const outputArg = process.argv[2];
  if (!outputArg) {
    console.error('Usage: node scripts/generate-release-manifest.mjs <output-file.json>');
    process.exitCode = 2;
    return;
  }

  const env = {
    RELEASE_GIT_COMMIT: requireEnv('RELEASE_GIT_COMMIT'),
    RELEASE_NODE_VERSION: requireEnv('RELEASE_NODE_VERSION'),
    RELEASE_NPM_VERSION: requireEnv('RELEASE_NPM_VERSION'),
    RELEASE_WORKFLOW_RUN_ID: requireEnv('RELEASE_WORKFLOW_RUN_ID'),
    RELEASE_REPOSITORY: requireEnv('RELEASE_REPOSITORY'),
  };

  const pkg = readJson('package.json');
  const vsixPath = requireEnv('RELEASE_VSIX_PATH');
  const vitestJsonPath = requireEnv('RELEASE_VITEST_JSON_PATH');
  const auditAllPath = requireEnv('RELEASE_AUDIT_ALL_JSON');
  const auditProdPath = requireEnv('RELEASE_AUDIT_PROD_JSON');

  const manifest = buildManifest({
    pkg,
    vsixPath: path.isAbsolute(vsixPath) ? vsixPath : path.join(ROOT, vsixPath),
    vitestJsonPath: path.isAbsolute(vitestJsonPath)
      ? vitestJsonPath
      : path.join(ROOT, vitestJsonPath),
    auditAllPath: path.isAbsolute(auditAllPath) ? auditAllPath : path.join(ROOT, auditAllPath),
    auditProdPath: path.isAbsolute(auditProdPath) ? auditProdPath : path.join(ROOT, auditProdPath),
    env,
  });

  const outPath = path.isAbsolute(outputArg) ? outputArg : path.join(ROOT, outputArg);
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Release manifest written to ${outputArg}.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(
      'generate-release-manifest failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
}
