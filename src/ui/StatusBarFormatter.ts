import {
  normalizeProviderId,
  resolveProviderPresentation,
  resolveProviderPresentations,
  type ProviderPresentationState,
} from '../providers/ProviderCapabilityContract';
import type { ProviderSnapshot } from '../providers/types';
import { type RemainingCapacityThresholds } from '../limits/RemainingCapacityProgress';
import { getUiTextCatalog } from './UiTextCatalog';
import {
  buildProviderPresentationSummary,
  formatPresentedReset,
  presentedPercentageText,
} from './ProviderPresentation';

export type StatusBarMode = 'remaining' | 'used' | 'compact' | 'both' | 'detailed';

export interface StatusBarTextOptions {
  percentageMode?: 'remaining' | 'used' | 'both';
  thresholds?: RemainingCapacityThresholds;
  language?: 'auto' | 'en' | 'tr';
  timeFormat?: 'locale' | 'relative' | 'absolute' | 'both';
}

/** Pure per-provider text. Visibility is intentionally decided by the shared presentation resolver. */
export function providerSegmentText(
  provider: ProviderSnapshot,
  mode: StatusBarMode,
  options: StatusBarTextOptions = {},
): string {
  const presentation = resolveProviderPresentation({ snapshot: provider });
  const name = provider.providerName;
  const catalog = getUiTextCatalog(options.language ?? 'auto');
  const semantic = buildProviderPresentationSummary(provider, {
    now: Date.now(),
    thresholds: options.thresholds,
    language: options.language,
  });
  const window = semantic.quotaWindows[0];
  if (window) {
    const percentageMode =
      options.percentageMode ??
      (mode === 'used' ? 'used' : mode === 'both' || mode === 'detailed' ? 'both' : 'remaining');
    const value = presentedPercentageText(window, percentageMode, catalog);
    if (!value) return `${name} ${catalog.noNumericUsage.toLowerCase()}`;
    if (mode === 'compact') return `${name} ${value}`;
    const reset = window.reset
      ? ` · ${catalog.reset} ${formatPresentedReset(window.reset, options.timeFormat ?? 'both', catalog)}`
      : '';
    return `${name} ${window.label} ${value}${reset}`;
  }

  if (
    normalizeProviderId(provider.providerId) === 'copilot' &&
    typeof provider.credits?.used === 'number'
  ) {
    return `${name} ${catalog.aiCredits} ${catalog.used.toLowerCase()}: ${provider.credits.used}`;
  }
  switch (presentation.normalizedState) {
    case 'authentication-required':
      return `${name} ${catalog.signInRequired.toLowerCase()}`;
    case 'cli-not-installed':
      return `${name} ${catalog.cliNotInstalled.toLowerCase()}`;
    case 'integration-disabled':
      return `${name} ${catalog.disabled.toLowerCase()}`;
    case 'rate-limited':
      return `${name} ${catalog.rateLimited.toLowerCase()}`;
    case 'error':
    case 'startup-error':
      return `${name} ${catalog.unavailable.toLowerCase()}`;
    case 'stale':
      return `${name} ${catalog.stale.toLowerCase()}`;
    case 'no-numeric-usage':
      return `${name} ${catalog.noNumericUsage.toLowerCase()}`;
    case 'setup-required':
      return `${name} ${catalog.setupRequired.toLowerCase()}`;
    case 'experimental':
      return `${name} ${catalog.experimental.toLowerCase()}`;
    case 'ready':
      return `${name} ${catalog.ready.toLowerCase()}`;
    case 'not-selected':
      return `${name} ${catalog.notSelected.toLowerCase()}`;
  }
}

export function visibleProviderPresentations(
  snapshots: readonly ProviderSnapshot[],
): Array<{ snapshot: ProviderSnapshot; presentation: ProviderPresentationState }> {
  const presentations = resolveProviderPresentations(snapshots);
  return snapshots
    .map((snapshot, index) => ({ snapshot, presentation: presentations[index] }))
    .filter(({ presentation }) => presentation.statusBarVisibility === 'visible');
}

/** Pure combined status-bar text for currently useful/active providers only. */
export function combinedStatusText(
  snapshots: ProviderSnapshot[],
  mode: StatusBarMode,
  options: StatusBarTextOptions = {},
): string {
  const visible = visibleProviderPresentations(snapshots);
  const segments = visible.map(({ snapshot }) => providerSegmentText(snapshot, mode, options));
  const catalog = getUiTextCatalog(options.language ?? 'auto');
  return segments.length
    ? `$(pulse) ${segments.join(' · ')}`.replace(/[\r\n]/g, ' ')
    : `$(debug-disconnect) AI Limit Ledger ${catalog.unavailable.toLowerCase()}`;
}

/** Manual-only, unselected and setup-only providers never affect the status-bar background. */
export function hasErrorState(snapshots: ProviderSnapshot[]): boolean {
  return visibleProviderPresentations(snapshots).some(
    ({ presentation }) => presentation.attention === 'error',
  );
}

export function hasWarningState(snapshots: ProviderSnapshot[]): boolean {
  return visibleProviderPresentations(snapshots).some(
    ({ presentation }) => presentation.attention === 'warning',
  );
}
