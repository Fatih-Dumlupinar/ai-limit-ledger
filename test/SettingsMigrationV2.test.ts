import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  runSettingsMigration,
  SETTINGS_MIGRATION_VERSION,
} from '../src/configuration/SettingsMigration';
import {
  COPILOT_EXPERIMENTAL_CONSENT_KEY,
  SETTING_KEYS,
  SETTINGS_MIGRATION_VERSION_KEY,
} from '../src/configuration/SettingsKeys';

function globalState(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (values.get(key) as T | undefined) ?? (defaultValue as T);
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

afterEach(() => vscode.__resetConfigMocks?.());

describe('version 2 settings migration', () => {
  it('declares a versioned migration marker', () => {
    expect(SETTINGS_MIGRATION_VERSION).toBe(2);
    expect(SETTINGS_MIGRATION_VERSION_KEY).toContain('settingsMigrationVersion');
  });

  it('migrates legacy percentage, cadence, status-bar and notification values', async () => {
    const current = vscode.workspace.getConfiguration('aiLimitLedger');
    await current.update(SETTING_KEYS.legacyPresentationMode, 'used');
    await current.update(SETTING_KEYS.legacyRefreshIntervalSeconds, 600);
    await current.update(SETTING_KEYS.legacyWarningUsedPercent, 80);
    await current.update(SETTING_KEYS.legacyCriticalUsedPercent, 90);
    await current.update(SETTING_KEYS.legacyShowErrorNotifications, false);
    const state = globalState({ [SETTINGS_MIGRATION_VERSION_KEY]: 1 });
    await runSettingsMigration({ globalState: state } as never);
    expect(current.get(SETTING_KEYS.displayPercentageMode)).toBe('used');
    expect(current.get(SETTING_KEYS.statusBarMode)).toBe('detailed');
    expect(current.get(SETTING_KEYS.codexFallbackRefreshSeconds)).toBe(600);
    expect(current.get(SETTING_KEYS.warningRemainingPercent)).toBe(20);
    expect(current.get(SETTING_KEYS.criticalRemainingPercent)).toBe(10);
    expect(current.get(SETTING_KEYS.notificationsLevel)).toBe('off');
  });

  it('does not overwrite an explicitly configured v2 setting', async () => {
    const current = vscode.workspace.getConfiguration('aiLimitLedger');
    await current.update(SETTING_KEYS.legacyPresentationMode, 'used');
    await current.update(SETTING_KEYS.displayPercentageMode, 'both');
    const state = globalState({ [SETTINGS_MIGRATION_VERSION_KEY]: 1 });
    await runSettingsMigration({ globalState: state } as never);
    expect(current.get(SETTING_KEYS.displayPercentageMode)).toBe('both');
  });

  it('preserves prior experimental opt-in as consent metadata exactly once', async () => {
    const current = vscode.workspace.getConfiguration('aiLimitLedger');
    await current.update(SETTING_KEYS.copilotExperimentalEnabled, true);
    const state = globalState({ [SETTINGS_MIGRATION_VERSION_KEY]: 1 });
    await runSettingsMigration({ globalState: state } as never);
    expect(state.get(COPILOT_EXPERIMENTAL_CONSENT_KEY)).toBe(true);
    expect(state.get(SETTINGS_MIGRATION_VERSION_KEY)).toBe(SETTINGS_MIGRATION_VERSION);
  });
});
