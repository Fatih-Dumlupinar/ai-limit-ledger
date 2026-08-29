import {
  CANONICAL_PROVIDER_IDS,
  normalizeProviderId,
} from '../providers/ProviderCapabilityContract';
import { diagnostic, type SettingsDiagnostic } from './SettingsDiagnostics';
import { SETTING_KEYS } from './SettingsKeys';

export type ProviderVisibility = 'auto' | 'active-only' | 'all-supported';
export type DashboardMode = 'auto' | 'rich-webview' | 'safe-native';
export type StatusBarMode = 'compact' | 'detailed' | 'hidden';
export type PercentageMode = 'remaining' | 'used' | 'both';
export type TooltipDensity = 'compact' | 'detailed';
export type InsightsMode = 'summary' | 'detailed' | 'hidden';
export type LanguagePreference = 'auto' | 'en' | 'tr';
export type TimeFormat = 'locale' | 'relative' | 'absolute' | 'both';
export type NotificationLevel = 'off' | 'errors' | 'warnings-and-errors';
export type LoggingLevel = 'error' | 'warn' | 'info' | 'debug';
export type CanonicalProviderId = (typeof CANONICAL_PROVIDER_IDS)[number];

export interface ThresholdSettings {
  warningRemainingPercent: number;
  criticalRemainingPercent: number;
}

export interface RefreshSettings {
  codexFallbackSeconds: number;
  claudeStatusLineSeconds: number;
  claudeOAuthSeconds: number;
  copilotSeconds: number;
  grokSeconds: number;
  manualCooldownSeconds: number;
}

export interface EffectiveSettings {
  providers: CanonicalProviderId[];
  dashboard: {
    mode: DashboardMode;
    providerVisibility: ProviderVisibility;
    providerOrder: CanonicalProviderId[];
    openOnStartup: boolean;
    showAvailableIntegrations: boolean;
    insightsMode: InsightsMode;
  };
  statusBar: { mode: StatusBarMode; providerOrder: CanonicalProviderId[] };
  display: {
    percentageMode: PercentageMode;
    language: LanguagePreference;
    timeFormat: TimeFormat;
  };
  tooltip: { density: TooltipDensity };
  thresholds: ThresholdSettings;
  refresh: RefreshSettings;
  notifications: { level: NotificationLevel; showRecoveryActions: boolean };
  logging: { level: LoggingLevel };
  cache: { maxAgeHours: number; showExpiredInDashboard: boolean };
  claudeAutoRepair: boolean;
  experimental: {
    claudeOAuthEnabled: boolean;
    copilotEntitlementEnabled: boolean;
    grokCliProxyEnabled: boolean;
  };
  executables: { codex: string; copilot: string; grok: string };
  providersConfig: {
    copilotPlan: 'auto' | 'pro' | 'proPlus' | 'max' | 'custom';
    copilotCustomMonthlyCredits: number;
  };
  /** Only safe category names and keys; no raw values are kept in diagnostics. */
  diagnostics: SettingsDiagnostic[];
}

export interface RawSettings {
  [key: string]: unknown;
}

const DEFAULT_PROVIDER_ORDER = [...CANONICAL_PROVIDER_IDS] as CanonicalProviderId[];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeNumber(
  raw: unknown,
  fallback: number,
  key: string,
  minimum: number,
  maximum: number,
  diagnostics: SettingsDiagnostic[],
): number {
  if (!finite(raw)) {
    if (raw !== undefined) diagnostics.push(diagnostic('invalid-number', key));
    return fallback;
  }
  if (raw < minimum) {
    diagnostics.push(diagnostic('below-minimum', key));
    return minimum;
  }
  if (raw > maximum) {
    diagnostics.push(diagnostic('above-maximum', key));
    return maximum;
  }
  return raw;
}

function enumValue<T extends string>(
  raw: unknown,
  fallback: T,
  allowed: readonly T[],
  key: string,
  diagnostics: SettingsDiagnostic[],
): T {
  if (typeof raw === 'string' && allowed.includes(raw as T)) return raw as T;
  if (raw !== undefined) diagnostics.push(diagnostic('invalid-enum', key));
  return fallback;
}

function booleanValue(
  raw: unknown,
  fallback: boolean,
  key: string,
  diagnostics: SettingsDiagnostic[],
): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw !== undefined) diagnostics.push(diagnostic('invalid-type', key));
  return fallback;
}

function normalizedProviderList(
  raw: unknown,
  key: string,
  diagnostics: SettingsDiagnostic[],
  fallbackToDefault: boolean,
): CanonicalProviderId[] {
  if (raw === undefined) return fallbackToDefault ? [...DEFAULT_PROVIDER_ORDER] : [];
  if (!Array.isArray(raw)) {
    diagnostics.push(diagnostic('invalid-type', key));
    return fallbackToDefault ? [...DEFAULT_PROVIDER_ORDER] : [];
  }
  const result: CanonicalProviderId[] = [];
  const seen = new Set<CanonicalProviderId>();
  for (const value of raw) {
    if (typeof value !== 'string') {
      diagnostics.push(diagnostic('unknown-provider', key));
      continue;
    }
    const normalized = normalizeProviderId(value);
    if (!(CANONICAL_PROVIDER_IDS as readonly string[]).includes(normalized)) {
      diagnostics.push(diagnostic('unknown-provider', key));
      continue;
    }
    const provider = normalized as CanonicalProviderId;
    if (seen.has(provider)) {
      diagnostics.push(diagnostic('duplicate-provider', key));
      continue;
    }
    seen.add(provider);
    result.push(provider);
  }
  return result;
}

function normalizedOrder(
  raw: unknown,
  key: string,
  diagnostics: SettingsDiagnostic[],
): CanonicalProviderId[] {
  const result = normalizedProviderList(raw, key, diagnostics, true);
  const seen = new Set(result);
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    if (!seen.has(provider)) result.push(provider);
  }
  return result;
}

function executableValue(
  raw: unknown,
  fallback: string,
  key: string,
  diagnostics: SettingsDiagnostic[],
): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') {
    diagnostics.push(diagnostic('invalid-type', key));
    return fallback;
  }
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'auto') return 'auto';
  // Path validation/resolution remains provider-owned. Never put the path in diagnostics.
  return value;
}

export function normalizeSettings(raw: RawSettings = {}): EffectiveSettings {
  const diagnostics: SettingsDiagnostic[] = [];
  const providers = normalizedProviderList(
    raw[SETTING_KEYS.providers],
    SETTING_KEYS.providers,
    diagnostics,
    true,
  );
  const warning = safeNumber(
    raw[SETTING_KEYS.warningRemainingPercent],
    30,
    SETTING_KEYS.warningRemainingPercent,
    1,
    99,
    diagnostics,
  );
  const critical = safeNumber(
    raw[SETTING_KEYS.criticalRemainingPercent],
    10,
    SETTING_KEYS.criticalRemainingPercent,
    0,
    98,
    diagnostics,
  );
  const thresholds =
    critical < warning
      ? { warningRemainingPercent: warning, criticalRemainingPercent: critical }
      : (diagnostics.push(diagnostic('invalid-threshold-order', 'thresholds')),
        { warningRemainingPercent: 30, criticalRemainingPercent: 10 });

  const legacyPresentation = enumValue(
    raw[SETTING_KEYS.legacyPresentationMode],
    'remaining',
    ['remaining', 'used', 'compact'] as const,
    SETTING_KEYS.legacyPresentationMode,
    diagnostics,
  );
  const percentageRaw =
    raw[SETTING_KEYS.displayPercentageMode] ??
    (legacyPresentation === 'compact' ? 'remaining' : legacyPresentation);
  const percentageMode = enumValue(
    percentageRaw,
    'remaining',
    ['remaining', 'used', 'both'] as const,
    SETTING_KEYS.displayPercentageMode,
    diagnostics,
  );
  const legacyCompact = booleanValue(
    raw[SETTING_KEYS.legacyCompactStatusBar],
    false,
    SETTING_KEYS.legacyCompactStatusBar,
    diagnostics,
  );

  return {
    providers,
    dashboard: {
      mode: enumValue(
        raw[SETTING_KEYS.dashboardMode],
        'auto',
        ['auto', 'rich-webview', 'safe-native'] as const,
        SETTING_KEYS.dashboardMode,
        diagnostics,
      ),
      providerVisibility: enumValue(
        raw[SETTING_KEYS.dashboardProviderVisibility],
        'auto',
        ['auto', 'active-only', 'all-supported'] as const,
        SETTING_KEYS.dashboardProviderVisibility,
        diagnostics,
      ),
      providerOrder: normalizedOrder(
        raw[SETTING_KEYS.dashboardProviderOrder],
        SETTING_KEYS.dashboardProviderOrder,
        diagnostics,
      ),
      openOnStartup: booleanValue(
        raw[SETTING_KEYS.dashboardOpenOnStartup],
        false,
        SETTING_KEYS.dashboardOpenOnStartup,
        diagnostics,
      ),
      showAvailableIntegrations: booleanValue(
        raw[SETTING_KEYS.dashboardShowAvailableIntegrations],
        true,
        SETTING_KEYS.dashboardShowAvailableIntegrations,
        diagnostics,
      ),
      insightsMode: enumValue(
        raw[SETTING_KEYS.dashboardInsightsMode],
        'summary',
        ['summary', 'detailed', 'hidden'] as const,
        SETTING_KEYS.dashboardInsightsMode,
        diagnostics,
      ),
    },
    statusBar: {
      mode: enumValue(
        raw[SETTING_KEYS.statusBarMode],
        legacyCompact ? 'compact' : 'compact',
        ['compact', 'detailed', 'hidden'] as const,
        SETTING_KEYS.statusBarMode,
        diagnostics,
      ),
      providerOrder: normalizedOrder(
        raw[SETTING_KEYS.statusBarProviderOrder],
        SETTING_KEYS.statusBarProviderOrder,
        diagnostics,
      ),
    },
    display: {
      percentageMode,
      language: enumValue(
        raw[SETTING_KEYS.displayLanguage],
        'auto',
        ['auto', 'en', 'tr'] as const,
        SETTING_KEYS.displayLanguage,
        diagnostics,
      ),
      timeFormat: enumValue(
        raw[SETTING_KEYS.displayTimeFormat],
        'both',
        ['locale', 'relative', 'absolute', 'both'] as const,
        SETTING_KEYS.displayTimeFormat,
        diagnostics,
      ),
    },
    tooltip: {
      density: enumValue(
        raw[SETTING_KEYS.tooltipDensity],
        'detailed',
        ['compact', 'detailed'] as const,
        SETTING_KEYS.tooltipDensity,
        diagnostics,
      ),
    },
    thresholds,
    refresh: {
      codexFallbackSeconds: safeNumber(
        raw[SETTING_KEYS.codexFallbackRefreshSeconds],
        60,
        SETTING_KEYS.codexFallbackRefreshSeconds,
        30,
        900,
        diagnostics,
      ),
      claudeStatusLineSeconds: safeNumber(
        raw[SETTING_KEYS.claudeStatusLineRefreshSeconds],
        15,
        SETTING_KEYS.claudeStatusLineRefreshSeconds,
        5,
        300,
        diagnostics,
      ),
      claudeOAuthSeconds: safeNumber(
        raw[SETTING_KEYS.claudeOAuthRefreshSeconds],
        120,
        SETTING_KEYS.claudeOAuthRefreshSeconds,
        120,
        3600,
        diagnostics,
      ),
      copilotSeconds: safeNumber(
        raw[SETTING_KEYS.copilotRefreshSeconds],
        300,
        SETTING_KEYS.copilotRefreshSeconds,
        300,
        3600,
        diagnostics,
      ),
      grokSeconds: safeNumber(
        raw[SETTING_KEYS.grokRefreshSeconds],
        300,
        SETTING_KEYS.grokRefreshSeconds,
        300,
        3600,
        diagnostics,
      ),
      manualCooldownSeconds: safeNumber(
        raw[SETTING_KEYS.manualRefreshCooldownSeconds],
        10,
        SETTING_KEYS.manualRefreshCooldownSeconds,
        5,
        60,
        diagnostics,
      ),
    },
    notifications: {
      level: enumValue(
        raw[SETTING_KEYS.notificationsLevel],
        'errors',
        ['off', 'errors', 'warnings-and-errors'] as const,
        SETTING_KEYS.notificationsLevel,
        diagnostics,
      ),
      showRecoveryActions: booleanValue(
        raw[SETTING_KEYS.notificationsShowRecoveryActions],
        true,
        SETTING_KEYS.notificationsShowRecoveryActions,
        diagnostics,
      ),
    },
    logging: {
      level: enumValue(
        raw[SETTING_KEYS.loggingLevel],
        'info',
        ['error', 'warn', 'info', 'debug'] as const,
        SETTING_KEYS.loggingLevel,
        diagnostics,
      ),
    },
    cache: {
      maxAgeHours: safeNumber(
        raw[SETTING_KEYS.cacheMaxAgeHours],
        24,
        SETTING_KEYS.cacheMaxAgeHours,
        1,
        168,
        diagnostics,
      ),
      showExpiredInDashboard: booleanValue(
        raw[SETTING_KEYS.cacheShowExpiredInDashboard],
        false,
        SETTING_KEYS.cacheShowExpiredInDashboard,
        diagnostics,
      ),
    },
    claudeAutoRepair: booleanValue(
      raw[SETTING_KEYS.claudeAutoRepair],
      true,
      SETTING_KEYS.claudeAutoRepair,
      diagnostics,
    ),
    experimental: {
      claudeOAuthEnabled: booleanValue(
        raw[SETTING_KEYS.claudeOAuthEnabled],
        false,
        SETTING_KEYS.claudeOAuthEnabled,
        diagnostics,
      ),
      copilotEntitlementEnabled: booleanValue(
        raw[SETTING_KEYS.copilotExperimentalEnabled],
        false,
        SETTING_KEYS.copilotExperimentalEnabled,
        diagnostics,
      ),
      grokCliProxyEnabled: booleanValue(
        raw[SETTING_KEYS.grokExperimentalEnabled],
        false,
        SETTING_KEYS.grokExperimentalEnabled,
        diagnostics,
      ),
    },
    executables: {
      codex: executableValue(
        raw[SETTING_KEYS.codexExecutablePath],
        'auto',
        SETTING_KEYS.codexExecutablePath,
        diagnostics,
      ),
      copilot: executableValue(
        raw[SETTING_KEYS.copilotExecutablePath],
        'auto',
        SETTING_KEYS.copilotExecutablePath,
        diagnostics,
      ),
      grok: executableValue(
        raw[SETTING_KEYS.grokExecutablePath],
        'auto',
        SETTING_KEYS.grokExecutablePath,
        diagnostics,
      ),
    },
    providersConfig: {
      copilotPlan: enumValue(
        raw[SETTING_KEYS.copilotPlan],
        'auto',
        ['auto', 'pro', 'proPlus', 'max', 'custom'] as const,
        SETTING_KEYS.copilotPlan,
        diagnostics,
      ),
      copilotCustomMonthlyCredits: safeNumber(
        raw[SETTING_KEYS.copilotCustomMonthlyCredits],
        0,
        SETTING_KEYS.copilotCustomMonthlyCredits,
        0,
        1_000_000_000,
        diagnostics,
      ),
    },
    diagnostics,
  };
}

export function providerOrderFor(
  order: readonly string[] | undefined,
  diagnostics: SettingsDiagnostic[] = [],
  key = SETTING_KEYS.dashboardProviderOrder,
): CanonicalProviderId[] {
  return normalizedOrder(order, key, diagnostics);
}

export function isCacheExpired(capturedAt: unknown, now = Date.now(), maxAgeHours = 24): boolean {
  return (
    typeof capturedAt !== 'number' ||
    !Number.isFinite(capturedAt) ||
    now - capturedAt > maxAgeHours * 3_600_000
  );
}

/** A safe copy suitable for diagnostics or support bundles. Paths become state labels. */
export function redactEffectiveSettings(settings: EffectiveSettings): Record<string, unknown> {
  const pathState = (value: string): 'auto' | 'configured' =>
    value === 'auto' ? 'auto' : 'configured';
  return {
    providers: [...settings.providers],
    dashboard: { ...settings.dashboard, providerOrder: [...settings.dashboard.providerOrder] },
    statusBar: { ...settings.statusBar, providerOrder: [...settings.statusBar.providerOrder] },
    display: { ...settings.display },
    tooltip: { ...settings.tooltip },
    thresholds: { ...settings.thresholds },
    refresh: { ...settings.refresh },
    notifications: { ...settings.notifications },
    logging: { ...settings.logging },
    cache: { ...settings.cache },
    claudeAutoRepair: settings.claudeAutoRepair,
    experimental: { ...settings.experimental },
    executables: {
      codex: pathState(settings.executables.codex),
      copilot: pathState(settings.executables.copilot),
      grok: pathState(settings.executables.grok),
    },
    providersConfig: { ...settings.providersConfig },
    diagnostics: settings.diagnostics.map((entry) => ({ ...entry })),
  };
}
