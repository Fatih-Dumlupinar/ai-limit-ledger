import * as vscode from 'vscode';
import { GROK_EXPERIMENTAL_ENABLED } from '../../configuration/SettingsKeys';
import type { SettingsService } from '../../configuration/SettingsService';
import { localization } from '../../localization/LocalizationService';

/** Reads the `aiLimitLedger.grok.experimentalCliProxyUsage.enabled` machine-scope setting; defaults to opted-out. */
export function grokExperimentalUsageEnabled(valueProvider?: () => boolean): boolean {
  if (valueProvider) return valueProvider();
  return vscode.workspace
    .getConfiguration('aiLimitLedger')
    .get<boolean>(GROK_EXPERIMENTAL_ENABLED, false);
}

/**
 * Writes the setting and reads it back to confirm VS Code actually accepted the write — a write
 * to an unregistered configuration key throws instead of silently no-opping, and this must never
 * be reported to the user as success (or trigger `onChanged`) when that happens.
 */
async function setGrokExperimentalUsageEnabled(
  enabled: boolean,
  settings?: SettingsService,
): Promise<boolean> {
  if (settings) {
    try {
      await settings.update(GROK_EXPERIMENTAL_ENABLED, enabled, vscode.ConfigurationTarget.Global);
    } catch {
      return false;
    }
    return settings.get<boolean>(GROK_EXPERIMENTAL_ENABLED) === enabled;
  }
  const config = vscode.workspace.getConfiguration('aiLimitLedger');
  try {
    await config.update(GROK_EXPERIMENTAL_ENABLED, enabled, vscode.ConfigurationTarget.Global);
  } catch {
    return false;
  }
  return (
    vscode.workspace
      .getConfiguration('aiLimitLedger')
      .get<boolean>(GROK_EXPERIMENTAL_ENABLED, !enabled) === enabled
  );
}

async function showConsentDialog(): Promise<'enable' | 'cancel'> {
  const enable = localization.t('experimentalConsentEnable');
  const choice = await vscode.window.showWarningMessage(
    localization.t('experimentalGrokConsent'),
    { modal: true },
    enable,
  );
  return choice === enable ? 'enable' : 'cancel';
}

/** "Enable Experimental Grok Usage" — a separate, explicit opt-in from the existing enable/disable Grok Usage pair. Idempotent: running it again while already enabled just re-shows consent and re-confirms the setting. */
export async function enableExperimentalGrokUsage(
  onChanged: () => void = () => undefined,
  options: {
    notify?: boolean;
    onOutcome?: (outcome: 'cancelled' | 'error') => void;
    onConsent?: () => void | PromiseLike<void>;
    settings?: SettingsService;
  } = {},
): Promise<boolean> {
  const notify = options.notify ?? true;
  const choice = await showConsentDialog();
  if (choice !== 'enable') {
    options.onOutcome?.('cancelled');
    if (notify)
      void vscode.window.showInformationMessage(
        localization.t('experimentalUsageNotEnabled', { provider: 'Grok' }),
      );
    return false;
  }
  const wrote = await setGrokExperimentalUsageEnabled(true, options.settings);
  if (!wrote) {
    options.onOutcome?.('error');
    if (notify)
      void vscode.window.showErrorMessage(
        localization.t('experimentalUsageSaveFailed', {
          provider: 'Grok',
          setting: GROK_EXPERIMENTAL_ENABLED,
        }),
      );
    return false;
  }
  await options.onConsent?.();
  onChanged();
  if (notify) void vscode.window.showInformationMessage(localization.t('experimentalGrokEnabled'));
  return true;
}

export async function disableExperimentalGrokUsage(
  onChanged: () => void = () => undefined,
  options: {
    notify?: boolean;
    onOutcome?: (outcome: 'cancelled' | 'error') => void;
    onConsent?: () => void | PromiseLike<void>;
    settings?: SettingsService;
  } = {},
): Promise<boolean> {
  const notify = options.notify ?? true;
  const wrote = await setGrokExperimentalUsageEnabled(false, options.settings);
  if (!wrote) {
    options.onOutcome?.('error');
    if (notify)
      void vscode.window.showErrorMessage(
        localization.t('experimentalUsageSaveFailed', {
          provider: 'Grok',
          setting: GROK_EXPERIMENTAL_ENABLED,
        }),
      );
    return false;
  }
  await options.onConsent?.();
  onChanged();
  if (notify) void vscode.window.showInformationMessage(localization.t('experimentalGrokDisabled'));
  return true;
}
