import * as vscode from 'vscode';
import {
  CANONICAL_PROVIDER_IDS,
  normalizeProviderId,
  resolveProviderPresentations,
  type ProviderPresentationState,
} from '../providers/ProviderCapabilityContract';
import type { ProviderId, ProviderSnapshot } from '../providers/types';
import { providerSegmentText, type StatusBarMode } from './StatusBarFormatter';
import { formatProviderTooltip } from './ProviderStatusBarTooltip';
import type { RemainingCapacityThresholds } from '../limits/RemainingCapacityProgress';

function itemText(
  snapshot: ProviderSnapshot,
  presentation: ProviderPresentationState,
  mode: StatusBarMode,
  options: ProviderStatusBarRenderOptions = {},
): string {
  const prefix =
    presentation.attention === 'error'
      ? '$(error) '
      : presentation.attention === 'warning'
        ? '$(warning) '
        : '';
  return `${prefix}${providerSegmentText(snapshot, mode, options)}`.replace(/[\r\n]/g, ' ');
}

export interface ProviderStatusBarRegistryOptions {
  now?: () => number;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  presentationTimerMs?: number;
}

export interface ProviderStatusBarRenderOptions {
  statusBarMode?: 'compact' | 'detailed' | 'hidden';
  percentageMode?: 'remaining' | 'used' | 'both';
  providerOrder?: readonly string[];
  tooltipDensity?: 'compact' | 'detailed';
  thresholds?: RemainingCapacityThresholds;
  language?: 'auto' | 'en' | 'tr';
  timeFormat?: 'locale' | 'relative' | 'absolute' | 'both';
}

/** Owns one independently styled status-bar item per canonical provider. */
export class ProviderStatusBarRegistry implements vscode.Disposable {
  private readonly items = new Map<ProviderId, vscode.StatusBarItem>();
  private readonly previouslyActiveProviderIds = new Set<string>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ProviderStatusBarRegistryOptions['setInterval']>;
  private readonly clearTimer: NonNullable<ProviderStatusBarRegistryOptions['clearInterval']>;
  private readonly presentationTimerMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private snapshots: readonly ProviderSnapshot[] = [];
  private renderOptions: ProviderStatusBarRenderOptions = {};

  constructor(options: ProviderStatusBarRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
    this.clearTimer = options.clearInterval ?? ((timer) => clearInterval(timer));
    this.presentationTimerMs = options.presentationTimerMs ?? 60_000;
    CANONICAL_PROVIDER_IDS.forEach((providerId, index) => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100 - index);
      item.command = 'aiLimitLedger.openDashboard';
      item.hide();
      this.items.set(providerId, item);
    });
  }

  getItem(providerId: string): vscode.StatusBarItem | undefined {
    const canonical = normalizeProviderId(providerId);
    return (CANONICAL_PROVIDER_IDS as readonly string[]).includes(canonical)
      ? this.items.get(canonical as ProviderId)
      : undefined;
  }

  hideAll(): void {
    this.stopPresentationTimer();
    this.snapshots = [];
    for (const item of this.items.values()) {
      item.backgroundColor = undefined;
      item.hide();
    }
  }

  render(
    snapshots: readonly ProviderSnapshot[],
    mode: Exclude<StatusBarMode, 'hidden'> = 'remaining',
    options: ProviderStatusBarRenderOptions = {},
  ): void {
    this.snapshots = snapshots.slice();
    this.renderOptions = { ...options, providerOrder: options.providerOrder?.slice() };
    const effectiveMode = options.statusBarMode ?? (mode === 'detailed' ? 'detailed' : 'compact');
    if (effectiveMode === 'hidden') {
      this.hideAll();
      return;
    }
    const presentations = resolveProviderPresentations(snapshots, {
      previouslyActiveProviderIds: this.previouslyActiveProviderIds,
    });
    const byProvider = new Map<
      string,
      { snapshot: ProviderSnapshot; presentation: ProviderPresentationState }
    >();
    snapshots.forEach((snapshot, index) => {
      const canonical = normalizeProviderId(snapshot.providerId);
      if (!byProvider.has(canonical) && presentations[index]) {
        byProvider.set(canonical, { snapshot, presentation: presentations[index] });
        if (
          presentations[index].dashboardPlacement === 'active' ||
          snapshot.connected ||
          snapshot.usageWindows.length > 0 ||
          snapshot.credits !== undefined
        ) {
          this.previouslyActiveProviderIds.add(canonical);
        }
      }
    });

    let hasVisibleProvider = false;
    const order = (options.providerOrder ?? CANONICAL_PROVIDER_IDS)
      .filter(
        (id, index, all) =>
          all.indexOf(id) === index &&
          (CANONICAL_PROVIDER_IDS as readonly string[]).includes(normalizeProviderId(id)),
      )
      .map((id) => normalizeProviderId(id) as ProviderId);
    for (const providerId of order) {
      const item = this.items.get(providerId);
      const entry = byProvider.get(providerId);
      if (!item || !entry || entry.presentation.statusBarVisibility === 'hidden') {
        item?.hide();
        if (item) item.backgroundColor = undefined;
        continue;
      }

      item.text = itemText(
        entry.snapshot,
        entry.presentation,
        effectiveMode === 'detailed' ? 'detailed' : mode,
        options,
      );
      item.tooltip = new vscode.MarkdownString(
        formatProviderTooltip(entry.snapshot, this.now(), {
          density: options.tooltipDensity,
          percentageMode: options.percentageMode,
          thresholds: options.thresholds,
          language: options.language,
          timeFormat: options.timeFormat,
        }),
      );
      (item.tooltip as vscode.MarkdownString).isTrusted = false;
      (item.tooltip as vscode.MarkdownString).supportHtml = false;
      item.backgroundColor =
        entry.presentation.attention === 'error'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : entry.presentation.attention === 'warning'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
      item.show();
      hasVisibleProvider = true;
    }
    if (hasVisibleProvider) this.startPresentationTimer();
    else this.stopPresentationTimer();
  }

  dispose(): void {
    this.stopPresentationTimer();
    for (const item of this.items.values()) item.dispose();
    this.items.clear();
  }

  private startPresentationTimer(): void {
    if (this.timer) return;
    this.timer = this.setTimer(() => this.refreshTooltips(), this.presentationTimerMs);
  }

  private stopPresentationTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Refreshes countdown text only; it never calls a provider or mutates snapshot timestamps. */
  private refreshTooltips(): void {
    const presentations = resolveProviderPresentations(this.snapshots, {
      previouslyActiveProviderIds: this.previouslyActiveProviderIds,
    });
    const byProvider = new Map<
      string,
      { snapshot: ProviderSnapshot; presentation: ProviderPresentationState }
    >();
    this.snapshots.forEach((snapshot, index) => {
      const canonical = normalizeProviderId(snapshot.providerId);
      if (!byProvider.has(canonical) && presentations[index])
        byProvider.set(canonical, { snapshot, presentation: presentations[index] });
    });
    for (const providerId of this.renderOptions.providerOrder ?? CANONICAL_PROVIDER_IDS) {
      const canonical = normalizeProviderId(providerId) as ProviderId;
      const item = this.items.get(canonical);
      const entry = byProvider.get(canonical);
      if (!item || !entry || entry.presentation.statusBarVisibility === 'hidden') continue;
      const tooltip = new vscode.MarkdownString(
        formatProviderTooltip(entry.snapshot, this.now(), {
          density: this.renderOptions.tooltipDensity,
          percentageMode: this.renderOptions.percentageMode,
          thresholds: this.renderOptions.thresholds,
          language: this.renderOptions.language,
          timeFormat: this.renderOptions.timeFormat,
        }),
      );
      tooltip.isTrusted = false;
      tooltip.supportHtml = false;
      item.tooltip = tooltip;
    }
  }
}
