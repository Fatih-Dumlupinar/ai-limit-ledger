import * as vscode from 'vscode';
import {
  LEGACY_CONFIGURATION_SECTION,
  COPILOT_EXPERIMENTAL_CONSENT_KEY,
  GROK_EXPERIMENTAL_CONSENT_KEY,
  PROVIDER_SELECTION_MIGRATION_KEY,
  SETTINGS_MIGRATION_VERSION_KEY,
  SETTING_KEYS,
} from './SettingsKeys';

export const SETTINGS_MIGRATION_VERSION = 2;
const CURRENT_PROVIDER_DEFAULT = ['codex', 'claude', 'copilot', 'grok'];
const LEGACY_PROVIDER_DEFAULT = ['codex', 'claude'];

function explicitValue(
  config: ReturnType<typeof vscode.workspace.getConfiguration>,
  key: string,
): unknown {
  const inspection = config.inspect<unknown>(key);
  return inspection?.workspaceFolderValue ?? inspection?.workspaceValue ?? inspection?.globalValue;
}

function sameProviderSelection(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

async function copyIfUnset(
  source: ReturnType<typeof vscode.workspace.getConfiguration>,
  target: ReturnType<typeof vscode.workspace.getConfiguration>,
  sourceKey: string,
  targetKey: string,
): Promise<void> {
  const value = explicitValue(source, sourceKey);
  if (value === undefined || explicitValue(target, targetKey) !== undefined) return;
  await target.update(targetKey, value, vscode.ConfigurationTarget.Global);
}

async function copyCurrentValueIfTargetUnset(
  config: ReturnType<typeof vscode.workspace.getConfiguration>,
  sourceKey: string,
  targetKey: string,
): Promise<void> {
  const value = explicitValue(config, sourceKey);
  if (value === undefined || explicitValue(config, targetKey) !== undefined) return;
  await config.update(targetKey, value, vscode.ConfigurationTarget.Global);
}

/** Versioned, idempotent migration. Invalid values are left in Settings for runtime diagnostics. */
export async function runSettingsMigration(context: vscode.ExtensionContext): Promise<void> {
  const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIGURATION_SECTION);
  const current = vscode.workspace.getConfiguration('aiLimitLedger');
  const version = context.globalState.get<number>(SETTINGS_MIGRATION_VERSION_KEY, 0);

  if (version < 1) {
    // Preserve the historic codexLimitBar migration exactly: only explicit global values move,
    // and never over an existing AI Limit Ledger value.
    for (const key of [
      SETTING_KEYS.codexExecutablePath,
      SETTING_KEYS.legacyRefreshIntervalSeconds,
      SETTING_KEYS.legacyShowWeeklyLimit,
      SETTING_KEYS.legacyCompactStatusBar,
      SETTING_KEYS.legacyPresentationMode,
      SETTING_KEYS.legacyWarningUsedPercent,
      SETTING_KEYS.legacyCriticalUsedPercent,
      SETTING_KEYS.legacyShowErrorNotifications,
    ]) {
      await copyIfUnset(legacy, current, key, key);
    }
  }

  if (version < 2) {
    // New settings receive a value only when a corresponding old setting was explicitly chosen.
    // The old percentage thresholds were "used" thresholds, so convert them to remaining values.
    const oldPresentation = explicitValue(current, SETTING_KEYS.legacyPresentationMode);
    const oldRefresh = explicitValue(current, SETTING_KEYS.legacyRefreshIntervalSeconds);
    if (
      typeof oldRefresh === 'number' &&
      Number.isFinite(oldRefresh) &&
      explicitValue(current, SETTING_KEYS.codexFallbackRefreshSeconds) === undefined
    ) {
      await current.update(
        SETTING_KEYS.codexFallbackRefreshSeconds,
        Math.min(900, Math.max(30, oldRefresh)),
        vscode.ConfigurationTarget.Global,
      );
    }
    if (oldPresentation === 'remaining' || oldPresentation === 'used')
      await copyCurrentValueIfTargetUnset(
        current,
        SETTING_KEYS.legacyPresentationMode,
        SETTING_KEYS.displayPercentageMode,
      );
    const oldCompact = explicitValue(current, SETTING_KEYS.legacyCompactStatusBar);
    if (explicitValue(current, SETTING_KEYS.statusBarMode) === undefined) {
      const migratedStatusBarMode =
        oldCompact === true || oldPresentation === 'compact'
          ? 'compact'
          : oldPresentation === 'remaining' || oldPresentation === 'used'
            ? 'detailed'
            : undefined;
      if (migratedStatusBarMode)
        await current.update(
          SETTING_KEYS.statusBarMode,
          migratedStatusBarMode,
          vscode.ConfigurationTarget.Global,
        );
    }

    const oldWarning = explicitValue(current, SETTING_KEYS.legacyWarningUsedPercent);
    if (
      typeof oldWarning === 'number' &&
      Number.isFinite(oldWarning) &&
      explicitValue(current, SETTING_KEYS.warningRemainingPercent) === undefined
    ) {
      await current.update(
        SETTING_KEYS.warningRemainingPercent,
        100 - oldWarning,
        vscode.ConfigurationTarget.Global,
      );
    }
    const oldCritical = explicitValue(current, SETTING_KEYS.legacyCriticalUsedPercent);
    if (
      typeof oldCritical === 'number' &&
      Number.isFinite(oldCritical) &&
      explicitValue(current, SETTING_KEYS.criticalRemainingPercent) === undefined
    ) {
      await current.update(
        SETTING_KEYS.criticalRemainingPercent,
        100 - oldCritical,
        vscode.ConfigurationTarget.Global,
      );
    }
    const oldNotifications = explicitValue(current, SETTING_KEYS.legacyShowErrorNotifications);
    if (
      typeof oldNotifications === 'boolean' &&
      explicitValue(current, SETTING_KEYS.notificationsLevel) === undefined
    ) {
      // The old boolean meant opt-in error popups, never warning popups.
      await current.update(
        SETTING_KEYS.notificationsLevel,
        oldNotifications ? 'errors' : 'off',
        vscode.ConfigurationTarget.Global,
      );
    }
    // Before consent metadata existed, these booleans were only writable through the explicit
    // consent commands. Preserve that prior opt-in while keeping future direct setting edits
    // unable to activate an experimental transport on their own.
    const priorConsent = [
      [SETTING_KEYS.copilotExperimentalEnabled, COPILOT_EXPERIMENTAL_CONSENT_KEY],
      [SETTING_KEYS.grokExperimentalEnabled, GROK_EXPERIMENTAL_CONSENT_KEY],
    ] as const;
    for (const [settingKey, consentKey] of priorConsent) {
      if (
        current.get<boolean>(settingKey, false) &&
        context.globalState.get<boolean | undefined>(consentKey) === undefined
      ) {
        await context.globalState.update(consentKey, true);
      }
    }
  }

  // Keep this migration independently idempotent for installations that already ran the older
  // provider migration but never received a version marker.
  if (!context.globalState.get<boolean>(PROVIDER_SELECTION_MIGRATION_KEY, false)) {
    const inspection = current.inspect<unknown>(SETTING_KEYS.providers);
    const explicit = explicitValue(current, SETTING_KEYS.providers);
    const effective = current.get<unknown>(SETTING_KEYS.providers, CURRENT_PROVIDER_DEFAULT);
    if (
      explicit === undefined &&
      (sameProviderSelection(inspection?.defaultValue, LEGACY_PROVIDER_DEFAULT) ||
        sameProviderSelection(effective, LEGACY_PROVIDER_DEFAULT))
    ) {
      await current.update(
        SETTING_KEYS.providers,
        CURRENT_PROVIDER_DEFAULT,
        vscode.ConfigurationTarget.Global,
      );
    }
    await context.globalState.update(PROVIDER_SELECTION_MIGRATION_KEY, true);
  }
  if (version < SETTINGS_MIGRATION_VERSION)
    await context.globalState.update(SETTINGS_MIGRATION_VERSION_KEY, SETTINGS_MIGRATION_VERSION);
}
