#!/usr/bin/env node
/**
 * Minimal, dependency-free CycloneDX-shaped SBOM generator for AI Limit Ledger.
 *
 * Design constraints (Task 14, matching scripts/release-audit.mjs):
 * - No new dependency: uses only Node built-ins and package-lock.json.
 * - No network access.
 * - Read-only with respect to the source tree; only ever writes the output file it is told to.
 * - Never prints or embeds a credential/token value.
 *
 * This is intentionally a minimal, self-contained CycloneDX 1.5 JSON document covering the
 * component list resolved by package-lock.json. It does not attempt full CycloneDX spec
 * coverage (licenses, hashes per dependency, etc.) — it exists to give the release candidate a
 * machine-readable dependency inventory, not to replace a dedicated SBOM tool.
 *
 * Usage:
 *   node scripts/generate-sbom.mjs <output-file.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function purlFor(name, version) {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).replace('/', '%2F')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

export function buildSbom(pkg, lock) {
  const components = [];
  const seen = new Set();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '' || !entry || typeof entry !== 'object') continue;
    const name = entry.name ?? key.replace(/^(?:.*\/)?node_modules\//, '');
    const version = entry.version;
    if (!name || !version) continue;
    const dedupeKey = `${name}@${version}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    components.push({
      type: 'library',
      name,
      version,
      purl: purlFor(name, version),
      scope: entry.dev ? 'optional' : 'required',
    });
  }
  components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: 'ai-limit-ledger',
          name: 'scripts/generate-sbom.mjs',
          version: pkg.version,
        },
      ],
      component: {
        type: 'application',
        name: pkg.name,
        version: pkg.version,
        purl: purlFor(pkg.name, pkg.version),
      },
    },
    components,
  };
}

function main() {
  const outputArg = process.argv[2];
  if (!outputArg) {
    console.error('Usage: node scripts/generate-sbom.mjs <output-file.json>');
    process.exitCode = 2;
    return;
  }
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const sbom = buildSbom(pkg, lock);
  const outPath = path.isAbsolute(outputArg) ? outputArg : path.join(ROOT, outputArg);
  writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  console.log(`SBOM written to ${outputArg} (${sbom.components.length} components).`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
