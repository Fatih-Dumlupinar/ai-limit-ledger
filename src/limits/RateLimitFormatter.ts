import type { LimitSnapshot } from '../appServer/types';
import { normalizeToEpochMs } from './TimestampNormalizer';
import { localization } from '../localization/LocalizationService';
import { getUiTextCatalog, localizedRateLimitWindowLabel } from '../ui/UiTextCatalog';

/**
 * Formats a 0-100 percentage for display: at most one decimal place, and no trailing ".0" once
 * rounded — so `0.4` stays `0.4` (never silently rounds away to `0`) while `63.0` renders `63`,
 * not `63.0`. Non-finite input (should never reach here from validated snapshot data) renders the
 * same "Not provided" fallback as a genuinely missing field.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return localization.t('notProvided');
  const clamped = Math.min(100, Math.max(0, value));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
export function formatStatus(
  snapshot: LimitSnapshot,
  mode: 'remaining' | 'used',
  includeWeekly: boolean,
  compact = false,
): string {
  const limits = (
    includeWeekly
      ? snapshot.limits
      : snapshot.limits.filter((limit) => limit.durationMins !== 10080)
  ).map((limit) => {
    const percent = formatPercent(mode === 'used' ? limit.usedPercent : limit.remainingPercent);
    return compact ? `${percent}%` : `${limit.label} ${percent}%`;
  });
  return limits.length
    ? `$(pulse) ${compact ? limits.join(' · ') : `Codex ${limits.join(' · ')}`}`
    : `$(debug-disconnect) Codex ${localization.t('unavailable').toLowerCase()}`;
}
export function formatReset(timestamp: number | null): string {
  const ms = normalizeToEpochMs(timestamp, 'unix-seconds');
  return ms === null
    ? localization.t('notProvided')
    : new Date(ms).toLocaleString(localization.language === 'tr' ? 'tr-TR' : 'en-US');
}
/** Formats elapsed/remaining minutes as normalized "Xd Xh Xm" — never a raw minute count past 60. */
function formatMinuteSpan(totalMins: number): string {
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  const parts: string[] = [];
  const separator = localization.language === 'tr' ? ' ' : '';
  if (days > 0) parts.push(`${days}${separator}${localization.t('daysShort')}`);
  if (days > 0 || hours > 0) parts.push(`${hours}${separator}${localization.t('hoursShort')}`);
  parts.push(`${mins}${separator}${localization.t('minutesShort')}`);
  return parts.join(' ');
}
export function remainingDuration(timestamp: number | null, now = Date.now()): string {
  const ms = normalizeToEpochMs(timestamp, 'unix-seconds');
  if (ms === null) return localization.t('notProvided');
  const diffMs = ms - now;
  if (diffMs <= 0) return localization.t('resetTimePassed');
  const totalMins = Math.ceil(diffMs / 60000);
  if (totalMins <= 0) return localization.t('resetPending');
  return formatMinuteSpan(totalMins);
}
/** Elapsed time since a past timestamp, normalized the same way as `remainingDuration`. */
export function elapsedDuration(timestamp: number | null | undefined, now = Date.now()): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp))
    return localization.t('notProvided');
  const totalMins = Math.max(0, Math.floor((now - timestamp) / 60000));
  return totalMins === 0 ? localization.t('justNow') : formatMinuteSpan(totalMins);
}
export function escapeMarkdown(value: unknown): string {
  return String(value ?? localization.t('notAvailable')).replace(/[\\`*_{}[\]<>()#+.!|]/g, '\\$&');
}
export function formatTooltip(snapshot: LimitSnapshot): string {
  const rows = snapshot.limits
    .map(
      (limit) =>
        `| ${escapeMarkdown(localizedRateLimitWindowLabel(undefined, limit.label, limit.durationMins, getUiTextCatalog()))} | ${formatPercent(limit.remainingPercent)}% | ${formatPercent(limit.usedPercent)}% | ${remainingDuration(limit.resetsAt)} |`,
    )
    .join('\n');
  const stale = snapshot.stale ? `\n\n> ${localization.t('dataMayBeStale')}` : '';
  return `### ${localization.t('codexUsage')}\n\n| ${localization.t('usageWindow')} | ${localization.t('remaining')} | ${localization.t('used')} | ${localization.t('resetsIn')} |\n|---|---:|---:|---:|\n${rows || `| ${localization.t('notAvailable')} | — | — | — |`}\n\n**${localization.t('plan')}:** ${escapeMarkdown(snapshot.planType)}  \n**${localization.t('resetCredits')}:** ${snapshot.resetCredits ?? localization.t('notAvailable')}  \n**${localization.t('lastUpdated')}:** ${localization.formatDate(snapshot.updatedAt.getTime(), 'absolute')}  \n**Codex:** ${escapeMarkdown(snapshot.cliVersion)}${stale}\n\n${localization.t('clickForDetails')}`;
}
