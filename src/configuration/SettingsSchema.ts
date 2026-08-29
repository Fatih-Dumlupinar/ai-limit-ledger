import { SETTING_KEYS, type SettingKey } from './SettingsKeys';

export type SettingType = 'string' | 'number' | 'boolean' | 'array';
export type SettingScope = 'window' | 'machine' | 'resource';
export type SettingCategory =
  | 'providers'
  | 'dashboard'
  | 'status-bar'
  | 'display'
  | 'refresh'
  | 'notifications'
  | 'logging'
  | 'cache'
  | 'experimental'
  | 'executables'
  | 'advanced';

export interface SettingDefinition<T = unknown> {
  key: SettingKey;
  type: SettingType;
  default: T;
  scope: SettingScope;
  category: SettingCategory;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  uniqueItems?: boolean;
  sensitive: boolean;
  live: boolean;
  requiresProviderDetection: boolean;
  requiresTimerReschedule: boolean;
  migrationAliases: readonly string[];
  legacy?: boolean;
}

const definition = <T>(value: SettingDefinition<T>): SettingDefinition<T> => value;

const common = {
  sensitive: false,
  live: true,
  requiresProviderDetection: false,
  requiresTimerReschedule: false,
  migrationAliases: [],
} as const;

/** The runtime settings contract. Manifest coverage tests keep this list in sync with package.json. */
export const SETTINGS_SCHEMA = [
  definition({
    key: SETTING_KEYS.codexExecutablePath,
    type: 'string',
    default: 'auto',
    scope: 'machine',
    category: 'executables',
    ...common,
    sensitive: true,
    requiresProviderDetection: true,
  }),
  definition({
    key: SETTING_KEYS.providers,
    type: 'array',
    default: ['codex', 'claude', 'copilot', 'grok'],
    scope: 'window',
    category: 'providers',
    enum: ['codex', 'claude', 'copilot', 'grok'],
    uniqueItems: true,
    ...common,
  }),
  definition({
    key: SETTING_KEYS.legacyRefreshIntervalSeconds,
    type: 'number',
    default: 1800,
    minimum: 1800,
    maximum: 3600,
    scope: 'window',
    category: 'advanced',
    ...common,
    live: false,
    migrationAliases: ['codexLimitBar.refreshIntervalSeconds'],
    legacy: true,
  }),
  definition({
    key: SETTING_KEYS.dashboardMode,
    type: 'string',
    default: 'auto',
    enum: ['auto', 'rich-webview', 'safe-native'],
    scope: 'machine',
    category: 'dashboard',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.dashboardProviderVisibility,
    type: 'string',
    default: 'auto',
    enum: ['auto', 'active-only', 'all-supported'],
    scope: 'window',
    category: 'dashboard',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.dashboardProviderOrder,
    type: 'array',
    default: ['codex', 'claude', 'copilot', 'grok'],
    enum: ['codex', 'claude', 'copilot', 'grok'],
    uniqueItems: true,
    scope: 'window',
    category: 'dashboard',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.dashboardOpenOnStartup,
    type: 'boolean',
    default: false,
    scope: 'window',
    category: 'dashboard',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.dashboardShowAvailableIntegrations,
    type: 'boolean',
    default: true,
    scope: 'window',
    category: 'dashboard',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.dashboardInsightsMode,
    type: 'string',
    default: 'summary',
    enum: ['summary', 'detailed', 'hidden'],
    scope: 'window',
    category: 'dashboard',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.codexFallbackRefreshSeconds,
    type: 'number',
    default: 60,
    minimum: 30,
    maximum: 900,
    scope: 'machine',
    category: 'refresh',
    ...common,
    requiresTimerReschedule: true,
    migrationAliases: ['refreshIntervalSeconds'],
  }),
  definition({
    key: SETTING_KEYS.claudeStatusLineRefreshSeconds,
    type: 'number',
    default: 15,
    minimum: 5,
    maximum: 300,
    scope: 'machine',
    category: 'refresh',
    ...common,
    requiresTimerReschedule: true,
  }),
  definition({
    key: SETTING_KEYS.manualRefreshCooldownSeconds,
    type: 'number',
    default: 10,
    minimum: 5,
    maximum: 60,
    scope: 'machine',
    category: 'refresh',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.claudeOAuthRefreshSeconds,
    type: 'number',
    default: 120,
    minimum: 120,
    maximum: 3600,
    scope: 'machine',
    category: 'refresh',
    ...common,
    requiresTimerReschedule: true,
  }),
  definition({
    key: SETTING_KEYS.copilotRefreshSeconds,
    type: 'number',
    default: 300,
    minimum: 300,
    maximum: 3600,
    scope: 'machine',
    category: 'refresh',
    ...common,
    requiresTimerReschedule: true,
  }),
  definition({
    key: SETTING_KEYS.grokRefreshSeconds,
    type: 'number',
    default: 300,
    minimum: 300,
    maximum: 3600,
    scope: 'machine',
    category: 'refresh',
    ...common,
    requiresTimerReschedule: true,
  }),
  definition({
    key: SETTING_KEYS.statusBarMode,
    type: 'string',
    default: 'compact',
    enum: ['compact', 'detailed', 'hidden'],
    scope: 'window',
    category: 'status-bar',
    ...common,
    migrationAliases: ['compactStatusBar'],
  }),
  definition({
    key: SETTING_KEYS.statusBarProviderOrder,
    type: 'array',
    default: ['codex', 'claude', 'copilot', 'grok'],
    enum: ['codex', 'claude', 'copilot', 'grok'],
    uniqueItems: true,
    scope: 'window',
    category: 'status-bar',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.displayPercentageMode,
    type: 'string',
    default: 'remaining',
    enum: ['remaining', 'used', 'both'],
    scope: 'window',
    category: 'display',
    ...common,
    migrationAliases: ['presentationMode'],
  }),
  definition({
    key: SETTING_KEYS.displayLanguage,
    type: 'string',
    default: 'auto',
    enum: ['auto', 'en', 'tr'],
    scope: 'window',
    category: 'display',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.displayTimeFormat,
    type: 'string',
    default: 'both',
    enum: ['locale', 'relative', 'absolute', 'both'],
    scope: 'window',
    category: 'display',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.tooltipDensity,
    type: 'string',
    default: 'detailed',
    enum: ['compact', 'detailed'],
    scope: 'window',
    category: 'display',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.warningRemainingPercent,
    type: 'number',
    default: 30,
    minimum: 1,
    maximum: 99,
    scope: 'window',
    category: 'display',
    ...common,
    migrationAliases: ['warningUsedPercent'],
  }),
  definition({
    key: SETTING_KEYS.criticalRemainingPercent,
    type: 'number',
    default: 10,
    minimum: 0,
    maximum: 98,
    scope: 'window',
    category: 'display',
    ...common,
    migrationAliases: ['criticalUsedPercent'],
  }),
  definition({
    key: SETTING_KEYS.notificationsLevel,
    type: 'string',
    default: 'errors',
    enum: ['off', 'errors', 'warnings-and-errors'],
    scope: 'window',
    category: 'notifications',
    ...common,
    migrationAliases: ['showErrorNotifications'],
  }),
  definition({
    key: SETTING_KEYS.notificationsShowRecoveryActions,
    type: 'boolean',
    default: true,
    scope: 'window',
    category: 'notifications',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.loggingLevel,
    type: 'string',
    default: 'info',
    enum: ['error', 'warn', 'info', 'debug'],
    scope: 'window',
    category: 'logging',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.cacheMaxAgeHours,
    type: 'number',
    default: 24,
    minimum: 1,
    maximum: 168,
    scope: 'window',
    category: 'cache',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.cacheShowExpiredInDashboard,
    type: 'boolean',
    default: false,
    scope: 'window',
    category: 'cache',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.claudeAutoRepair,
    type: 'boolean',
    default: true,
    scope: 'machine',
    category: 'advanced',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.claudeOAuthEnabled,
    type: 'boolean',
    default: false,
    scope: 'machine',
    category: 'experimental',
    ...common,
    requiresTimerReschedule: true,
  }),
  definition({
    key: SETTING_KEYS.copilotPlan,
    type: 'string',
    default: 'auto',
    enum: ['auto', 'pro', 'proPlus', 'max', 'custom'],
    scope: 'machine',
    category: 'providers',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.copilotCustomMonthlyCredits,
    type: 'number',
    default: 0,
    minimum: 0,
    maximum: 1_000_000_000,
    scope: 'machine',
    category: 'providers',
    ...common,
  }),
  definition({
    key: SETTING_KEYS.copilotExecutablePath,
    type: 'string',
    default: 'auto',
    scope: 'machine',
    category: 'executables',
    ...common,
    sensitive: true,
    requiresProviderDetection: true,
  }),
  definition({
    key: SETTING_KEYS.copilotExperimentalEnabled,
    type: 'boolean',
    default: false,
    scope: 'machine',
    category: 'experimental',
    ...common,
    requiresTimerReschedule: true,
  }),
  definition({
    key: SETTING_KEYS.grokExecutablePath,
    type: 'string',
    default: 'auto',
    scope: 'machine',
    category: 'executables',
    ...common,
    sensitive: true,
    requiresProviderDetection: true,
  }),
  definition({
    key: SETTING_KEYS.grokExperimentalEnabled,
    type: 'boolean',
    default: false,
    scope: 'machine',
    category: 'experimental',
    ...common,
    requiresTimerReschedule: true,
  }),
  definition({
    key: SETTING_KEYS.legacyShowWeeklyLimit,
    type: 'boolean',
    default: true,
    scope: 'window',
    category: 'advanced',
    ...common,
    legacy: true,
  }),
  definition({
    key: SETTING_KEYS.legacyCompactStatusBar,
    type: 'boolean',
    default: false,
    scope: 'window',
    category: 'advanced',
    ...common,
    legacy: true,
  }),
  definition({
    key: SETTING_KEYS.legacyPresentationMode,
    type: 'string',
    default: 'remaining',
    enum: ['remaining', 'used', 'compact'],
    scope: 'window',
    category: 'advanced',
    ...common,
    legacy: true,
  }),
  definition({
    key: SETTING_KEYS.legacyWarningUsedPercent,
    type: 'number',
    default: 70,
    minimum: 1,
    maximum: 99,
    scope: 'window',
    category: 'advanced',
    ...common,
    legacy: true,
  }),
  definition({
    key: SETTING_KEYS.legacyCriticalUsedPercent,
    type: 'number',
    default: 90,
    minimum: 2,
    maximum: 100,
    scope: 'window',
    category: 'advanced',
    ...common,
    legacy: true,
  }),
  definition({
    key: SETTING_KEYS.legacyShowErrorNotifications,
    type: 'boolean',
    default: false,
    scope: 'window',
    category: 'advanced',
    ...common,
    legacy: true,
  }),
] as const satisfies readonly SettingDefinition[];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTINGS_SCHEMA.map((entry) => [entry.key, entry]),
);

export const RUNTIME_SETTING_KEYS = SETTINGS_SCHEMA.filter((entry) => !entry.legacy).map(
  (entry) => entry.key,
);

export function settingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_BY_KEY.get(key);
}
