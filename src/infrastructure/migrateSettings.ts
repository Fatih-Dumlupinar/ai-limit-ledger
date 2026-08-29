import * as vscode from 'vscode';
import { PROVIDER_SELECTION_MIGRATION_KEY } from '../configuration/SettingsKeys';
import { runSettingsMigration } from '../configuration/SettingsMigration';

export { PROVIDER_SELECTION_MIGRATION_KEY };

/** Compatibility entry point retained for activation and older imports. */
export async function migrateSettings(context: vscode.ExtensionContext): Promise<void> {
  await runSettingsMigration(context);
}
