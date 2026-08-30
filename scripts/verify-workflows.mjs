#!/usr/bin/env node
/**
 * Dependency-free structural policy verifier for the repository's GitHub
 * Actions and Dependabot configuration.
 *
 * This intentionally implements the small YAML subset used by these files
 * instead of adding a parser dependency to the extension. It retains key
 * locations and comments, so policy checks are structural and diagnostics can
 * identify the relevant line without echoing a credential-shaped value.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EXPECTED_WORKFLOWS = [
  'ci.yml',
  'codeql.yml',
  'secret-scan.yml',
  'dependency-review.yml',
  'release-candidate.yml',
  'finalize-release.yml',
];

export const ACTION_RELEASES = Object.freeze({
  'actions/checkout': { tag: 'v7.0.1', sha: '3d3c42e5aac5ba805825da76410c181273ba90b1' },
  'actions/setup-node': { tag: 'v7.0.0', sha: '820762786026740c76f36085b0efc47a31fe5020' },
  'actions/upload-artifact': {
    tag: 'v7.0.1',
    sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  },
  'github/codeql-action': { tag: 'v4.37.9', sha: 'cdf488f595d80d6e07e03d4674febd5ab45fa938' },
  'actions/dependency-review-action': {
    tag: 'v5.0.0',
    sha: 'a1d282b36b6f3519aa1f3fc636f609c47dddb294',
  },
  'actions/attest-build-provenance': {
    tag: 'v4.2.2',
    sha: '4d101475d8b20a2381f78447822ac1eab6504dd8',
  },
});

export const GITLEAKS_RELEASE = Object.freeze({
  version: '8.30.1',
  archive: 'gitleaks_8.30.1_linux_x64.tar.gz',
  sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
});

const WORKFLOW_NAMES = {
  'ci.yml': 'CI',
  'codeql.yml': 'CodeQL',
  'secret-scan.yml': 'Secret Scan',
  'dependency-review.yml': 'Dependency Review',
  'release-candidate.yml': 'Release Candidate',
  'finalize-release.yml': 'Finalize Release',
};

/**
 * The single strict version grammar shared by both release workflows (Task 14.1).
 *
 * Both `release-candidate.yml` and `finalize-release.yml` validate their `version` dispatch input
 * against this exact anchored pattern in a shell step, before the value is used to build a file
 * path, a jq filter, an artifact name, a ref name, or a confirmation phrase. It is exported here
 * so the policy verifier can assert that the literal pattern is still present in each workflow,
 * and so tests can exercise the accept/reject behaviour directly instead of only structurally.
 *
 * Accepts exactly `major.minor.patch` (0.7.1, 1.0.0, 2.4.12). Rejects a `v` prefix, a two-part
 * `0.7`, any prerelease (`-beta`) or build-metadata (`+build`) suffix, `latest`/`main`, the empty
 * string, leading/trailing whitespace, and anything carrying a shell metacharacter.
 */
export const STRICT_SEMVER_SOURCE = '^[0-9]+\\.[0-9]+\\.[0-9]+$';

/** The literal ERE text both workflows must contain, so a weakened regex is caught structurally. */
export const STRICT_SEMVER_SHELL_PATTERN = "'^[0-9]+\\.[0-9]+\\.[0-9]+$'";

/** Pure predicate mirroring the workflows' shell-side `grep -Eq` gate. */
export function isStrictReleaseVersion(value) {
  if (typeof value !== 'string') return false;
  return new RegExp(STRICT_SEMVER_SOURCE).test(value);
}

/** The Marketplace confirmation phrase is derived, never hardcoded — see finalize-release.yml. */
export const MARKETPLACE_CONFIRMATION_PREFIX = 'I_HAVE_VERIFIED_MARKETPLACE_';

/**
 * Builds the exact confirmation phrase a human must type to finalize `version`.
 * Refuses to build a phrase for a version that has not passed the strict gate, so a malformed
 * version can never be smuggled through the phrase comparison.
 */
export function buildMarketplaceConfirmation(version) {
  if (!isStrictReleaseVersion(version)) {
    throw new Error('confirmation phrase requires a strict major.minor.patch version');
  }
  return `${MARKETPLACE_CONFIRMATION_PREFIX}${version}`;
}

export const EXPECTED_MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger';

/** Credential/publishing identifiers that must never appear in any workflow in this repository. */
export const FORBIDDEN_PUBLISH_CREDENTIAL_PATTERNS = [
  { name: 'VSCE_PAT', pattern: /VSCE_PAT/i },
  { name: 'Azure DevOps PAT', pattern: /AZURE_DEVOPS_(?:EXT_)?PAT|ADO_PAT/i },
  {
    name: 'Marketplace/publisher token',
    pattern: /MARKETPLACE_(?:TOKEN|PAT)|PUBLISHER_(?:TOKEN|PAT)/i,
  },
  { name: 'OpenVSX token', pattern: /OVSX_PAT|OPEN_?VSX_TOKEN/i },
  { name: 'vsce login', pattern: /vsce\s+login/i },
  { name: 'OIDC publish flag', pattern: /--oidc\b/i },
  { name: 'Azure federated login', pattern: /azure\/login|azure-credentials|managed[-_]identity/i },
];

// These two release workflows are manually dispatched only — never on pull_request/push/schedule
// — so they are checked against an exact single-trigger allowlist, the same way
// dependency-review.yml is restricted to pull_request only (see validateTriggers).
export const WORKFLOW_DISPATCH_ONLY_WORKFLOWS = ['release-candidate.yml', 'finalize-release.yml'];

function lineIndent(raw) {
  const match = raw.match(/^ */);
  return match ? match[0].length : 0;
}

function findCommentStart(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "'") {
      if (char === "'" && value[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) return index;
  }
  return -1;
}

function splitComment(value) {
  const index = findCommentStart(value);
  if (index === -1) return { value: value.trim(), comment: '' };
  return { value: value.slice(0, index).trim(), comment: value.slice(index).trim() };
}

function splitTopLevel(value, delimiter) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "'") {
      if (char === "'" && value[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('Invalid double-quoted scalar');
    }
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitTopLevel(value.slice(1, -1), ',').map(parseScalar);
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const result = {};
    for (const pair of splitTopLevel(value.slice(1, -1), ',')) {
      const colon = pair.indexOf(':');
      if (colon < 1) throw new Error('Invalid inline map');
      result[pair.slice(0, colon).trim()] = parseScalar(pair.slice(colon + 1));
    }
    return result;
  }
  return value;
}

function nextMeaningful(lines, index) {
  let cursor = index;
  while (cursor < lines.length && lines[cursor].content === '') cursor += 1;
  return cursor;
}

function splitKeyValue(content) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote === "'") {
      if (char === "'" && content[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (
      char === ':' &&
      depth === 0 &&
      (index + 1 === content.length || /\s/.test(content[index + 1]))
    ) {
      return { key: parseScalar(content.slice(0, index)), rest: content.slice(index + 1).trim() };
    }
  }
  return null;
}

/**
 * Parses the YAML subset used by repository policy files.
 * @returns {{ value: unknown, locations: Array<{key: string, value: unknown, line: number, comment: string}> }}
 */
export function parseYamlDocument(source) {
  const lines = source.split(/\r?\n/).map((raw, index) => {
    const noComment = splitComment(raw.trimStart());
    return {
      raw,
      indent: lineIndent(raw),
      content: noComment.value,
      comment: noComment.comment,
      line: index + 1,
    };
  });
  const locations = [];

  function parseBlock(start, indent, pathParts) {
    const first = nextMeaningful(lines, start);
    if (first >= lines.length || lines[first].indent < indent) return [null, first];
    if (lines[first].indent !== indent)
      throw new Error(`Unexpected indentation at line ${lines[first].line}`);
    const isArray = lines[first].content === '-' || lines[first].content.startsWith('- ');
    return isArray ? parseArray(first, indent, pathParts) : parseMap(first, indent, pathParts);
  }

  function parseBlockScalar(start, parentIndent, folded) {
    const values = [];
    let cursor = start;
    let scalarIndent = null;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.content !== '' && line.indent <= parentIndent) break;
      if (line.content === '') values.push('');
      else {
        scalarIndent ??= line.indent;
        values.push(line.raw.slice(scalarIndent));
      }
      cursor += 1;
    }
    return [folded ? values.join(' ').replace(/ +\n/g, '\n') : values.join('\n'), cursor];
  }

  function parseMap(start, indent, pathParts) {
    const result = {};
    let cursor = start;
    while (cursor < lines.length) {
      cursor = nextMeaningful(lines, cursor);
      if (cursor >= lines.length || lines[cursor].indent < indent) break;
      if (lines[cursor].indent !== indent || lines[cursor].content.startsWith('-')) break;
      const line = lines[cursor];
      const pair = splitKeyValue(line.content);
      if (!pair || typeof pair.key !== 'string')
        throw new Error(`Expected a mapping at line ${line.line}`);
      if (Object.prototype.hasOwnProperty.call(result, pair.key))
        throw new Error(`Duplicate key at line ${line.line}`);
      let value;
      let next = cursor + 1;
      if (pair.rest === '|' || pair.rest === '|-' || pair.rest === '>-') {
        [value, next] = parseBlockScalar(next, indent, pair.rest.startsWith('>'));
      } else if (pair.rest === '') {
        const child = nextMeaningful(lines, next);
        if (child < lines.length && lines[child].indent > indent)
          [value, next] = parseBlock(child, lines[child].indent, [...pathParts, pair.key]);
        else value = null;
      } else value = parseScalar(pair.rest);
      result[pair.key] = value;
      locations.push({ key: pair.key, value, line: line.line, comment: line.comment });
      cursor = next;
    }
    return [result, cursor];
  }

  function parseArray(start, indent, pathParts) {
    const result = [];
    let cursor = start;
    while (cursor < lines.length) {
      cursor = nextMeaningful(lines, cursor);
      if (cursor >= lines.length || lines[cursor].indent < indent) break;
      if (
        lines[cursor].indent !== indent ||
        !(lines[cursor].content === '-' || lines[cursor].content.startsWith('- '))
      )
        break;
      const line = lines[cursor];
      const item = line.content === '-' ? '' : line.content.slice(2).trim();
      const itemPath = [...pathParts, result.length];
      let value;
      let next = cursor + 1;
      const pair = item ? splitKeyValue(item) : null;
      if (pair && typeof pair.key === 'string') {
        value = {};
        let firstValue;
        if (pair.rest === '') {
          const child = nextMeaningful(lines, next);
          if (child < lines.length && lines[child].indent > indent)
            [firstValue, next] = parseBlock(child, lines[child].indent, [...itemPath, pair.key]);
          else firstValue = null;
        } else if (pair.rest === '|' || pair.rest === '|-' || pair.rest === '>-') {
          [firstValue, next] = parseBlockScalar(next, indent, pair.rest.startsWith('>'));
        } else firstValue = parseScalar(pair.rest);
        value[pair.key] = firstValue;
        locations.push({
          key: pair.key,
          value: firstValue,
          line: line.line,
          comment: line.comment,
        });
        const child = nextMeaningful(lines, next);
        if (child < lines.length && lines[child].indent > indent) {
          const [additional, after] = parseMap(child, lines[child].indent, itemPath);
          Object.assign(value, additional);
          next = after;
        }
      } else if (item === '') {
        const child = nextMeaningful(lines, next);
        if (child < lines.length && lines[child].indent > indent)
          [value, next] = parseBlock(child, lines[child].indent, itemPath);
        else value = null;
      } else value = parseScalar(splitComment(item).value);
      result.push(value);
      cursor = next;
    }
    return [result, cursor];
  }

  const first = nextMeaningful(lines, 0);
  if (first >= lines.length) return { value: null, locations };
  const [value, after] = parseBlock(first, lines[first].indent, []);
  const trailing = nextMeaningful(lines, after);
  if (trailing < lines.length)
    throw new Error(`Unexpected content at line ${lines[trailing].line}`);
  return { value, locations };
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function findValues(value, key, output = []) {
  if (Array.isArray(value)) value.forEach((item) => findValues(item, key, output));
  else if (value && typeof value === 'object') {
    for (const [itemKey, itemValue] of Object.entries(value)) {
      if (itemKey === key) output.push(itemValue);
      findValues(itemValue, key, output);
    }
  }
  return output;
}

export function checkActionReference(reference, comment = '') {
  if (typeof reference !== 'string')
    return { ok: false, reason: 'action reference is not owner/repository@ref' };
  const atIndex = reference.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === reference.length - 1 || reference.indexOf('@') !== atIndex) {
    return { ok: false, reason: 'action reference is not owner/repository@ref' };
  }
  const fullReference = reference.slice(0, atIndex);
  const ref = reference.slice(atIndex + 1);
  const referenceParts = fullReference.split('/');
  if (
    referenceParts.length < 2 ||
    referenceParts.some((part) => part.length === 0 || /\s/.test(part)) ||
    /\s/.test(ref)
  ) {
    return { ok: false, reason: 'action reference is not owner/repository@ref' };
  }
  if (!/^[0-9a-f]{40}$/i.test(ref))
    return { ok: false, reason: 'action ref is not a full 40-character commit SHA' };
  const repository = fullReference.split('/').slice(0, 2).join('/');
  const release = ACTION_RELEASES[repository];
  if (!release)
    return { ok: false, reason: 'action repository is not in the approved official release table' };
  if (release.sha !== ref.toLowerCase())
    return { ok: false, reason: 'action SHA does not match the approved release commit' };
  if (!comment.includes(release.tag)) {
    return { ok: false, reason: 'pinned action is missing its release-version comment' };
  }
  return { ok: true, repository, sha: ref.toLowerCase() };
}

function issue(errors, file, message, line) {
  errors.push(`${file}${line ? `:${line}` : ''}: ${message}`);
}

function workflowStrings(document) {
  return collectStrings(document.value).join('\n');
}

function workflowPermissions(document) {
  return document.locations.filter((location) => location.key === 'permissions');
}

function validateCommonWorkflow(file, document, errors) {
  const value = document.value;
  if (!value || typeof value !== 'object') {
    issue(errors, file, 'workflow document must be a mapping');
    return;
  }
  if (value.name !== WORKFLOW_NAMES[file])
    issue(errors, file, `workflow name must be ${WORKFLOW_NAMES[file]}`);
  const permissions = value.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions))
    issue(errors, file, 'top-level permissions must be explicit');
  for (const location of workflowPermissions(document)) {
    if (location.value === 'write-all' || location.value === 'read-all')
      issue(errors, file, 'broad permissions are not allowed', location.line);
  }
  const text = workflowStrings(document);
  if (
    /pull_request_target/i.test(text) ||
    document.locations.some((location) => location.key === 'pull_request_target')
  )
    issue(errors, file, 'pull_request_target is forbidden');
  if (/\bsecrets(?:\.|\[)/i.test(text)) issue(errors, file, 'repository secrets are not allowed');
  if (/(?:npm\s+install|npm\s+i(?!\s*ci\b))/i.test(text))
    issue(errors, file, 'npm install is forbidden; use npm ci');
  // vsce/npm publish is forbidden everywhere, with no exception — no workflow in this repository
  // is ever allowed to publish to the Marketplace or npm. `gh release` and a literal reference to
  // the Marketplace listing URL are reserved for finalize-release.yml, whose entire job is to
  // create the GitHub Release once a human has manually verified the Marketplace upload — every
  // other workflow (including release-candidate.yml) must never touch either.
  if (/(?:npm\s+publish|vsce\s+publish)/i.test(text))
    issue(errors, file, 'release or publish operation is forbidden');
  if (file !== 'finalize-release.yml' && /gh\s+release/i.test(text))
    issue(errors, file, 'release or publish operation is forbidden');
  if (file !== 'finalize-release.yml' && /marketplace\.visualstudio/i.test(text))
    issue(errors, file, 'release or publish operation is forbidden');
  for (const location of document.locations.filter((item) => item.key === 'uses')) {
    const result = checkActionReference(location.value, location.comment);
    if (!result.ok) issue(errors, file, result.reason, location.line);
  }
  for (const location of document.locations.filter(
    (item) => item.key === 'run' && typeof item.value === 'string',
  )) {
    if (
      /\$\{\{[^}]*\b(?:github\.(?:event|head_ref|base_ref|ref|ref_name|sha|actor|triggering_actor)|inputs\.)/i.test(
        location.value,
      )
    ) {
      issue(
        errors,
        file,
        'untrusted event/input context is interpolated directly into a shell command',
        location.line,
      );
    }
  }
  if (
    !value.concurrency ||
    typeof value.concurrency !== 'object' ||
    !String(value.concurrency.group ?? '').includes('github.ref')
  ) {
    issue(errors, file, 'branch/ref-based concurrency is required');
  }
  const jobs = value.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs))
    issue(errors, file, 'jobs must be a mapping');
  else {
    for (const [jobId, job] of Object.entries(jobs)) {
      if (
        !job ||
        typeof job !== 'object' ||
        typeof job['timeout-minutes'] !== 'number' ||
        job['timeout-minutes'] < 1
      ) {
        issue(errors, file, `job ${jobId} must define a positive timeout-minutes`);
      }
    }
  }
  // fetch-depth: 0 (full history) is reserved for the two workflows that structurally need it:
  // the secret scanner (must scan every historical commit) and finalize-release.yml (must prove
  // the candidate commit is an ancestor of main via `git merge-base`, which needs real history).
  const FETCH_DEPTH_ZERO_ALLOWLIST = new Set(['secret-scan.yml', 'finalize-release.yml']);
  for (const location of document.locations.filter((item) => item.key === 'fetch-depth')) {
    if (!FETCH_DEPTH_ZERO_ALLOWLIST.has(file) || location.value !== 0)
      issue(
        errors,
        file,
        'fetch-depth: 0 is reserved for the full-history secret scan and release ancestry check',
        location.line,
      );
  }
  // Retention budgets differ deliberately by artifact purpose: short-lived CI/debug artifacts
  // stay at 1-7 days, while a release-candidate artifact must survive long enough for a human to
  // complete the manual Marketplace upload and approve finalize-release (14-30 days).
  const RETENTION_RANGE = file === 'release-candidate.yml' ? [14, 30] : [1, 7];
  for (const location of document.locations.filter((item) => item.key === 'retention-days')) {
    const [min, max] = RETENTION_RANGE;
    if (typeof location.value !== 'number' || location.value > max || location.value < min)
      issue(
        errors,
        file,
        `artifact retention must be between ${min} and ${max} days`,
        location.line,
      );
  }
}

// Per-file allowlist of write-level permission names, checked against *every* `permissions:`
// block in the document (top-level workflow permissions and any job-level override) — a job can
// narrow or elevate the workflow-level default, so both scopes must be checked, not just the
// workflow-level one.
const WRITE_PERMISSION_ALLOWLIST = {
  'codeql.yml': new Set(['security-events']),
  'release-candidate.yml': new Set(['id-token', 'attestations']),
  'finalize-release.yml': new Set(['contents']),
};

function validatePermissions(file, document, errors) {
  const allowedWrite = WRITE_PERMISSION_ALLOWLIST[file] ?? new Set();
  for (const location of document.locations) {
    if (location.key !== 'permissions') continue;
    const permissions = location.value;
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) continue;
    for (const [permission, level] of Object.entries(permissions)) {
      if ((level === 'write' || level === 'write-all') && !allowedWrite.has(permission))
        issue(errors, file, `write permission ${permission} is not allowed`, location.line);
    }
    if (
      file !== 'codeql.yml' &&
      Object.prototype.hasOwnProperty.call(permissions, 'security-events')
    )
      issue(errors, file, 'security-events permission is reserved for CodeQL', location.line);
  }
  const topPermissions = document.value?.permissions;
  if (file === 'codeql.yml' && topPermissions?.contents !== 'read')
    issue(errors, file, 'CodeQL requires contents: read');
  if (file === 'codeql.yml' && topPermissions?.['security-events'] !== 'write')
    issue(errors, file, 'CodeQL requires security-events: write');
}

function validateTriggers(file, document, errors) {
  const trigger = document.value?.on;
  if (!trigger || typeof trigger !== 'object')
    issue(errors, file, 'explicit trigger mapping is required');
  if (file === 'dependency-review.yml') {
    if (
      !trigger ||
      !Object.prototype.hasOwnProperty.call(trigger, 'pull_request') ||
      Object.keys(trigger).length !== 1
    )
      issue(errors, file, 'Dependency Review must trigger only on pull_request');
  } else if (WORKFLOW_DISPATCH_ONLY_WORKFLOWS.includes(file)) {
    // Release workflows must never run automatically (no pull_request/push/schedule) — only a
    // human explicitly dispatching them, which is what keeps tag/release/artifact creation under
    // manual control.
    if (
      !trigger ||
      !Object.prototype.hasOwnProperty.call(trigger, 'workflow_dispatch') ||
      Object.keys(trigger).length !== 1
    )
      issue(errors, file, `${WORKFLOW_NAMES[file]} must trigger only on workflow_dispatch`);
  } else {
    for (const name of ['pull_request', 'push', 'workflow_dispatch'])
      if (!trigger || !Object.prototype.hasOwnProperty.call(trigger, name))
        issue(errors, file, `missing ${name} trigger`);
    if (
      file === 'codeql.yml' &&
      (!trigger?.schedule || !Array.isArray(trigger.schedule) || trigger.schedule.length === 0)
    )
      issue(errors, file, 'CodeQL requires a weekly schedule');
  }
}

function validateCi(document, errors) {
  const jobs = document.value?.jobs;
  const quality = jobs?.quality;
  const packageJob = jobs?.package;
  const matrixOs = quality?.strategy?.matrix?.os;
  if (
    !Array.isArray(matrixOs) ||
    !matrixOs.includes('ubuntu-latest') ||
    !matrixOs.includes('windows-latest')
  )
    issue(errors, 'ci.yml', 'quality matrix must include ubuntu-latest and windows-latest');
  const qualityRun = JSON.stringify(quality ?? '');
  for (const command of [
    'npm ci',
    'npm run compile',
    'npm run lint',
    'npm run format:check',
    'npm run audit:release',
    'npm test',
  ]) {
    if (!qualityRun.includes(command)) issue(errors, 'ci.yml', `quality job is missing ${command}`);
  }
  if (
    !qualityRun.includes('node-version-file') ||
    !(qualityRun.includes('.nvmrc') || qualityRun.includes('.node-version'))
  )
    issue(errors, 'ci.yml', 'quality job must use the repository Node version file');
  if (!qualityRun.includes('cache-dependency-path') || !qualityRun.includes('package-lock.json'))
    issue(errors, 'ci.yml', 'Node/npm cache must be keyed by package-lock.json');
  const ciText = workflowStrings(document);
  for (const command of [
    'npm audit --audit-level=moderate',
    'npm audit --omit=dev --audit-level=moderate',
  ])
    if (!ciText.includes(command)) issue(errors, 'ci.yml', `Ubuntu audit is missing ${command}`);
  if (!packageJob || packageJob.needs !== 'quality')
    issue(errors, 'ci.yml', 'package job must run after quality');
  if (!JSON.stringify(packageJob ?? '').includes('npm run package'))
    issue(errors, 'ci.yml', 'package job must run npm run package');
  if (!JSON.stringify(packageJob ?? '').includes('audit:release'))
    issue(errors, 'ci.yml', 'package job must audit the generated VSIX');
  if (!JSON.stringify(packageJob ?? '').includes('retention-days'))
    issue(errors, 'ci.yml', 'package VSIX must be uploaded with retention');
}

function validateCodeql(document, errors) {
  const text = workflowStrings(document);
  if (!text.includes('javascript-typescript'))
    issue(errors, 'codeql.yml', 'CodeQL language must be javascript-typescript');
  if (
    !document.locations.some(
      (location) => location.key === 'build-mode' && location.value === 'none',
    )
  )
    issue(errors, 'codeql.yml', 'JavaScript/TypeScript CodeQL must use build-mode: none');
  if (!text.includes('github/codeql-action/init') || !text.includes('github/codeql-action/analyze'))
    issue(errors, 'codeql.yml', 'CodeQL init and analyze steps are required');
}

function validateSecretScan(document, errors) {
  const text = workflowStrings(document);
  if (!text.includes('--redact'))
    issue(errors, 'secret-scan.yml', 'Gitleaks must run with redaction enabled');
  if (
    !/gitleaks\/gitleaks\/releases\/download\/v\d+\.\d+\.\d+\/gitleaks_[^\s/]+_linux_x64\.tar\.gz/.test(
      text,
    )
  )
    issue(
      errors,
      'secret-scan.yml',
      'Gitleaks must download an official immutable Linux release asset',
    );
  if (!/\b[a-f0-9]{64}\b/i.test(text))
    issue(errors, 'secret-scan.yml', 'Gitleaks archive SHA-256 must be pinned');
  if (
    !/(?:sha256sum|shasum\s+-a\s+256)[^\n]*(?:--check|check)/i.test(text) &&
    !/(?:--check|check)[^\n]*(?:sha256sum|shasum\s+-a\s+256)/i.test(text)
  )
    issue(errors, 'secret-scan.yml', 'Gitleaks archive checksum must be verified');
  if (
    !/gitleaks["']?\s+git[\s\S]*--config[\s\S]*\.gitleaks\.toml[\s\S]*--redact[\s\S]*--report-format\s+sarif[\s\S]*--exit-code\s+1/i.test(
      text,
    )
  )
    issue(
      errors,
      'secret-scan.yml',
      'Gitleaks must scan full history and fail on findings with a redacted SARIF report',
    );
  if (!text.includes('.gitleaks.toml'))
    issue(
      errors,
      'secret-scan.yml',
      'Gitleaks allowlist/config must be explicit and repository-local',
    );
  if (!document.locations.some((location) => location.key === 'if-no-files-found'))
    issue(errors, 'secret-scan.yml', 'secret-scan artifact handling must be explicit');
}

function validateReleaseCandidate(document, errors) {
  const jobs = document.value?.jobs;
  const build = jobs?.build;
  const text = JSON.stringify(build ?? '');
  if (!build || typeof build !== 'object')
    issue(errors, 'release-candidate.yml', 'a build job is required');
  const inputs = document.value?.on?.workflow_dispatch?.inputs;
  if (
    !inputs ||
    typeof inputs !== 'object' ||
    !Object.prototype.hasOwnProperty.call(inputs, 'version')
  )
    issue(errors, 'release-candidate.yml', 'a required "version" input is required');
  for (const command of [
    'npm ci',
    'npm run compile',
    'npm run lint',
    'npm run format:check',
    'npm run verify:workflows',
    'npm audit',
    'npm audit --omit=dev',
    'npm run audit:release',
    'npm test',
    'npm run package',
  ]) {
    if (!text.includes(command))
      issue(errors, 'release-candidate.yml', `build job is missing ${command}`);
  }
  if (!text.includes('actions/upload-artifact'))
    issue(errors, 'release-candidate.yml', 'build job must upload the release candidate artifact');
  if (!text.includes('retention-days'))
    issue(
      errors,
      'release-candidate.yml',
      'release candidate artifact must declare retention-days',
    );
}

function validateFinalizeRelease(document, errors) {
  const jobs = document.value?.jobs;
  const finalize = jobs?.finalize;
  const text = JSON.stringify(finalize ?? '');
  if (!finalize || typeof finalize !== 'object')
    issue(errors, 'finalize-release.yml', 'a finalize job is required');
  if (finalize?.environment !== 'production-release')
    issue(
      errors,
      'finalize-release.yml',
      'finalize job must run under the production-release environment',
    );
  const inputs = document.value?.on?.workflow_dispatch?.inputs;
  const requiredInputs = [
    'version',
    'candidate_run_id',
    'commit_sha',
    'marketplace_url',
    'marketplace_confirmation',
  ];
  for (const name of requiredInputs) {
    if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, name))
      issue(errors, 'finalize-release.yml', `a required "${name}" input is required`);
  }
  const fullText = workflowStrings(document);
  // The confirmation phrase is version-scoped and must be *derived* from the validated version
  // (I_HAVE_VERIFIED_MARKETPLACE_<version>), never frozen to one release — a hardcoded phrase would
  // silently keep accepting last release's confirmation for the next version's finalization.
  if (!fullText.includes(MARKETPLACE_CONFIRMATION_PREFIX))
    issue(
      errors,
      'finalize-release.yml',
      'version-scoped Marketplace confirmation phrase prefix is required',
    );
  // A `description:` may still show a worked example for the human dispatching the workflow; what
  // must never be frozen is the value the workflow actually compares against.
  const hardcodedPhrase = new RegExp(`${MARKETPLACE_CONFIRMATION_PREFIX}[0-9]+\\.[0-9]+\\.[0-9]+`);
  for (const location of document.locations) {
    if (location.key === 'description' || typeof location.value !== 'string') continue;
    if (hardcodedPhrase.test(location.value))
      issue(
        errors,
        'finalize-release.yml',
        'Marketplace confirmation phrase must be derived from the validated version, not hardcoded to one release',
        location.line,
      );
  }
  if (!fullText.includes(EXPECTED_MARKETPLACE_URL))
    issue(errors, 'finalize-release.yml', 'exact Marketplace listing URL is required');
  for (const command of ['gh run view', 'gh run download', 'gh release create', 'gh api']) {
    if (!text.includes(command))
      issue(errors, 'finalize-release.yml', `finalize job is missing ${command}`);
  }
  if (text.includes('--force') || text.includes('--clobber'))
    issue(errors, 'finalize-release.yml', 'force/overwrite operations are forbidden');
  // The candidate run id and commit SHA are attacker-influenceable dispatch inputs, so each needs
  // its own anchored allowlist before it reaches `gh run view` / `git merge-base`.
  if (!fullText.includes("'^[0-9]+$'"))
    issue(
      errors,
      'finalize-release.yml',
      'candidate_run_id must be validated as a positive integer',
    );
  if (!fullText.includes("'^[0-9a-f]{40}$'"))
    issue(
      errors,
      'finalize-release.yml',
      'commit_sha must be validated as a full 40-character lowercase hex SHA',
    );
  if (!fullText.includes('merge-base --is-ancestor'))
    issue(
      errors,
      'finalize-release.yml',
      'candidate commit must be proven to be part of main history',
    );
  for (const marker of ['SHA256SUMS.txt', 'release-manifest.json', 'sha256sum']) {
    if (!fullText.includes(marker))
      issue(errors, 'finalize-release.yml', `artifact integrity check is missing ${marker}`);
  }
  if (!/refusing to move it/i.test(fullText))
    issue(
      errors,
      'finalize-release.yml',
      'an existing release ref on a different commit must fail closed rather than be moved',
    );
  if (!/no overwrite/i.test(fullText))
    issue(errors, 'finalize-release.yml', 'existing release assets must never be overwritten');
}

// ---------------------------------------------------------------------------
// Task 14.1: reusable-release security invariants
//
// Both release workflows became version-generic in Task 14.1. These checks are what keeps that
// generalization safe: the version is the only human-supplied value that reaches a path, a filter,
// a ref name, or a confirmation phrase, so every workflow that accepts one must gate it behind the
// same anchored grammar, must not carry a frozen version constant that would silently disagree
// with the input, and must never gain a publishing credential of any shape.
// ---------------------------------------------------------------------------

function validateReleaseWorkflowSecurity(file, document, errors) {
  const text = workflowStrings(document);
  const isReleaseWorkflow = WORKFLOW_DISPATCH_ONLY_WORKFLOWS.includes(file);

  for (const { name, pattern } of FORBIDDEN_PUBLISH_CREDENTIAL_PATTERNS) {
    if (pattern.test(text))
      issue(errors, file, `Marketplace publishing credential/flag is forbidden [${name}]`);
  }

  if (!isReleaseWorkflow) return;

  if (!text.includes(STRICT_SEMVER_SHELL_PATTERN))
    issue(
      errors,
      file,
      'release workflow must validate its version input against the exact strict SemVer pattern',
    );

  // A leftover `EXPECTED_VERSION: 0.7.0`-style constant is exactly the bug Task 14.1 removes: it
  // makes the workflow silently single-version again while still advertising a version input.
  for (const location of document.locations) {
    if (typeof location.value !== 'string') continue;
    if (!/^\d+\.\d+\.\d+$/.test(location.value.trim())) continue;
    if (location.key === 'uses' || location.key === 'node-version') continue;
    issue(
      errors,
      file,
      `release workflow must not pin a literal version constant (${location.key})`,
      location.line,
    );
  }

  // Checkout must never leave a usable credential in .git/config for later steps to reuse.
  const checkoutSteps = findValues(document.value, 'uses').filter(
    (value) => typeof value === 'string' && value.startsWith('actions/checkout@'),
  );
  if (checkoutSteps.length > 0) {
    const persist = findValues(document.value, 'persist-credentials');
    if (persist.length !== checkoutSteps.length || persist.some((value) => value !== false))
      issue(errors, file, 'every checkout must set persist-credentials: false');
  }

  if (file === 'release-candidate.yml') {
    // The candidate stage is build-and-attest only: it must be structurally incapable of creating
    // a ref, a release, or a Marketplace upload, so a mis-dispatch can never publish anything.
    if (/\bgit\s+(?:tag|push|commit)\b/i.test(text))
      issue(errors, file, 'release candidate must never create a ref, a commit, or a push');
    if (/gh\s+(?:release|api)\b/i.test(text))
      issue(errors, file, 'release candidate must never call the releases API');
    for (const marker of ['CHANGELOG.md', 'RELEASE-NOTES-', 'refs/tags/']) {
      if (!text.includes(marker))
        issue(errors, file, `release candidate preflight is missing its ${marker} check`);
    }
  }
}

// Job-scoped elevation allowlist: each elevated permission is granted to exactly one job in exactly
// one workflow, so a future edit cannot quietly widen (say) `contents: write` to the build job.
const JOB_PERMISSION_SCOPE = {
  'contents:write': { file: 'finalize-release.yml', job: 'finalize' },
  'actions:read': { file: 'finalize-release.yml', job: 'finalize' },
  'id-token:write': { file: 'release-candidate.yml', job: 'build' },
  'attestations:write': { file: 'release-candidate.yml', job: 'build' },
};

function validatePermissionScopes(file, document, errors) {
  const jobs = document.value?.jobs;
  if (!jobs || typeof jobs !== 'object') return;
  for (const [jobId, job] of Object.entries(jobs)) {
    const permissions = job?.permissions;
    if (!permissions || typeof permissions !== 'object') continue;
    for (const [permission, level] of Object.entries(permissions)) {
      const scope = JOB_PERMISSION_SCOPE[`${permission}:${level}`];
      if (!scope) continue;
      if (scope.file !== file || scope.job !== jobId)
        issue(
          errors,
          file,
          `${permission}: ${level} is reserved for the ${scope.job} job in ${scope.file}`,
        );
    }
  }
  for (const [key, scope] of Object.entries(JOB_PERMISSION_SCOPE)) {
    if (scope.file !== file) continue;
    const [permission, level] = key.split(':');
    if (jobs[scope.job]?.permissions?.[permission] !== level)
      issue(errors, file, `job ${scope.job} must declare ${permission}: ${level}`);
  }
}

function validateNoRuntimeImports(document, errors, file) {
  const text = workflowStrings(document);
  if (/\b(?:src|out)\/providers\b|require\([^)]*providers|from ['"][^'"]*providers/i.test(text))
    issue(errors, file, 'workflow scripts must not import runtime/provider code');
}

export function inspectWorkflow(file, source) {
  const document = parseYamlDocument(source);
  const errors = [];
  validateCommonWorkflow(file, document, errors);
  validatePermissions(file, document, errors);
  validatePermissionScopes(file, document, errors);
  validateTriggers(file, document, errors);
  validateReleaseWorkflowSecurity(file, document, errors);
  if (file === 'ci.yml') validateCi(document, errors);
  if (file === 'codeql.yml') validateCodeql(document, errors);
  if (file === 'secret-scan.yml') validateSecretScan(document, errors);
  if (file === 'release-candidate.yml') validateReleaseCandidate(document, errors);
  if (file === 'finalize-release.yml') validateFinalizeRelease(document, errors);
  validateNoRuntimeImports(document, errors, file);
  return { document, errors };
}

function majorVersion(value) {
  const match = String(value ?? '').match(/(?:^|[^\d])(\d+)(?=\.)/);
  return match ? Number(match[1]) : null;
}

function versionParts(value) {
  const match = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function satisfiesCaretRange(range, version) {
  const rangeParts = String(range ?? '').match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  const resolvedParts = versionParts(version);
  if (!rangeParts || !resolvedParts) return false;
  const minimum = rangeParts.slice(1, 4).map(Number);
  if (resolvedParts[0] !== minimum[0]) return false;
  if (resolvedParts[1] < minimum[1]) return true;
  if (resolvedParts[1] > minimum[1]) return true;
  return resolvedParts[2] >= minimum[2];
}

function compareStringMaps(label, expected, actual, errors) {
  const expectedMap = expected && typeof expected === 'object' ? expected : {};
  const actualMap = actual && typeof actual === 'object' ? actual : {};
  const names = new Set([...Object.keys(expectedMap), ...Object.keys(actualMap)]);
  for (const name of names) {
    if (expectedMap[name] !== actualMap[name])
      issue(errors, 'package-lock.json', `${label} entry ${name} does not match package.json`);
  }
}

function validatePackageCompatibility(root, errors) {
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  if (!existsSync(packagePath) || !existsSync(lockPath)) {
    issue(errors, 'package-lock.json', 'package.json and package-lock.json are both required');
    return;
  }

  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    packageLock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    issue(errors, 'package-lock.json', 'package.json and package-lock.json must be valid JSON');
    return;
  }

  const lockRoot = packageLock.packages?.[''];
  if (!lockRoot || typeof lockRoot !== 'object') {
    issue(errors, 'package-lock.json', 'packages[""] root entry is required');
    return;
  }
  if (packageLock.version !== packageJson.version || lockRoot.version !== packageJson.version)
    issue(errors, 'package-lock.json', 'manifest and lockfile project versions must match');
  compareStringMaps('dependencies', packageJson.dependencies, lockRoot.dependencies, errors);
  compareStringMaps(
    'devDependencies',
    packageJson.devDependencies,
    lockRoot.devDependencies,
    errors,
  );
  compareStringMaps('engines', packageJson.engines, lockRoot.engines, errors);

  const devDependencies = packageJson.devDependencies ?? {};
  const lockedPackages = packageLock.packages ?? {};
  const nodeRange = devDependencies['@types/node'];
  const nodeEntry = lockedPackages['node_modules/@types/node'];
  if (majorVersion(nodeRange) !== 20 || !/^\^20\./.test(String(nodeRange ?? '')))
    issue(errors, 'package.json', '@types/node must remain on the 20.x compatibility range');
  if (majorVersion(nodeEntry?.version) !== 20)
    issue(errors, 'package-lock.json', '@types/node must resolve to a 20.x version');
  if (!satisfiesCaretRange(nodeRange, nodeEntry?.version))
    issue(
      errors,
      'package-lock.json',
      '@types/node lockfile version is outside its manifest range',
    );

  const nodeEngine = packageJson.engines?.node;
  if (majorVersion(nodeEngine) === null || majorVersion(nodeEngine) < 22)
    issue(
      errors,
      'package.json',
      'engines.node must describe the supported development runtime (22+)',
    );
  if (majorVersion(packageJson.engines?.vscode) !== 1)
    issue(errors, 'package.json', 'engines.vscode must remain the VS Code extension-host contract');
  if (majorVersion(devDependencies['@types/vscode']) !== 1)
    issue(
      errors,
      'package.json',
      '@types/vscode must remain the VS Code extension-host type contract',
    );
  if (majorVersion(nodeEngine) === majorVersion(nodeRange))
    issue(
      errors,
      'package.json',
      'Node development engine and @types/node compatibility range must stay distinct',
    );

  for (const [name, expectedMajor] of [
    ['typescript', 5],
    ['eslint', 9],
    ['vitest', 4],
    ['@typescript-eslint/eslint-plugin', 8],
    ['@typescript-eslint/parser', 8],
  ]) {
    if (majorVersion(devDependencies[name]) !== expectedMajor)
      issue(errors, 'package.json', `${name} must remain on the supported ${expectedMajor}.x line`);
    if (majorVersion(lockedPackages[`node_modules/${name}`]?.version) !== expectedMajor)
      issue(
        errors,
        'package-lock.json',
        `${name} must resolve on the supported ${expectedMajor}.x line`,
      );
  }
}

function validateDependabot(source, errors) {
  let document;
  try {
    document = parseYamlDocument(source);
  } catch {
    issue(errors, '.github/dependabot.yml', 'Dependabot configuration is not valid YAML');
    return;
  }
  const updates = document.value?.updates;
  if (!Array.isArray(updates)) {
    issue(errors, '.github/dependabot.yml', 'updates must be an array');
    return;
  }
  for (const ecosystem of ['npm', 'github-actions']) {
    const entry = updates.find(
      (item) => item?.['package-ecosystem'] === ecosystem && item.directory === '/',
    );
    if (!entry) issue(errors, '.github/dependabot.yml', `${ecosystem} ecosystem at / is required`);
    else {
      if (entry.schedule?.interval !== 'weekly')
        issue(errors, '.github/dependabot.yml', `${ecosystem} updates must be weekly`);
      if (entry['target-branch'] !== 'main')
        issue(errors, '.github/dependabot.yml', `${ecosystem} updates must target main`);
    }
  }
  const npm = updates.find((item) => item?.['package-ecosystem'] === 'npm');
  if (npm?.['open-pull-requests-limit'] !== 5)
    issue(errors, '.github/dependabot.yml', 'npm open PR limit must be 5');
  const groupsText = JSON.stringify(npm?.groups ?? {});
  if (
    !groupsText.includes('development') ||
    !groupsText.includes('minor') ||
    !groupsText.includes('patch')
  )
    issue(
      errors,
      '.github/dependabot.yml',
      'npm development minor/patch updates should be grouped',
    );
  const npmMajorIgnore = Array.isArray(npm?.ignore)
    ? npm.ignore.find(
        (entry) =>
          entry?.['dependency-name'] === '*' &&
          Array.isArray(entry['update-types']) &&
          entry['update-types'].length === 1 &&
          entry['update-types'][0] === 'version-update:semver-major',
      )
    : undefined;
  if (!npmMajorIgnore)
    issue(
      errors,
      '.github/dependabot.yml',
      'npm normal version updates must ignore semver-major releases',
    );
  if (/['\"]?security-updates['\"]?\s*:\s*false/i.test(JSON.stringify(npm ?? {})))
    issue(errors, '.github/dependabot.yml', 'Dependabot security updates must remain enabled');
  const actions = updates.find((item) => item?.['package-ecosystem'] === 'github-actions');
  if (
    !JSON.stringify(actions?.groups ?? {}).includes('minor') ||
    !JSON.stringify(actions?.groups ?? {}).includes('patch')
  )
    issue(errors, '.github/dependabot.yml', 'GitHub Actions minor/patch updates should be grouped');
  if (/auto[-_ ]?merge|merge-method/i.test(source))
    issue(errors, '.github/dependabot.yml', 'automatic merge is forbidden');
  return { document };
}

export function checkGitleaksConfig(source) {
  const errors = [];
  if (!source.includes('useDefault = true'))
    errors.push('Gitleaks config must extend the default rules');
  if (!source.includes('^test/ReleaseAudit\\.test\\.ts$'))
    errors.push('historical fixture allowlist must target only the exact test file');
  if (!source.includes('AK(?:IA)ABCDEFGHIJKLMNOP'))
    errors.push('historical fixture allowlist must target only the exact synthetic pattern');
  if (/paths\s*=\s*\[[^\]]*(?:src|docs|test\/\*\*|\.\*)/i.test(source))
    errors.push('broad Gitleaks path allowlists are forbidden');
  return errors;
}

export function verifyRepository(root = ROOT) {
  const errors = [];
  const documents = new Map();
  for (const file of EXPECTED_WORKFLOWS) {
    const fullPath = path.join(root, '.github', 'workflows', file);
    if (!existsSync(fullPath)) {
      issue(errors, `.github/workflows/${file}`, 'required workflow is missing');
      continue;
    }
    try {
      const result = inspectWorkflow(file, readFileSync(fullPath, 'utf8'));
      documents.set(file, result.document);
      result.errors.forEach((error) => errors.push(error));
    } catch (error) {
      issue(
        errors,
        `.github/workflows/${file}`,
        `workflow could not be parsed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  const dependabotPath = path.join(root, '.github', 'dependabot.yml');
  if (!existsSync(dependabotPath))
    issue(errors, '.github/dependabot.yml', 'required Dependabot configuration is missing');
  else validateDependabot(readFileSync(dependabotPath, 'utf8'), errors);

  const gitleaksConfigPath = path.join(root, '.gitleaks.toml');
  if (!existsSync(gitleaksConfigPath))
    issue(errors, '.gitleaks.toml', 'repository-local Gitleaks config is required');
  else {
    const gitleaksConfig = readFileSync(gitleaksConfigPath, 'utf8');
    checkGitleaksConfig(gitleaksConfig).forEach((message) =>
      issue(errors, '.gitleaks.toml', message),
    );
  }

  const packagePath = path.join(root, 'package.json');
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (packageJson.scripts?.['verify:workflows'] !== 'node scripts/verify-workflows.mjs')
      issue(errors, 'package.json', 'verify:workflows script is missing');
  }
  validatePackageCompatibility(root, errors);
  for (const file of ['.nvmrc', '.node-version']) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath) || readFileSync(fullPath, 'utf8').trim() !== '24')
      issue(errors, file, 'Node 24 policy is required');
  }
  const vscodeIgnore = existsSync(path.join(root, '.vscodeignore'))
    ? readFileSync(path.join(root, '.vscodeignore'), 'utf8')
    : '';
  for (const entry of [
    '.github/**',
    '.gitleaks.toml',
    'scripts/**',
    'test/**',
    '.nvmrc',
    '.node-version',
  ])
    if (!vscodeIgnore.split(/\r?\n/).includes(entry))
      issue(errors, '.vscodeignore', `${entry} must be excluded from the VSIX`);

  return { ok: errors.length === 0, errors, documents };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyRepository();
  if (result.ok)
    console.log(
      `Workflow policy verified: ${EXPECTED_WORKFLOWS.length} workflows and Dependabot configuration.`,
    );
  else {
    console.error('Workflow policy verification failed:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}
