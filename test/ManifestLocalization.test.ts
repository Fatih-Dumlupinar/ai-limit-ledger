import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Manifest = {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    configuration: { title: string; properties: Record<string, ManifestProperty> };
  };
};
type ManifestProperty = {
  description?: string;
  markdownDescription?: string;
  enumDescriptions?: string[];
};

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf8'),
) as Manifest;
const english = JSON.parse(
  readFileSync(resolve(__dirname, '../package.nls.json'), 'utf8'),
) as Record<string, string>;
const turkish = JSON.parse(
  readFileSync(resolve(__dirname, '../package.nls.tr.json'), 'utf8'),
) as Record<string, string>;

function placeholders(value: string): string[] {
  return [...value.matchAll(/%([^%]+)%/g)].map((match) => match[1]);
}

function contributionStrings(): string[] {
  const values = [manifest.contributes.configuration.title];
  values.push(...manifest.contributes.commands.map((command) => command.title));
  for (const property of Object.values(manifest.contributes.configuration.properties)) {
    if (property.description) values.push(property.description);
    if (property.markdownDescription) values.push(property.markdownDescription);
    values.push(...(property.enumDescriptions ?? []));
  }
  return values;
}

describe('VS Code manifest localization', () => {
  it('ships both default and Turkish NLS catalogs', () => {
    expect(Object.keys(english).length).toBeGreaterThan(0);
    expect(Object.keys(turkish).length).toBeGreaterThan(0);
  });

  it('keeps the NLS key sets exactly equal', () => {
    expect(Object.keys(english).sort()).toEqual(Object.keys(turkish).sort());
  });

  it('resolves every manifest placeholder in both catalogs', () => {
    for (const value of contributionStrings()) {
      for (const key of placeholders(value)) {
        expect(english[key], `missing default NLS key ${key}`).toBeTruthy();
        expect(turkish[key], `missing Turkish NLS key ${key}`).toBeTruthy();
      }
    }
  });

  it('uses placeholders for all user-facing command titles', () => {
    expect(manifest.contributes.commands.length).toBeGreaterThan(20);
    for (const command of manifest.contributes.commands)
      expect(command.title, command.command).toMatch(/^%[^%]+%$/);
  });

  it('uses placeholders for the configuration title and descriptions', () => {
    expect(manifest.contributes.configuration.title).toMatch(/^%[^%]+%$/);
    for (const [key, property] of Object.entries(manifest.contributes.configuration.properties)) {
      expect(property.description ?? property.markdownDescription, key).toMatch(/^%[^%]+%$/);
      for (const description of property.enumDescriptions ?? [])
        expect(description, `${key} enum description`).toMatch(/^%[^%]+%$/);
    }
  });

  it('keeps command and configuration machine identifiers stable and non-localized', () => {
    for (const command of manifest.contributes.commands) expect(command.command).not.toMatch(/%/);
    for (const key of Object.keys(manifest.contributes.configuration.properties))
      expect(key).not.toMatch(/%/);
    expect(Object.keys(manifest.contributes.configuration.properties)).toContain(
      'aiLimitLedger.display.language',
    );
  });

  it('does not pretend display.language can translate manifest contributions live', () => {
    const text = `${english['config.language']} ${turkish['config.language']}`;
    expect(text).toMatch(/language|dil/i);
    expect(manifest.contributes.commands[0]?.title).toMatch(/^%/);
  });
});
