import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
  contributes: { commands: Array<{ command: string; title: string }> };
};
const packageNls = JSON.parse(
  readFileSync(resolve(__dirname, '../package.nls.json'), 'utf8'),
) as Record<string, string>;
const registerCommandsSource = readFileSync(
  resolve(__dirname, '../src/commands/registerCommands.ts'),
  'utf8',
);

function registeredCommandIds(source: string): string[] {
  return [...source.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((match) => match[1]);
}

function resolveNls(value: string | undefined): string {
  return (value ?? '').replace(/%([^%]+)%/g, (_, key: string) => packageNls[key] ?? `%${key}%`);
}

describe('command manifest ↔ registration consistency', () => {
  const manifestIds = packageJson.contributes.commands.map((c) => c.command);
  const registeredIds = registeredCommandIds(registerCommandsSource);

  it('registers every command declared in the package.json manifest', () => {
    for (const id of manifestIds) {
      expect(registeredIds, `manifest command "${id}" has no registerCommand call`).toContain(id);
    }
  });

  it('declares a manifest contribution for every registered user command', () => {
    for (const id of registeredIds) {
      expect(
        manifestIds,
        `registered command "${id}" is missing from contributes.commands`,
      ).toContain(id);
    }
  });

  it('has no duplicate command ids in the manifest', () => {
    expect(new Set(manifestIds).size).toBe(manifestIds.length);
  });
});

describe('Claude enable command title (regression)', () => {
  it('keeps the discoverable "Enable Claude Code Integration" title, not an internal rename', () => {
    const entry = packageJson.contributes.commands.find(
      (c) => c.command === 'aiLimitLedger.enableClaudeCode',
    );
    expect(resolveNls(entry?.title)).toBe('AI Limit Ledger: Enable Claude Code Integration');
  });

  it('keeps the command id stable across the title fix (backward compatibility)', () => {
    const entry = packageJson.contributes.commands.find(
      (c) => c.command === 'aiLimitLedger.enableClaudeCode',
    );
    expect(entry).toBeDefined();
  });
});

describe('experimental CLI-free usage commands', () => {
  it('declares enable/disable/docs commands with stable ids', () => {
    const ids = packageJson.contributes.commands.map((c) => c.command);
    expect(ids).toContain('aiLimitLedger.enableClaudeOAuthUsage');
    expect(ids).toContain('aiLimitLedger.disableClaudeOAuthUsage');
    expect(ids).toContain('aiLimitLedger.openExperimentalClaudeUsageDocs');
  });
});

describe('provider-specific refresh commands', () => {
  it('declares the Codex and Claude refresh commands with their provider-specific titles', () => {
    const commands = packageJson.contributes.commands;
    expect(
      resolveNls(
        commands.find((command) => command.command === 'aiLimitLedger.refreshCodex')?.title,
      ),
    ).toBe('AI Limit Ledger: Refresh Codex Usage');
    expect(
      resolveNls(
        commands.find((command) => command.command === 'aiLimitLedger.refreshClaude')?.title,
      ),
    ).toBe('AI Limit Ledger: Refresh Claude Usage');
  });
});

describe('dashboard renderer commands and mode', () => {
  it('declares all public dashboard renderer commands', () => {
    const ids = packageJson.contributes.commands.map((command) => command.command);
    expect(ids).toContain('aiLimitLedger.openSafeDashboard');
    expect(ids).toContain('aiLimitLedger.openRichDashboard');
    expect(ids).toContain('aiLimitLedger.selectDashboardMode');
  });

  it('registers the dashboard mode as a machine-scoped enum with auto default', () => {
    const property = packageJson2Properties()['aiLimitLedger.dashboard.mode'];
    expect(property).toBeDefined();
    expect(property.scope).toBe('machine');
    expect(property.default).toBe('auto');
  });
});

describe('experimental Copilot/Grok billing fallback commands', () => {
  it('declares the four net-new opt-in commands with stable ids', () => {
    const ids = packageJson.contributes.commands.map((c) => c.command);
    expect(ids).toContain('aiLimitLedger.enableExperimentalCopilotUsage');
    expect(ids).toContain('aiLimitLedger.disableExperimentalCopilotUsage');
    expect(ids).toContain('aiLimitLedger.enableExperimentalGrokUsage');
    expect(ids).toContain('aiLimitLedger.disableExperimentalGrokUsage');
  });

  it('reuses the existing refresh/diagnose commands rather than duplicating them', () => {
    const ids = packageJson.contributes.commands.map((c) => c.command);
    expect(ids).toContain('aiLimitLedger.refreshCopilotUsage');
    expect(ids).toContain('aiLimitLedger.diagnoseCopilotIntegration');
    expect(ids).toContain('aiLimitLedger.refreshGrokUsage');
    expect(ids).toContain('aiLimitLedger.diagnoseGrokIntegration');
  });

  it('declares the two new experimental settings and the Copilot CLI path override, all machine-scoped', () => {
    const props = packageJson2Properties();
    expect(props['aiLimitLedger.copilot.experimentalEntitlementUsage.enabled'].scope).toBe(
      'machine',
    );
    expect(props['aiLimitLedger.copilot.experimentalEntitlementUsage.enabled'].default).toBe(false);
    expect(props['aiLimitLedger.grok.experimentalCliProxyUsage.enabled'].scope).toBe('machine');
    expect(props['aiLimitLedger.grok.experimentalCliProxyUsage.enabled'].default).toBe(false);
    expect(props['aiLimitLedger.copilot.executablePath'].default).toBe('auto');
  });
});

function packageJson2Properties(): Record<string, { scope?: string; default?: unknown }> {
  const raw = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
    contributes: {
      configuration: { properties: Record<string, { scope?: string; default?: unknown }> };
    };
  };
  return raw.contributes.configuration.properties;
}
