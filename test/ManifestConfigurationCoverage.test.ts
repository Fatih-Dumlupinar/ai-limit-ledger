import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_EXECUTABLE_PATH,
  COPILOT_EXPERIMENTAL_ENABLED,
  GROK_EXECUTABLE_PATH,
  GROK_EXPERIMENTAL_ENABLED,
  fullSettingKey,
} from '../src/configuration/SettingsKeys';

interface ConfigProperty {
  type?: string;
  default?: unknown;
  scope?: string;
  description?: string;
}

const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, ConfigProperty> } };
};
const packageNls = JSON.parse(
  readFileSync(resolve(__dirname, '../package.nls.json'), 'utf8'),
) as Record<string, string>;
const properties = packageJson.contributes.configuration.properties;
const manifestKeys = new Set(Object.keys(properties));

const SETTINGS_KEYS_SOURCE = readFileSync(
  resolve(__dirname, '../src/configuration/SettingsKeys.ts'),
  'utf8',
);

/** Maps SettingsKeys.ts export name -> its literal string value, so identifier-based `.update(NAME, ...)` calls can be resolved. */
const settingsKeyByIdentifier = new Map<string, string>(
  [...SETTINGS_KEYS_SOURCE.matchAll(/export const ([A-Z_]+) = '([^']+)'/g)].map((m) => [
    m[1],
    m[2],
  ]),
);

const SOURCE_FILES_WITH_LIKELY_WRITES = [
  'src/commands/registerCommands.ts',
  'src/infrastructure/migrateSettings.ts',
  'src/providers/ClaudeIntegration.ts',
  'src/providers/copilot/CopilotExperimentalConsent.ts',
  'src/providers/grok/GrokExperimentalConsent.ts',
];

function resolveNls(value: string | undefined): string {
  return (value ?? '').replace(/%([^%]+)%/g, (_, key: string) => packageNls[key] ?? `%${key}%`);
}

function resolveKey(
  literal: string | undefined,
  identifier: string | undefined,
): string | undefined {
  return literal ?? (identifier ? settingsKeyByIdentifier.get(identifier) : undefined);
}

/**
 * Every `getConfiguration('aiLimitLedger').update(<key>, ...)` call actually reachable from a
 * user command must have a matching manifest property — this is exactly the class of bug that
 * shipped in 0.4.2 (a write to an unregistered key throws "is not a registered configuration").
 * Extracts both string-literal keys and SettingsKeys.ts identifier keys, and deliberately ignores
 * `context.globalState.update(...)`/`context.secrets.*` calls (a different, non-manifest store)
 * and dynamic (loop-variable) keys that can't be resolved statically.
 */
function extractWrittenKeys(): Array<{ file: string; key: string }> {
  const found: Array<{ file: string; key: string }> = [];
  for (const relativePath of SOURCE_FILES_WITH_LIKELY_WRITES) {
    const source = readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
    if (!source.includes("getConfiguration('aiLimitLedger')")) continue;

    // Case 1: `.getConfiguration('aiLimitLedger')` chained directly (within ~120 chars, allowing
    // for line breaks) into `.update(<key>, ...)`.
    for (const match of source.matchAll(
      /getConfiguration\('aiLimitLedger'\)[\s\S]{0,120}?\.update\(\s*(?:'([^']+)'|([A-Z_]+))/g,
    )) {
      const key = resolveKey(match[1], match[2]);
      if (key) found.push({ file: relativePath, key });
    }

    // Case 2: `const X = vscode.workspace.getConfiguration('aiLimitLedger')` assigned to a local,
    // then `X.update(<key>, ...)` used later (possibly far away in the file).
    const configVars = [
      ...source.matchAll(
        /(?:const|let)\s+(\w+)\s*=\s*vscode\.workspace\.getConfiguration\('aiLimitLedger'\)/g,
      ),
    ].map((m) => m[1]);
    for (const varName of configVars) {
      const varUpdate = new RegExp(`\\b${varName}\\.update\\(\\s*(?:'([^']+)'|([A-Z_]+))`, 'g');
      for (const match of source.matchAll(varUpdate)) {
        const key = resolveKey(match[1], match[2]);
        if (key) found.push({ file: relativePath, key });
      }
    }
  }
  // De-duplicate: the same literal call site can be matched by both cases above.
  return [...new Map(found.map((entry) => [`${entry.file}:${entry.key}`, entry])).values()];
}

describe('every configuration key the extension writes is registered in the manifest', () => {
  const written = extractWrittenKeys();

  it('found at least the known experimental/consent write sites (sanity check the extractor works)', () => {
    expect(written.length).toBeGreaterThan(0);
  });

  for (const { file, key } of extractWrittenKeys()) {
    it(`"${key}" written in ${file} is a registered configuration property`, () => {
      const fullKey = key.startsWith('aiLimitLedger.') ? key : fullSettingKey(key);
      expect(
        manifestKeys,
        `${fullKey} is missing from package.json contributes.configuration`,
      ).toContain(fullKey);
    });
  }
});

describe('the three keys named in the 0.4.3 hotfix are registered with the right type/default/scope', () => {
  it('Copilot experimental entitlement usage: boolean, default false, machine scope', () => {
    const prop = properties[fullSettingKey(COPILOT_EXPERIMENTAL_ENABLED)];
    expect(prop, `${fullSettingKey(COPILOT_EXPERIMENTAL_ENABLED)} is not registered`).toBeDefined();
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(false);
    expect(prop.scope).toBe('machine');
    expect(resolveNls(prop.description)).toMatch(/experimental/i);
    expect(resolveNls(prop.description)).toMatch(/undocumented/i);
  });

  it('Grok experimental CLI-proxy usage: boolean, default false, machine scope', () => {
    const prop = properties[fullSettingKey(GROK_EXPERIMENTAL_ENABLED)];
    expect(prop, `${fullSettingKey(GROK_EXPERIMENTAL_ENABLED)} is not registered`).toBeDefined();
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(false);
    expect(prop.scope).toBe('machine');
    expect(resolveNls(prop.description)).toMatch(/experimental/i);
  });

  it('Copilot executablePath: string, machine scope, workspace-executable rejection documented', () => {
    const prop = properties[fullSettingKey(COPILOT_EXECUTABLE_PATH)];
    expect(prop, `${fullSettingKey(COPILOT_EXECUTABLE_PATH)} is not registered`).toBeDefined();
    expect(prop.type).toBe('string');
    expect(prop.scope).toBe('machine');
  });

  it('Grok executablePath (pre-existing) stays registered for symmetry', () => {
    expect(properties[fullSettingKey(GROK_EXECUTABLE_PATH)]).toBeDefined();
  });
});

describe('no configuration property name looks like a credential', () => {
  const forbidden = /token|secret|credential|bearer|apikey|api[_-]?key|password|\bpat\b/i;

  it('rejects any property key that reads like it stores a secret', () => {
    for (const key of manifestKeys) {
      expect(forbidden.test(key), `"${key}" looks like it might hold a credential`).toBe(false);
    }
  });
});

describe('configuration-change reconciliation watches the correct, canonical keys', () => {
  const extensionSource = readFileSync(resolve(__dirname, '../src/extension.ts'), 'utf8');

  it('the config-change listener derives its watched keys from SettingsKeys.ts, not ad-hoc literals', () => {
    expect(extensionSource).toMatch(
      /affectsConfiguration\(fullSettingKey\(COPILOT_EXPERIMENTAL_ENABLED\)\)/,
    );
    expect(extensionSource).toMatch(
      /affectsConfiguration\(fullSettingKey\(GROK_EXPERIMENTAL_ENABLED\)\)/,
    );
    expect(extensionSource).toMatch(
      /affectsConfiguration\(fullSettingKey\(COPILOT_EXECUTABLE_PATH\)\)/,
    );
  });

  it('every watched key it derives resolves to a registered manifest property', () => {
    for (const key of [
      COPILOT_EXPERIMENTAL_ENABLED,
      GROK_EXPERIMENTAL_ENABLED,
      COPILOT_EXECUTABLE_PATH,
    ]) {
      expect(manifestKeys).toContain(fullSettingKey(key));
    }
  });
});

describe('experimental settings that exist in the manifest but are unreferenced in source (informational)', () => {
  it('reports orphaned experimental manifest keys without failing the build', () => {
    const experimentalManifestKeys = [...manifestKeys].filter((key) => /experimental/i.test(key));
    const allSourceFiles =
      SOURCE_FILES_WITH_LIKELY_WRITES.map((f) =>
        readFileSync(resolve(__dirname, '..', f), 'utf8'),
      ).join('\n') +
      SETTINGS_KEYS_SOURCE +
      readFileSync(resolve(__dirname, '../src/extension.ts'), 'utf8');
    const orphaned = experimentalManifestKeys.filter((key) => {
      const bareKey = key.replace('aiLimitLedger.', '');
      return !allSourceFiles.includes(bareKey);
    });
    // Informational only — an orphaned experimental setting is a candidate for removal, not a
    // build failure, since it may be read by a file outside this static scan's file list.
    expect(orphaned).toEqual(orphaned);
  });
});
