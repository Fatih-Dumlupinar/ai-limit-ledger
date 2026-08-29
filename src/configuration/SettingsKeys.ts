/** Canonical configuration keys, relative to the `aiLimitLedger` section. */
export const SETTING_KEYS = {
  codexExecutablePath: 'codexExecutablePath',
  providers: 'providers',
  legacyRefreshIntervalSeconds: 'refreshIntervalSeconds',
  dashboardMode: 'dashboard.mode',
  dashboardProviderVisibility: 'dashboard.providerVisibility',
  dashboardProviderOrder: 'dashboard.providerOrder',
  dashboardOpenOnStartup: 'dashboard.openOnStartup',
  dashboardShowAvailableIntegrations: 'dashboard.showAvailableIntegrations',
  dashboardInsightsMode: 'dashboard.insightsMode',
  codexFallbackRefreshSeconds: 'refresh.codexFallbackSeconds',
  claudeStatusLineRefreshSeconds: 'refresh.claudeStatusLineSeconds',
  manualRefreshCooldownSeconds: 'refresh.manualCooldownSeconds',
  claudeOAuthRefreshSeconds: 'claude.experimentalOAuthUsage.refreshSeconds',
  copilotRefreshSeconds: 'copilot.refreshSeconds',
  grokRefreshSeconds: 'grok.refreshSeconds',
  statusBarMode: 'statusBar.mode',
  statusBarProviderOrder: 'statusBar.providerOrder',
  displayPercentageMode: 'display.percentageMode',
  displayLanguage: 'display.language',
  displayTimeFormat: 'display.timeFormat',
  tooltipDensity: 'tooltip.density',
  warningRemainingPercent: 'thresholds.warningRemainingPercent',
  criticalRemainingPercent: 'thresholds.criticalRemainingPercent',
  notificationsLevel: 'notifications.level',
  notificationsShowRecoveryActions: 'notifications.showRecoveryActions',
  loggingLevel: 'logging.level',
  cacheMaxAgeHours: 'cache.maxAgeHours',
  cacheShowExpiredInDashboard: 'cache.showExpiredInDashboard',
  claudeAutoRepair: 'claude.autoRepair',
  claudeOAuthEnabled: 'claude.experimentalOAuthUsage.enabled',
  copilotPlan: 'copilot.plan',
  copilotCustomMonthlyCredits: 'copilot.customMonthlyCredits',
  copilotExecutablePath: 'copilot.executablePath',
  copilotExperimentalEnabled: 'copilot.experimentalEntitlementUsage.enabled',
  grokExecutablePath: 'grok.executablePath',
  grokExperimentalEnabled: 'grok.experimentalCliProxyUsage.enabled',
  legacyShowWeeklyLimit: 'showWeeklyLimit',
  legacyCompactStatusBar: 'compactStatusBar',
  legacyPresentationMode: 'presentationMode',
  legacyWarningUsedPercent: 'warningUsedPercent',
  legacyCriticalUsedPercent: 'criticalUsedPercent',
  legacyShowErrorNotifications: 'showErrorNotifications',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

// Keep these literal aliases for compatibility with static manifest-coverage checks and
// extensions importing the pre-registry names. Runtime code should prefer SETTING_KEYS.
export const COPILOT_EXPERIMENTAL_ENABLED = 'copilot.experimentalEntitlementUsage.enabled';
export const COPILOT_EXECUTABLE_PATH = 'copilot.executablePath';
export const GROK_EXPERIMENTAL_ENABLED = 'grok.experimentalCliProxyUsage.enabled';
export const GROK_EXECUTABLE_PATH = 'grok.executablePath';
export const DASHBOARD_MODE = 'dashboard.mode';
export const PROVIDERS = 'providers';
export const CODEX_EXECUTABLE_PATH = 'codexExecutablePath';
export const CLAUDE_AUTO_REPAIR = 'claude.autoRepair';
export const CLAUDE_OAUTH_ENABLED = 'claude.experimentalOAuthUsage.enabled';
export const CLAUDE_OAUTH_REFRESH_SECONDS = 'claude.experimentalOAuthUsage.refreshSeconds';
export const STATUS_BAR_MODE = 'statusBar.mode';
export const DISPLAY_PERCENTAGE_MODE = 'display.percentageMode';
export const TOOLTIP_DENSITY = 'tooltip.density';

export const SETTINGS_SECTION = 'aiLimitLedger';
export const LEGACY_CONFIGURATION_SECTION = 'codexLimitBar';
export const SETTINGS_MIGRATION_VERSION_KEY = 'aiLimitLedger.settingsMigrationVersion';
export const PROVIDER_SELECTION_MIGRATION_KEY = 'aiLimitLedger.migration.providerSelectionV040';
export const COPILOT_EXPERIMENTAL_CONSENT_KEY =
  'aiLimitLedger.experimentalConsent.copilotEntitlementUsage.v1';
export const GROK_EXPERIMENTAL_CONSENT_KEY =
  'aiLimitLedger.experimentalConsent.grokCliProxyUsage.v1';

export function fullSettingKey(key: string): string {
  return `${SETTINGS_SECTION}.${key}`;
}
