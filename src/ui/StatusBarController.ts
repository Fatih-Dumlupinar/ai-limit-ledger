import * as vscode from 'vscode';
import type { LimitSnapshot } from '../appServer/types';
import { formatStatus, formatTooltip } from '../limits/RateLimitFormatter';
import type { ProviderSnapshot } from '../providers/types';
import { ProviderStatusBarRegistry } from './ProviderStatusBarRegistry';
import { SettingsService } from '../configuration/SettingsService';
import { getUiTextCatalog } from './UiTextCatalog';

export class StatusBarController implements vscode.Disposable {
  private readonly registry = new ProviderStatusBarRegistry();
  private readonly ownsSettings: boolean;

  constructor(private readonly settings: SettingsService = new SettingsService()) {
    this.ownsSettings = arguments.length === 0;
  }

  private get codexItem(): vscode.StatusBarItem {
    return this.registry.getItem('codex')!;
  }

  loading(): void {
    this.registry.hideAll();
    const catalog = getUiTextCatalog(this.settings.settings.display.language);
    const item = this.codexItem;
    item.text = `$(sync~spin) Codex — ${catalog.loading}`;
    item.tooltip = `${catalog.loading} Codex ${catalog.usageWindow.toLowerCase()}…`;
    item.backgroundColor = undefined;
    item.show();
  }

  notFound(): void {
    this.registry.hideAll();
    const catalog = getUiTextCatalog(this.settings.settings.display.language);
    const item = this.codexItem;
    item.text = `$(warning) ${catalog.providerNotFound.replace('{provider}', 'Codex')}`;
    item.tooltip = catalog.installCliOrConfigurePath;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.show();
  }

  unavailable(): void {
    this.registry.hideAll();
    const catalog = getUiTextCatalog(this.settings.settings.display.language);
    const item = this.codexItem;
    item.text = `$(debug-disconnect) ${catalog.providerUnavailable.replace('{provider}', 'Codex')}`;
    item.tooltip = `${catalog.providerUnavailable.replace('{provider}', 'Codex')}. ${catalog.showLogs}.`;
    item.backgroundColor = undefined;
    item.show();
  }

  render(snapshot: LimitSnapshot): void {
    this.registry.hideAll();
    const effective = this.settings.getSnapshot();
    if (effective.statusBar.mode === 'hidden') return;
    const markdown = new vscode.MarkdownString(formatTooltip(snapshot));
    markdown.isTrusted = false;
    markdown.supportHtml = false;
    const item = this.codexItem;
    item.text = formatStatus(
      snapshot,
      effective.display.percentageMode === 'used' ? 'used' : 'remaining',
      true,
      effective.statusBar.mode === 'compact',
    );
    item.tooltip = markdown;
    const used = Math.max(...snapshot.limits.map((limit) => limit.usedPercent), 0);
    const warning = 100 - effective.thresholds.warningRemainingPercent;
    const critical = 100 - effective.thresholds.criticalRemainingPercent;
    item.backgroundColor =
      used >= critical
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : used >= warning
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    item.show();
  }

  renderProviders(snapshots: ProviderSnapshot[]): void {
    const effective = this.settings.getSnapshot();
    {
      const mode = effective.statusBar.mode === 'detailed' ? 'detailed' : 'compact';
      this.registry.render(snapshots, mode, {
        statusBarMode: effective.statusBar.mode,
        percentageMode: effective.display.percentageMode,
        providerOrder: effective.statusBar.providerOrder,
        tooltipDensity: effective.tooltip.density,
        thresholds: effective.thresholds,
        language: effective.display.language,
        timeFormat: effective.display.timeFormat,
      });
      return;
    }
  }

  dispose(): void {
    this.registry.dispose();
    if (this.ownsSettings) this.settings.dispose();
  }
}
