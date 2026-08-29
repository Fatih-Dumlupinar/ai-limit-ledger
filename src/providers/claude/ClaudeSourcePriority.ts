import type { ProviderSnapshot, UsageWindow } from '../types';
import type { ClaudeOAuthSnapshot } from './oauth/ClaudeOAuthUsageService';
import {
  isSafeTimestamp,
  makeArrayInsight,
  mergeUsageInsights,
  type ProviderUsageInsights,
  type UsageInsightSource,
} from '../UsageInsights';

/** Displayed only when the official status-line has no automatic account-limit data at all on this host. */
const NO_OFFICIAL_ACCOUNT_DATA_STATES = new Set([
  'manual-only',
  'upstream-statusline-not-invoked',
  'unsupported-surface',
  'integration-required',
  'integration-disabled',
  'unavailable',
]);

const EXPERIMENTAL_SOURCE = 'Experimental — undocumented Anthropic usage endpoint' as const;

function oauthWindows(oauth: ClaudeOAuthSnapshot): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (oauth.fiveHour)
    windows.push({
      id: 'five-hour',
      label: '5h',
      usedPercent: oauth.fiveHour.usedPercent,
      remainingPercent: oauth.fiveHour.remainingPercent,
      resetsAt: oauth.fiveHour.resetsAt,
      windowDurationMinutes: 300,
    });
  if (oauth.sevenDay)
    windows.push({
      id: 'seven-day',
      label: '7d',
      usedPercent: oauth.sevenDay.usedPercent,
      remainingPercent: oauth.sevenDay.remainingPercent,
      resetsAt: oauth.sevenDay.resetsAt,
      windowDurationMinutes: 10080,
    });
  return windows;
}

const OVERLAY_AVAILABILITY: Partial<
  Record<ClaudeOAuthSnapshot['availability'], ProviderSnapshot['availability']>
> = {
  ready: 'ready-experimental',
  stale: 'stale-experimental',
  'rate-limited': 'rate-limited-experimental',
  'authentication-required': 'authentication-required',
  'consent-required': 'consent-required',
};

const OAUTH_SOURCE: UsageInsightSource = {
  kind: 'experimental-undocumented',
  label: 'Experimental — undocumented Anthropic usage endpoint',
};

function oauthInsights(oauth: ClaudeOAuthSnapshot): Partial<ProviderUsageInsights> {
  const checkedAt = isSafeTimestamp(oauth.checkedAt) ? oauth.checkedAt : Date.now();
  const observedAt = isSafeTimestamp(oauth.observedAt) ? oauth.observedAt : checkedAt;
  const windows = oauthWindows(oauth);
  return {
    providerId: 'claude',
    accountMetrics: windows.length
      ? {
          rateLimits: makeArrayInsight(
            windows.map((window) => ({
              id: window.id,
              label: window.label,
              usedPercent: window.usedPercent,
              remainingPercent: window.remainingPercent,
              resetsAt: window.resetsAt,
              windowDurationMinutes: window.windowDurationMinutes,
            })),
            'count',
            'rateLimits',
            OAUTH_SOURCE,
            observedAt,
            oauth.stale,
          ),
        }
      : {},
    source: OAUTH_SOURCE,
    checkedAt,
    sourceUpdatedAt: observedAt,
    stale: oauth.stale,
  };
}

/**
 * Combines the official status-line snapshot (the provider's own, untouched output) with the
 * experimental OAuth usage snapshot, per source-priority rules: fresh official data always wins
 * for context/model/session-cost (those fields never come from OAuth at all); 5h/7d account
 * limits prefer whichever source observed more recently; and the experimental transport is only
 * ever allowed to *replace* the top-level availability/warning when the official status-line has
 * no automatic account-limit data on this host at all — a genuine configuration problem
 * (repair-required, external-change, configuration-shadowed, …) is never masked by a shinier
 * experimental percentage. Pure and independently testable; never touches network, disk, or vscode.
 */
export function applyClaudeOAuthOverlay(
  official: ProviderSnapshot,
  oauth: ClaudeOAuthSnapshot | undefined,
): ProviderSnapshot {
  const accessMode = official.metadata?.accessMode;
  const baseMetadata = {
    ...official.metadata,
    oauthCheckedAt: oauth?.checkedAt ?? null,
    oauthRetryAt: oauth?.retryAt ?? null,
    oauthNextEligibleAt: oauth?.nextEligibleAt ?? null,
    oauthLastKnownGoodAt: oauth?.observedAt ?? null,
    oauthAvailability: oauth?.availability ?? null,
    oauthCacheExpired: oauth?.cacheExpired ?? false,
    sidebarActivityDetected: accessMode === 'vscode-extension' || accessMode === 'hybrid',
  };

  const officialHasWindows = official.usageWindows.length > 0;

  if (!oauth) {
    return {
      ...official,
      metadata: {
        ...baseMetadata,
        accountLimitsSource: officialHasWindows ? 'official-status-line' : 'none',
        contextSource: official.tokens ? 'official-status-line' : 'not-available',
      },
    };
  }

  // Official status-line already has real data: only replace the 5h/7d *numbers* when OAuth
  // observed a strictly newer snapshot, and never touch availability/warning/context/model/cost.
  if (officialHasWindows) {
    const oauthIsFresher =
      (oauth.availability === 'ready' || oauth.availability === 'stale') &&
      oauth.observedAt !== null &&
      oauth.observedAt > official.observedAt;
    if (!oauthIsFresher) {
      return {
        ...official,
        metadata: {
          ...baseMetadata,
          accountLimitsSource: 'official-status-line',
          contextSource: official.tokens ? 'official-status-line' : 'not-available',
        },
      };
    }
    return {
      ...official,
      usageWindows: oauthWindows(oauth),
      usageInsights: mergeUsageInsights(official.usageInsights, oauthInsights(oauth)),
      metadata: {
        ...baseMetadata,
        accountLimitsSource: 'experimental-oauth',
        contextSource: official.tokens ? 'official-status-line' : 'not-available',
      },
    };
  }

  // No official account-limit data on this host. Only overlay a fuller experimental picture
  // when that absence is itself a supported/expected state, not an active repair/diagnostic one.
  if (!NO_OFFICIAL_ACCOUNT_DATA_STATES.has(official.availability)) {
    return {
      ...official,
      metadata: { ...baseMetadata, accountLimitsSource: 'none', contextSource: 'not-available' },
    };
  }

  const overlayAvailability = OVERLAY_AVAILABILITY[oauth.availability];
  if (!overlayAvailability) {
    // 'disabled' or 'unavailable' OAuth state: nothing experimental to show — leave the
    // official (manual-only-shaped) snapshot exactly as it was.
    return {
      ...official,
      metadata: { ...baseMetadata, accountLimitsSource: 'none', contextSource: 'not-available' },
    };
  }

  const isLastKnownGood = oauth.availability === 'rate-limited' || oauth.availability === 'stale';
  return {
    ...official,
    availability: overlayAvailability,
    usageWindows: oauthWindows(oauth),
    usageInsights: mergeUsageInsights(official.usageInsights, oauthInsights(oauth)),
    source: EXPERIMENTAL_SOURCE,
    stale: isLastKnownGood,
    connected: oauth.availability === 'ready' || isLastKnownGood,
    metadata: {
      ...baseMetadata,
      accountLimitsSource: oauthWindows(oauth).length
        ? isLastKnownGood
          ? 'last-known-good-oauth'
          : 'experimental-oauth'
        : 'none',
      contextSource: 'not-available',
    },
  };
}
