import type {
  LanguagePreference,
  PercentageMode,
  TimeFormat,
} from '../configuration/EffectiveSettings';
import { EN } from '../localization/locales/en';
import { TR } from '../localization/locales/tr';
import {
  localization,
  resolveRuntimeLanguage,
  type TimestampRole,
} from '../localization/LocalizationService';
import type { TranslationCatalog } from '../localization/LocalizationKeys';
import type { ProviderId } from '../providers/types';
import type { ProviderLinkId } from '../links/ProviderLinkRegistry';

/** Backwards-compatible view of the single runtime catalog used by every UI renderer. */
export type UiTextCatalog = TranslationCatalog;

export type RateLimitWindowKind =
  'five-hour' | 'seven-day' | 'weekly' | 'context' | 'monthly' | 'unknown';

export function resolveUiLanguage(
  preference: LanguagePreference = 'auto',
  language?: string,
): 'en' | 'tr' {
  const runtimeLanguage =
    language === undefined || language === 'auto' ? localization.language : language;
  return resolveRuntimeLanguage(preference, runtimeLanguage);
}

export function getUiTextCatalog(
  preference: LanguagePreference = 'auto',
  language?: string,
): UiTextCatalog {
  return resolveUiLanguage(preference, language) === 'tr' ? TR : EN;
}

export function percentageText(
  remainingPercent: number,
  usedPercent: number,
  mode: PercentageMode = 'remaining',
  catalog: UiTextCatalog = getUiTextCatalog(),
): string {
  const remaining = `${remainingPercent}% ${catalog.left}`;
  const used = `${usedPercent}% ${catalog.used.toLowerCase()}`;
  if (mode === 'used') return used;
  if (mode === 'both') return `${remaining} · ${used}`;
  return remaining;
}

export function formatProviderCount(
  count: number,
  catalog: UiTextCatalog = getUiTextCatalog(),
): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return catalog === TR
    ? catalog.activeProviderCountPlural.replace('{count}', String(safeCount))
    : (safeCount === 1
        ? catalog.activeProviderCountSingular
        : catalog.activeProviderCountPlural
      ).replace('{count}', String(safeCount));
}

export function rateLimitWindowKind(
  id: string | undefined,
  label: string | undefined,
  durationMinutes?: number | null,
): RateLimitWindowKind {
  const normalized = `${id ?? ''} ${label ?? ''}`.trim().toLowerCase();
  if (/seven[- ]?day|7\s*d(?:ay)?|7-day/.test(normalized) || durationMinutes === 10080)
    return 'seven-day';
  if (/five[- ]?hour|5\s*h(?:our)?|5-hour/.test(normalized) || durationMinutes === 300)
    return 'five-hour';
  if (/weekly|week|hafta/.test(normalized)) return 'weekly';
  if (/context|bağlam/.test(normalized)) return 'context';
  if (/monthly|month|aylık/.test(normalized)) return 'monthly';
  if (/^primary$|^main$|^ana$/.test((id ?? label ?? '').trim().toLowerCase())) return 'unknown';
  return 'unknown';
}

export function localizedRateLimitWindowLabel(
  id: string | undefined,
  label: string | undefined,
  durationMinutes: number | null | undefined,
  catalog: UiTextCatalog = getUiTextCatalog(),
): string {
  const kind = rateLimitWindowKind(id, label, durationMinutes);
  switch (kind) {
    case 'five-hour':
      return catalog.fiveHourWindow;
    case 'seven-day':
      return catalog.sevenDayWindow;
    case 'weekly':
      return catalog.weeklyWindow;
    case 'context':
      return catalog.contextWindow;
    case 'monthly':
      return catalog.monthlyWindow;
    default:
      return (id ?? '').trim().toLowerCase() === 'primary'
        ? catalog.primaryWindow
        : catalog.usageWindowGeneric;
  }
}

const LINK_LABEL_KEYS: Readonly<Record<ProviderLinkId, keyof UiTextCatalog>> = {
  'codex-usage': 'openCodexUsageDashboard',
  'codex-cli-docs': 'openCodexCliDocumentation',
  'codex-limits-docs': 'openCodexLimitsDocumentation',
  'codex-ide-docs': 'openCodexIdeDocumentation',
  'claude-usage': 'openClaudeUsageSettings',
  'claude-install': 'openClaudeInstallationGuide',
  'claude-vscode-docs': 'openClaudeVsCodeDocumentation',
  'claude-cost-docs': 'openClaudeCostsDocumentation',
  'claude-errors-docs': 'openClaudeErrorsDocumentation',
  'copilot-billing': 'openGitHubBilling',
  'copilot-usage-docs': 'openCopilotUsageDocumentation',
  'copilot-cli-install': 'installCopilotCliOptional',
  'copilot-cli-quickstart': 'openCopilotCliQuickstart',
  'copilot-settings': 'openCopilotSettings',
  'copilot-vscode-extension': 'openOfficialCopilotExtension',
  'copilot-plans-docs': 'openCopilotPlansDocumentation',
  'grok-home': 'openGrok',
  'grok-billing': 'openGrokBilling',
  'grok-install': 'openGrokInstallationGuide',
  'grok-cli-reference': 'openGrokCliReference',
  'grok-usage-docs': 'openOfficialGrokUsageGuide',
  'grok-official-repository': 'openOfficialGrokRepository',
};

export function localizedProviderLinkLabel(
  id: ProviderLinkId,
  catalog: UiTextCatalog = getUiTextCatalog(),
): string {
  return catalog[LINK_LABEL_KEYS[id]];
}

export function localizedProviderSourceLabel(
  providerId: ProviderId,
  sourceKind: string,
  catalog: UiTextCatalog = getUiTextCatalog(),
): string {
  const experimental = sourceKind.startsWith('experimental');
  switch (providerId) {
    case 'codex':
      return catalog.officialCodexAppServer;
    case 'claude':
      return experimental ? catalog.experimentalAnthropicUsage : catalog.officialClaudeStatusLine;
    case 'copilot':
      return experimental ? catalog.experimentalGitHubEntitlement : catalog.officialGitHubBilling;
    case 'grok':
      return experimental ? catalog.experimentalGrokBilling : catalog.officialGrokBilling;
    default:
      return catalog.sourceUsage;
  }
}

export function localizedProviderGuidance(
  providerId: ProviderId,
  catalog: UiTextCatalog = getUiTextCatalog(),
): { summary: string; cliUsageInstruction?: string } {
  switch (providerId) {
    case 'codex':
      return { summary: catalog.codexAutomaticUsageRequirement };
    case 'claude':
      return {
        summary: catalog.claudeAutomaticUsageRequirement,
        cliUsageInstruction: catalog.claudeOfficialUsageInstruction,
      };
    case 'copilot':
      return { summary: catalog.copilotAutomaticUsageRequirement };
    case 'grok':
      return {
        summary: catalog.grokAutomaticUsageRequirement,
        cliUsageInstruction: catalog.grokOfficialUsageInstruction,
      };
  }
}

export function formatConfiguredTime(
  timestamp: number | undefined,
  now: number,
  format: TimeFormat = 'both',
  catalog: UiTextCatalog = getUiTextCatalog(),
  role: TimestampRole = 'snapshot-age',
): string {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0)
    return catalog.notProvided;
  const absolute = new Date(timestamp).toLocaleString(catalog === TR ? 'tr-TR' : 'en-US');
  const relative = relativeDuration(timestamp - now, catalog, role);
  if (format === 'absolute' || format === 'locale') return absolute;
  if (format === 'relative') return relative;
  return `${absolute} (${relative})`;
}

function relativeDuration(
  deltaMs: number,
  catalog: UiTextCatalog,
  role: TimestampRole = 'snapshot-age',
): string {
  const magnitude = deltaMs < 0 ? -deltaMs : deltaMs;
  const seconds = Math.max(0, Math.ceil(magnitude / 1000));
  if (seconds < 15 && role === 'past-event') return catalog.justNow;
  if (seconds < 60) {
    const value = catalog === TR ? `${seconds} sn` : `${seconds}s`;
    if (role === 'future-target') return catalog.inTime.replace('{value}', value);
    if (role === 'deadline')
      return deltaMs > 0 ? catalog.inTime.replace('{value}', value) : catalog.dueNow;
    if (role === 'past-event')
      return deltaMs < 0
        ? catalog.agoTime.replace('{value}', value)
        : catalog.inTime.replace('{value}', value);
    return catalog.justNow;
  }
  const minutes = Math.floor(seconds / 60);
  let duration: string;
  if (minutes < 60) {
    duration = `${minutes}${catalog === TR ? ' ' : ''}${catalog.minutesShort}`;
    const secondsRemainder = seconds % 60;
    if ((role === 'future-target' || role === 'deadline') && secondsRemainder > 0 && minutes < 5)
      duration += ` ${secondsRemainder}${catalog === TR ? ' sn' : 's'}`;
  } else {
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const rest = minutes % 60;
      duration = `${hours}${catalog === TR ? ' ' : ''}${catalog.hoursShort}${
        rest ? ` ${rest}${catalog === TR ? ' ' : ''}${catalog.minutesShort}` : ''
      }`;
    } else {
      const days = Math.floor(hours / 24);
      const rest = hours % 24;
      duration = `${days}${catalog === TR ? ' ' : ''}${catalog.daysShort}${
        rest ? ` ${rest}${catalog === TR ? ' ' : ''}${catalog.hoursShort}` : ''
      }`;
    }
  }
  if (role === 'future-target' || (role === 'deadline' && deltaMs > 0))
    return catalog.inTime.replace('{value}', duration);
  if (role === 'past-event' || (role === 'deadline' && deltaMs < 0)) {
    return role === 'deadline'
      ? catalog.overdueBy.replace('{value}', duration)
      : catalog.agoTime.replace('{value}', duration);
  }
  return duration;
}
