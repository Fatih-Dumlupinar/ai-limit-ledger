import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateLaunchConfiguration,
  validateTasksConfiguration,
  RECOMMENDED_EXTENSION_ALLOWLIST,
  REQUIRED_TASK_LABELS,
  FORBIDDEN_WORKSPACE_SETTING_PATTERNS,
  ABSOLUTE_PATH_PATTERNS,
  CREDENTIAL_PATTERNS,
  VSIX_DENYLIST_PATTERNS,
  DEV_HOST_TMP_ROOT,
  EXPECTED_EXTENSION_ID,
  resolveVsixArgument,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const ROOT = resolve(__dirname, '..');
const readJson = (relative: string) =>
  JSON.parse(readFileSync(resolve(ROOT, relative), 'utf8')) as Record<string, unknown>;

const launch = readJson('.vscode/launch.json');
const tasks = readJson('.vscode/tasks.json');
const settings = readJson('.vscode/settings.json');
const recommendations = readJson('.vscode/extensions.json');
const packageJson = readJson('package.json');
const gitignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
const vscodeignore = readFileSync(resolve(ROOT, '.vscodeignore'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim());
const development = readFileSync(resolve(ROOT, 'docs/DEVELOPMENT.md'), 'utf8');
const readmeEn = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const readmeTr = readFileSync(resolve(ROOT, 'README.tr.md'), 'utf8');

type LaunchConfig = { name?: string; type?: string; args?: string[]; preLaunchTask?: string };
const configurations = (launch.configurations ?? []) as LaunchConfig[];
const cleanHost = configurations.find((c) => /Clean Development Host/.test(String(c.name)));

describe('Task 14.1: .vscode/launch.json', () => {
  it('parses and passes the Development Host isolation policy', () => {
    expect(launch.version).toBe('0.2.0');
    expect(validateLaunchConfiguration(launch)).toEqual([]);
  });

  it('offers the Clean Development Host as a named profile', () => {
    expect(cleanHost?.name).toBe('Run Extension — Clean Development Host');
    expect(cleanHost?.type).toBe('extensionHost');
  });

  it('gives the Clean Development Host its own user-data and extensions areas', () => {
    const args = cleanHost?.args ?? [];
    expect(args).toContain(`--user-data-dir=\${workspaceFolder}/${DEV_HOST_TMP_ROOT}/user-data`);
    expect(args).toContain(`--extensions-dir=\${workspaceFolder}/${DEV_HOST_TMP_ROOT}/extensions`);
    expect(args).toContain('--extensionDevelopmentPath=${workspaceFolder}');
    // No other extension may load into the clean host, so the extension under development is the
    // only thing running and cannot be perturbed by a contributor's own installed extensions.
    expect(args).toContain('--disable-extensions');
  });

  it('uses only real, documented Extension Development Host arguments', () => {
    for (const configuration of configurations) {
      if (configuration.type !== 'extensionHost') continue;
      for (const arg of configuration.args ?? []) {
        expect(
          /^--(?:extensionDevelopmentPath|user-data-dir|extensions-dir)=/.test(arg) ||
            arg === '--disable-extensions',
          arg,
        ).toBe(true);
      }
    }
  });

  it('resolves every path through ${workspaceFolder}, never an absolute user path', () => {
    const serialized = JSON.stringify(launch);
    for (const pattern of ABSOLUTE_PATH_PATTERNS as RegExp[]) {
      pattern.lastIndex = 0;
      expect(pattern.test(serialized)).toBe(false);
    }
    expect(serialized).not.toMatch(/[A-Za-z]:\\/);
  });

  it('carries no credential-shaped content', () => {
    const serialized = JSON.stringify(launch);
    for (const { name, pattern } of CREDENTIAL_PATTERNS as Array<{
      name: string;
      pattern: RegExp;
    }>) {
      pattern.lastIndex = 0;
      expect(pattern.test(serialized), name).toBe(false);
    }
  });

  it('builds before launching, via a task that exists', () => {
    const labels = ((tasks.tasks ?? []) as Array<{ label?: string }>).map((t) => t.label);
    for (const configuration of configurations) {
      if (configuration.type !== 'extensionHost') continue;
      expect(labels).toContain(configuration.preLaunchTask);
    }
  });

  it('rejects a configuration that points its dev-host state outside the workspace', () => {
    const issues = validateLaunchConfiguration({
      configurations: [
        {
          name: 'Run Extension — Clean Development Host',
          type: 'extensionHost',
          args: [
            '--extensionDevelopmentPath=${workspaceFolder}',
            '--user-data-dir=/home/fixture/vscode',
            '--extensions-dir=${workspaceFolder}/elsewhere',
          ],
        },
      ],
    }) as string[];
    expect(issues.some((i) => i.includes('absolute user path'))).toBe(true);
    expect(issues.some((i) => i.includes('${workspaceFolder}'))).toBe(true);
    expect(issues.some((i) => i.includes(DEV_HOST_TMP_ROOT))).toBe(true);
  });

  it('rejects an invented Extension Development Host argument', () => {
    const issues = validateLaunchConfiguration({
      configurations: [
        {
          name: 'Run Extension — Clean Development Host',
          type: 'extensionHost',
          args: [
            '--extensionDevelopmentPath=${workspaceFolder}',
            `--user-data-dir=\${workspaceFolder}/${DEV_HOST_TMP_ROOT}/user-data`,
            `--extensions-dir=\${workspaceFolder}/${DEV_HOST_TMP_ROOT}/extensions`,
            '--copy-user-secrets',
          ],
        },
      ],
    }) as string[];
    expect(issues.some((i) => i.includes('unsupported Extension Development Host argument'))).toBe(
      true,
    );
  });
});

describe('Task 14.1: .vscode/tasks.json', () => {
  it('parses and passes the task policy against the real package.json scripts', () => {
    expect(tasks.version).toBe('2.0.0');
    expect(validateTasksConfiguration(tasks, packageJson.scripts)).toEqual([]);
  });

  it('defines every required development task', () => {
    const labels = ((tasks.tasks ?? []) as Array<{ label?: string }>).map((t) => t.label);
    for (const required of REQUIRED_TASK_LABELS as string[]) {
      expect(labels, required).toContain(required);
    }
  });

  it('delegates to npm scripts instead of re-implementing command logic', () => {
    for (const task of (tasks.tasks ?? []) as Array<Record<string, unknown>>) {
      if (task.type === 'npm') {
        expect(packageJson.scripts as Record<string, string>).toHaveProperty(String(task.script));
      } else {
        expect(task.type).toBe('shell');
        expect(task.command).toBe('npm');
      }
    }
  });

  it('marks watch-style tasks as single-instance background tasks', () => {
    for (const task of (tasks.tasks ?? []) as Array<Record<string, unknown>>) {
      if (!/watch/i.test(String(task.label))) continue;
      expect(task.isBackground, String(task.label)).toBe(true);
      expect((task.runOptions as Record<string, unknown>)?.instanceLimit).toBe(1);
    }
  });

  it('contains no publish or release task', () => {
    const serialized = JSON.stringify(tasks);
    expect(serialized).not.toMatch(/vsce\s+publish|ovsx\s+publish|npm\s+publish/i);
    expect(serialized).not.toMatch(/gh\s+release|git\s+tag/i);
  });

  it('rejects a task that references a missing npm script', () => {
    const issues = validateTasksConfiguration(
      { tasks: [{ label: 'Compile', type: 'npm', script: 'nope' }] },
      { compile: 'tsc -p .' },
    ) as string[];
    expect(issues.some((i) => i.includes('missing npm script'))).toBe(true);
  });

  it('rejects a task that would publish, whether inline or split across args', () => {
    for (const task of [
      { label: 'Publish', type: 'shell', command: 'npx vsce publish' },
      { label: 'Publish', type: 'shell', command: 'npx', args: ['vsce', 'publish'] },
      { label: 'Tag', type: 'shell', command: 'git', args: ['tag', '-a', 'v9.9.9'] },
    ]) {
      const issues = validateTasksConfiguration({ tasks: [task] }, {}) as string[];
      expect(
        issues.some((i) => i.includes('must never publish or release')),
        JSON.stringify(task),
      ).toBe(true);
    }
  });

  it('backs the Full Local Check with the complete verification chain', () => {
    const chain = String((packageJson.scripts as Record<string, string>)['check:local']);
    for (const step of [
      'npm run compile',
      'npm run lint',
      'npm run format:check',
      'npm run verify:workflows',
      'npm audit --audit-level=moderate',
      'npm audit --omit=dev --audit-level=moderate',
      'npm run audit:release',
      'npm test',
      'npm run package',
      'npm run audit:release:packaged',
    ]) {
      expect(chain, step).toContain(step);
    }
  });

  it('resolves the packaged-VSIX audit target from the manifest version', () => {
    expect(resolveVsixArgument('--packaged', '0.7.1')).toBe('ai-limit-ledger-0.7.1.vsix');
    expect(resolveVsixArgument('--packaged', '1.2.3')).toBe('ai-limit-ledger-1.2.3.vsix');
    expect(resolveVsixArgument('some.vsix', '0.7.1')).toBe('some.vsix');
    expect(resolveVsixArgument(undefined, '0.7.1')).toBeUndefined();
  });
});

describe('Task 14.1: .vscode/extensions.json and settings.json', () => {
  it('recommends only allowlisted development extensions', () => {
    const listed = (recommendations.recommendations ?? []) as string[];
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) {
      expect(RECOMMENDED_EXTENSION_ALLOWLIST as Set<string>, id).toContain(id);
    }
    expect(listed).toContain('dbaeumer.vscode-eslint');
    expect(listed).toContain('esbenp.prettier-vscode');
  });

  it('never recommends the published extension as a development dependency', () => {
    const listed = (recommendations.recommendations ?? []) as string[];
    expect(listed).not.toContain(EXPECTED_EXTENSION_ID);
    expect(listed).not.toContain('local.ai-limit-ledger');
  });

  it('keeps workspace settings workspace-scoped and free of personal/global state', () => {
    for (const key of Object.keys(settings)) {
      for (const { name, pattern } of FORBIDDEN_WORKSPACE_SETTING_PATTERNS as Array<{
        name: string;
        pattern: RegExp;
      }>) {
        expect(pattern.test(key), `${key} [${name}]`).toBe(false);
      }
    }
  });

  it('contains no absolute path, username, or credential', () => {
    const serialized = JSON.stringify(settings);
    for (const pattern of ABSOLUTE_PATH_PATTERNS as RegExp[]) {
      pattern.lastIndex = 0;
      expect(pattern.test(serialized)).toBe(false);
    }
    for (const { name, pattern } of CREDENTIAL_PATTERNS as Array<{
      name: string;
      pattern: RegExp;
    }>) {
      pattern.lastIndex = 0;
      expect(pattern.test(serialized), name).toBe(false);
    }
  });

  it('wires the workspace TypeScript SDK, ESLint, Prettier, and exclusions', () => {
    expect(settings['typescript.tsdk']).toBe('node_modules/typescript/lib');
    expect(settings['eslint.enable']).toBe(true);
    expect(settings['editor.defaultFormatter']).toBe('esbenp.prettier-vscode');
    expect(settings['files.eol']).toBe('\n');
    expect(settings['files.exclude']).toHaveProperty('.tmp', true);
  });
});

describe('Task 14.1: development scratch state never reaches git or the VSIX', () => {
  it('gitignores .tmp/ and the Development Host areas underneath it', () => {
    expect(gitignore).toMatch(/^\.tmp\/$/m);
    expect(gitignore).toContain(`${DEV_HOST_TMP_ROOT}/`);
  });

  it('keeps the shared .vscode development configuration tracked, and nothing else', () => {
    expect(gitignore).toMatch(/^\.vscode\/\*$/m);
    for (const name of ['launch.json', 'tasks.json', 'settings.json', 'extensions.json']) {
      expect(gitignore, name).toContain(`!.vscode/${name}`);
    }
  });

  it('excludes .vscode/** and .tmp/** from the packaged VSIX', () => {
    expect(vscodeignore).toContain('.vscode/**');
    expect(vscodeignore).toContain('.tmp/**');
  });

  it('denies .vscode/ and .tmp/ entries in the packaged-VSIX audit as well', () => {
    const denies = (name: string) =>
      (VSIX_DENYLIST_PATTERNS as RegExp[]).some((pattern) => pattern.test(name));
    expect(denies('extension/.vscode/launch.json')).toBe(true);
    expect(denies('extension/.vscode/tasks.json')).toBe(true);
    expect(denies('extension/.tmp/vscode-dev/user-data/settings.json')).toBe(true);
    expect(denies('extension/out/extension.js')).toBe(false);
  });
});

describe('Task 14.1: development and installation documentation', () => {
  it('documents the normal profile / Development Host separation explicitly', () => {
    expect(development).toMatch(/Normal VS Code profile/);
    expect(development).toMatch(/Extension Development Host/);
    expect(development).toContain('fatihdumlupinar-dev.ai-limit-ledger');
    expect(development).toContain('local.ai-limit-ledger');
    expect(development).toContain('code --uninstall-extension "local.ai-limit-ledger"');
    expect(development).toContain('code --install-extension "fatihdumlupinar-dev.ai-limit-ledger"');
  });

  it('states that the Development Host never inherits real credentials or global settings', () => {
    expect(development).toMatch(/SecretStorage/);
    expect(development).toMatch(/never copies your SecretStorage/i);
    expect(development).toMatch(/changes no global VS Code setting/i);
  });

  it('covers the full development lifecycle a contributor needs', () => {
    for (const topic of [
      'npm ci',
      'Node 24',
      'Breakpoints',
      'npm run test:watch',
      'npm run check:local',
      'npm run package',
      'audit:release:packaged',
      'Release Candidate',
      'Finalize Release',
      'ROLLBACK.md',
    ]) {
      expect(development, topic).toContain(topic);
    }
  });

  it('is linked from README (EN/TR) and CONTRIBUTING', () => {
    const contributing = readFileSync(resolve(ROOT, 'CONTRIBUTING.md'), 'utf8');
    expect(readmeEn).toContain('docs/DEVELOPMENT.md');
    expect(readmeTr).toContain('docs/DEVELOPMENT.md');
    expect(contributing).toContain('docs/DEVELOPMENT.md');
  });

  it('documents the real Marketplace installation paths in both languages', () => {
    for (const readme of [readmeEn, readmeTr]) {
      expect(readme).toContain('@id:fatihdumlupinar-dev.ai-limit-ledger');
      expect(readme).toContain('code --install-extension "fatihdumlupinar-dev.ai-limit-ledger"');
      expect(readme).toContain('Ctrl+Shift+X');
      expect(readme).toContain(
        'https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger',
      );
    }
  });

  it('no longer claims the extension is unpublished or source-install-only', () => {
    expect(readmeEn).not.toMatch(/not yet published to the Visual Studio Code Marketplace/i);
    expect(readmeEn).not.toMatch(/install from source only/i);
    expect(readmeTr).not.toMatch(/henüz Visual Studio Code Marketplace'te yayınlanma/i);
    expect(readmeTr).not.toMatch(/yalnızca kaynaktan kurulum/i);
  });

  it('keeps the non-affiliation, privacy, preview, and provider-limitation disclaimers', () => {
    expect(readmeEn).toMatch(/^## Non-affiliation$/m);
    expect(readmeTr).toMatch(/^## Bağlantısızlık bildirimi$/m);
    expect(readmeEn).toMatch(/^## Known limitations$/m);
    expect(readmeTr).toMatch(/^## Bilinen sınırlamalar$/m);
    expect(readmeEn).toMatch(/preview/i);
    expect(readmeTr).toMatch(/önizleme/i);
    expect(readmeEn).toMatch(/experimental/i);
    expect(readmeTr).toMatch(/deneysel/i);
  });
});
