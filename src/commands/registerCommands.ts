import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { CodexAppServerClient } from '../appServer/CodexAppServerClient';
import type { Logger } from '../infrastructure/Logger';
import {
  commandInvocationOf,
  isDashboardInvocation,
  type CommandExecutionResult,
} from './CommandExecution';
import {
  buildRedactedDiagnostics,
  buildRedactedSupportBundle,
  serializeRedacted,
  writeRedactedSupportBundleAtomically,
} from '../infrastructure/RedactedDiagnostics';
import { clearAllowedCaches } from '../infrastructure/CacheKeys';
import { SafeErrorPresenter } from '../infrastructure/SafeErrorPresenter';
import { classifyErrorCategory } from '../infrastructure/ProviderDiagnostics';
import type { ProviderCoordinator } from '../providers/ProviderCoordinator';
import { formatCodexDiagnostics } from '../providers/CodexDiagnostics';
import type { CodexProvider } from '../providers/CodexProvider';
import type { CopilotPlan } from '../providers/copilot/types';
import type { CopilotProvider } from '../providers/copilot/CopilotProvider';
import type { GrokProvider } from '../providers/grok/GrokProvider';
import {
  ProviderRefreshOrchestrator,
  type ProviderRefreshResult,
  type RefreshInvocationContext,
} from '../providers/ProviderRefreshOrchestrator';
import type { ProviderSnapshot } from '../providers/types';
import { resolveProviderPresentations } from '../providers/ProviderCapabilityContract';
import { formatCopilotDiagnostics } from '../providers/copilot/CopilotDiagnostics';
import { formatGrokDiagnostics } from '../providers/grok/GrokDiagnostics';
import {
  copyClaudeDiagnostics,
  copyClaudeUsageCommand,
  disableClaude,
  disableClaudeAutoRepair,
  disableClaudeOAuthUsage,
  diagnoseClaude,
  enableClaude,
  enableClaudeAutoRepair,
  enableClaudeOAuthUsage,
  launchClaudeInTerminal,
  openClaudeCode,
  openClaudeInstallGuide,
  openCliEnhancedModeDocs,
  openExperimentalClaudeUsageDocs,
  recheckClaudeIntegrationHealth,
  repairClaude,
} from '../providers/ClaudeIntegration';
import { mementoLeaseStore, tryAcquireLease } from '../providers/RefreshLease';
import {
  enableExperimentalCopilotUsage,
  disableExperimentalCopilotUsage,
} from '../providers/copilot/CopilotExperimentalConsent';
import {
  enableExperimentalGrokUsage,
  disableExperimentalGrokUsage,
} from '../providers/grok/GrokExperimentalConsent';
import {
  getDashboardDiagnosticsSnapshot,
  disposeDashboardIfNotReady,
  recoverDashboard,
  setDashboardActionRunner,
  setDashboardLogger,
  setSafeDashboardOpener,
  showDashboard,
} from '../ui/DetailsView';
import {
  setConfiguredDashboardMode,
  dashboardModeFromConfiguration,
  type DashboardMode,
  type SafeDashboardController,
} from '../ui/SafeDashboard';
import { DashboardActionRunner } from '../ui/DashboardActionRunner';
import { ProviderLinkService } from '../links/ProviderLinkService';
import {
  clearProviderLinkService,
  openClaudeUsagePage,
  openCodexUsagePage,
  openCopilotUsagePage,
  openGrokInstallGuide,
  openGrokUsagePage,
  setProviderLinkService,
} from '../ui/UsageLinks';
import {
  COPILOT_EXPERIMENTAL_CONSENT_KEY,
  DASHBOARD_MODE,
  GROK_EXPERIMENTAL_CONSENT_KEY,
  SETTING_KEYS,
} from '../configuration/SettingsKeys';
import type { SettingsService } from '../configuration/SettingsService';
import { localization } from '../localization/LocalizationService';

const DEFAULT_MANUAL_COOLDOWN_SECONDS = 10;
const REFRESH_LEASE_KEY = 'aiLimitLedger.refreshLease';
const REFRESH_LEASE_TTL_MS = 8_000;
export function formatRefreshSummary(results: readonly ProviderRefreshResult[]): string {
  if (!results.length) return `AI Limit Ledger: ${localization.t('notSelected').toLowerCase()}.`;
  const failed = results.filter((result) => !result.ok).length;
  const setup = results.filter((result) =>
    ['authentication-required', 'cli-not-installed', 'disabled', 'not-selected'].includes(
      result.availability ?? '',
    ),
  ).length;
  const suffix = setup
    ? ` ${setup} provider(s) ${localization.t('setupRequired').toLowerCase()}.`
    : '';
  return failed
    ? `AI Limit Ledger: ${localization.t('refresh').toLowerCase()} ${results.length - failed}/${results.length} provider(s); ${failed} ${localization.t('failed').toLowerCase()}.${suffix}`
    : `AI Limit Ledger: ${localization.t('refresh').toLowerCase()} ${results.length} provider(s).${suffix}`;
}

/** Pure cooldown gate for the manual "Refresh" action, independently testable. */
export function createManualRefreshGate(
  cooldownSecondsProvider: () => number,
  now: () => number = Date.now,
): () => boolean {
  let lastRunAt = -Infinity;
  return () => {
    const cooldownMs = Math.max(0, cooldownSecondsProvider()) * 1000;
    const current = now();
    if (current - lastRunAt < cooldownMs) return false;
    lastRunAt = current;
    return true;
  };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  coordinator: ProviderCoordinator,
  getClient: () => CodexAppServerClient | undefined,
  getCodexProvider: () => CodexProvider | undefined,
  logger: Logger,
  getCopilotProvider?: () => CopilotProvider | undefined,
  getGrokProvider?: () => GrokProvider | undefined,
  getPresentationSnapshots?: () => ProviderSnapshot[],
  providedRefreshOrchestrator?: ProviderRefreshOrchestrator,
  safeDashboard?: SafeDashboardController,
  settings?: SettingsService,
): void {
  const configuration = () => vscode.workspace.getConfiguration('aiLimitLedger');
  const settingValue = <T>(
    key: import('../configuration/SettingsKeys').SettingKey,
    fallback: T,
  ): T => settings?.get<T>(key) ?? configuration().get<T>(key, fallback);
  const updateSetting = async (
    key: import('../configuration/SettingsKeys').SettingKey,
    value: unknown,
  ): Promise<void> => {
    if (settings) return settings.update(key, value, vscode.ConfigurationTarget.Global);
    await configuration().update(key, value, vscode.ConfigurationTarget.Global);
  };
  const manualRefreshAllowed = createManualRefreshGate(() =>
    settingValue(SETTING_KEYS.manualRefreshCooldownSeconds, DEFAULT_MANUAL_COOLDOWN_SECONDS),
  );
  const windowId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const leaseStore = mementoLeaseStore(context.globalState, REFRESH_LEASE_KEY);
  const refreshOrchestrator =
    providedRefreshOrchestrator ??
    new ProviderRefreshOrchestrator({
      coordinator,
      globalState: context.globalState,
      windowId,
      logger,
    });
  if (!providedRefreshOrchestrator)
    context.subscriptions.push({ dispose: () => refreshOrchestrator.dispose() });
  const safeErrors = new SafeErrorPresenter({ showLogs: () => logger.show() });
  if (settings) {
    safeErrors.setPolicy(
      settings.settings.notifications.level,
      settings.settings.notifications.showRecoveryActions,
    );
    context.subscriptions.push(
      settings.onDidChange((change) =>
        safeErrors.setPolicy(
          change.settings.notifications.level,
          change.settings.notifications.showRecoveryActions,
        ),
      ),
    );
  }
  const providerLinkService = new ProviderLinkService(logger);
  setProviderLinkService(providerLinkService);
  context.subscriptions.push({ dispose: clearProviderLinkService });
  const dashboardRunner = new DashboardActionRunner({
    logger,
    execute: (commandId, invocation) =>
      Promise.resolve(vscode.commands.executeCommand(commandId, invocation)),
  });
  setDashboardActionRunner(dashboardRunner);
  setDashboardLogger(logger);
  if (safeDashboard) {
    setSafeDashboardOpener(async (fallback) => {
      if (fallback) disposeDashboardIfNotReady();
      await safeDashboard.open({ fallback });
    });
  }
  context.subscriptions.push({ dispose: () => dashboardRunner.dispose() });
  const redactedDiagnostics = (operationCorrelationId?: string) => {
    const snapshots = getPresentationSnapshots?.() ?? coordinator.getSnapshots();
    return {
      ...buildRedactedDiagnostics(
        snapshots,
        resolveProviderPresentations(snapshots, {
          selectedProviderIds: coordinator.getSelectedProviderIds(),
        }),
        {
          extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
          vscodeVersion: vscode.version,
          platform: process.platform,
          architecture: process.arch,
          correlationId: operationCorrelationId ?? logger.createCorrelationId(),
        },
      ),
      dashboard: getDashboardDiagnosticsSnapshot(),
    };
  };
  const providerManualGates = new Map<string, () => boolean>();
  const providerManualGate = (providerId: string): (() => boolean) => {
    const existing = providerManualGates.get(providerId);
    if (existing) return existing;
    const gate = createManualRefreshGate(() =>
      settingValue(SETTING_KEYS.manualRefreshCooldownSeconds, DEFAULT_MANUAL_COOLDOWN_SECONDS),
    );
    providerManualGates.set(providerId, gate);
    return gate;
  };
  const commandResultForRefresh = (result: ProviderRefreshResult): CommandExecutionResult => ({
    status: result.status,
    ...(result.safeErrorCategory ? { safeErrorCategory: result.safeErrorCategory } : {}),
    retryable: result.status !== 'cancelled',
  });
  const refreshContext = (rawInvocation: unknown, force: boolean): RefreshInvocationContext => {
    const invocation = commandInvocationOf(rawInvocation);
    return {
      source: invocation?.source ?? 'command-palette',
      correlationId: invocation?.correlationId,
      force,
    };
  };
  const runProviderCommand = async (
    providerId: 'codex' | 'claude' | 'copilot' | 'grok',
    rawInvocation: unknown,
  ): Promise<ProviderRefreshResult | CommandExecutionResult | undefined> => {
    const dashboard = isDashboardInvocation(rawInvocation);
    if (!providerManualGate(providerId)()) {
      return dashboard
        ? {
            status: 'throttled',
            safeMessage: localization.t('refreshTemporarilyUnavailable'),
            safeErrorCategory: 'throttled',
            retryable: true,
          }
        : undefined;
    }
    const result = await refreshOrchestrator.refreshProvider(
      providerId,
      refreshContext(rawInvocation, true),
    );
    if (!dashboard) {
      if (result.status === 'success')
        void vscode.window.showInformationMessage(
          `AI Limit Ledger: ${localization.t('refresh').toLowerCase()} ${providerId}.`,
        );
      else if (result.status === 'throttled')
        void vscode.window.showWarningMessage(
          `AI Limit Ledger: ${localization.t('refreshTemporarilyUnavailable')}`,
        );
      return result;
    }
    return commandResultForRefresh(result);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('aiLimitLedger.refresh', (rawInvocation?: unknown) => {
      const invocation = commandInvocationOf(rawInvocation);
      const dashboard = isDashboardInvocation(rawInvocation);
      if (!manualRefreshAllowed())
        return dashboard
          ? ({
              status: 'throttled',
              safeMessage: localization.t('refreshTemporarilyUnavailable'),
              safeErrorCategory: 'throttled',
              retryable: true,
            } satisfies CommandExecutionResult)
          : undefined;
      // If another window already holds the short-lived lease, it is already performing (or just
      // performed) the real refresh — this window renders from the shared snapshot instead of
      // also hitting the network.
      if (!tryAcquireLease(leaseStore, REFRESH_LEASE_KEY, windowId, REFRESH_LEASE_TTL_MS))
        return dashboard
          ? ({
              status: 'throttled',
              safeMessage: localization.t('refreshAlreadyRunning'),
              safeErrorCategory: 'throttled',
              retryable: true,
            } satisfies CommandExecutionResult)
          : undefined;
      const correlationId = invocation?.correlationId ?? logger.createCorrelationId();
      const startedAt = Date.now();
      if (dashboard)
        return refreshOrchestrator
          .refreshAll({
            source: 'dashboard',
            correlationId,
            force: false,
          })
          .then((results) =>
            results.some((result) => result.status === 'throttled')
              ? ({
                  status: 'throttled',
                  safeErrorCategory: 'throttled',
                  retryable: true,
                } satisfies CommandExecutionResult)
              : results.some((result) => result.status === 'error')
                ? ({
                    status: 'error',
                    safeErrorCategory: 'unknown',
                    retryable: true,
                  } satisfies CommandExecutionResult)
                : ({ status: 'success', retryable: true } satisfies CommandExecutionResult),
          );
      logger.logRecord('info', {
        correlationId,
        action: 'operation.started',
        stage: 'manual-refresh',
        message: 'Manual refresh started.',
      });
      return refreshOrchestrator
        .refreshAll({
          source: 'command-palette',
          correlationId,
          force: false,
        })
        .then((results) => {
          logger.logRecord('info', {
            correlationId,
            action: 'operation.completed',
            stage: 'manual-refresh',
            durationMs: Date.now() - startedAt,
            message: 'Manual refresh completed.',
          });
          void vscode.window.showInformationMessage(formatRefreshSummary(results));
          return results;
        });
    }),
    vscode.commands.registerCommand('aiLimitLedger.refreshCodex', (rawInvocation?: unknown) =>
      runProviderCommand('codex', rawInvocation),
    ),
    vscode.commands.registerCommand('aiLimitLedger.refreshClaude', (rawInvocation?: unknown) =>
      runProviderCommand('claude', rawInvocation),
    ),
    vscode.commands.registerCommand('aiLimitLedger.openDashboard', () => {
      const mode = dashboardModeFromConfiguration(settingValue(DASHBOARD_MODE, 'auto'));
      setConfiguredDashboardMode(mode);
      if (mode === 'safe-native' && safeDashboard) return safeDashboard.open();
      showDashboard(
        getPresentationSnapshots?.() ?? coordinator.getSnapshots(),
        context,
        dashboardRunner,
      );
      return undefined;
    }),
    vscode.commands.registerCommand('aiLimitLedger.openSafeDashboard', async () => {
      if (!safeDashboard) {
        void vscode.window.showErrorMessage(localization.t('safeDashboardUnavailable'));
        return;
      }
      await safeDashboard.open();
    }),
    vscode.commands.registerCommand('aiLimitLedger.openRichDashboard', () => {
      showDashboard(
        getPresentationSnapshots?.() ?? coordinator.getSnapshots(),
        context,
        dashboardRunner,
      );
    }),
    vscode.commands.registerCommand('aiLimitLedger.selectDashboardMode', async () => {
      const choices: Array<vscode.QuickPickItem & { value: DashboardMode }> = [
        {
          label: localization.t('auto'),
          description: localization.t('dashboardModeAutoDescription'),
          value: 'auto',
        },
        {
          label: localization.t('richWebview'),
          description: localization.t('dashboardModeRichDescription'),
          value: 'rich-webview',
        },
        {
          label: localization.t('safeNative'),
          description: localization.t('dashboardModeSafeDescription'),
          value: 'safe-native',
        },
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        title: localization.t('selectDashboardMode'),
        placeHolder: localization.t('openDashboard'),
      });
      if (!choice) return;
      const selectedMode = choice.value;
      try {
        await updateSetting(DASHBOARD_MODE, selectedMode);
        const readBack = dashboardModeFromConfiguration(settingValue(DASHBOARD_MODE, 'auto'));
        if (readBack !== selectedMode) throw new Error('Dashboard mode verification failed.');
        setConfiguredDashboardMode(selectedMode);
        safeDashboard?.refresh();
        void vscode.window.showInformationMessage(
          `${localization.t('settings')}: ${choice.label}.`,
        );
      } catch {
        void vscode.window.showErrorMessage(localization.t('saveFailed'));
      }
    }),
    vscode.commands.registerCommand('aiLimitLedger.selectStatusBarMode', async () => {
      const choices: Array<vscode.QuickPickItem & { value: 'compact' | 'detailed' | 'hidden' }> = [
        {
          label: localization.t('compact'),
          description: localization.t('statusBarCompactDescription'),
          value: 'compact',
        },
        {
          label: localization.t('detailed'),
          description: localization.t('statusBarDetailedDescription'),
          value: 'detailed',
        },
        {
          label: localization.t('hidden'),
          description: localization.t('statusBarHiddenDescription'),
          value: 'hidden',
        },
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        title: localization.t('selectStatusBarMode'),
      });
      if (!choice) return;
      await updateSetting(SETTING_KEYS.statusBarMode, choice.value);
      void vscode.window.showInformationMessage(`${localization.t('settings')}: ${choice.label}.`);
    }),
    vscode.commands.registerCommand('aiLimitLedger.selectPercentageDisplay', async () => {
      const choices: Array<vscode.QuickPickItem & { value: 'remaining' | 'used' | 'both' }> = [
        {
          label: localization.t('remaining'),
          description: localization.t('progressRemaining', { value: '' }),
          value: 'remaining',
        },
        {
          label: localization.t('used'),
          description: localization.t('progressUsed', { value: '' }),
          value: 'used',
        },
        { label: localization.t('both'), description: localization.t('both'), value: 'both' },
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        title: localization.t('selectPercentageDisplay'),
      });
      if (!choice) return;
      await updateSetting(SETTING_KEYS.displayPercentageMode, choice.value);
      void vscode.window.showInformationMessage(`${localization.t('settings')}: ${choice.label}.`);
    }),
    vscode.commands.registerCommand('aiLimitLedger.selectDisplayLanguage', async () => {
      const choices: Array<vscode.QuickPickItem & { value: 'auto' | 'en' | 'tr' }> = [
        {
          label: localization.t('displayLanguageAuto'),
          description: localization.t('auto'),
          value: 'auto',
        },
        {
          label: localization.t('displayLanguageEnglish'),
          description: localization.t('displayLanguage'),
          value: 'en',
        },
        {
          label: localization.t('displayLanguageTurkish'),
          description: localization.t('displayLanguage'),
          value: 'tr',
        },
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        title: localization.t('displayLanguage'),
        placeHolder: localization.t('displayLanguage'),
      });
      if (!choice) return;
      await updateSetting(SETTING_KEYS.displayLanguage, choice.value);
      void vscode.window.showInformationMessage(localization.t('languageChanged'));
    }),
    vscode.commands.registerCommand('aiLimitLedger.resetDisplaySettings', async () => {
      const confirmation = await vscode.window.showWarningMessage(
        localization.t('resetConfirmation'),
        { modal: true },
        localization.t('resetDisplaySettings'),
        localization.t('cancel'),
      );
      if (confirmation !== localization.t('resetDisplaySettings')) return;
      const defaults: ReadonlyArray<
        readonly [import('../configuration/SettingsKeys').SettingKey, unknown]
      > = [
        [SETTING_KEYS.dashboardProviderVisibility, 'auto'],
        [SETTING_KEYS.dashboardProviderOrder, ['codex', 'claude', 'copilot', 'grok']],
        [SETTING_KEYS.dashboardOpenOnStartup, false],
        [SETTING_KEYS.dashboardShowAvailableIntegrations, true],
        [SETTING_KEYS.statusBarMode, 'compact'],
        [SETTING_KEYS.statusBarProviderOrder, ['codex', 'claude', 'copilot', 'grok']],
        [SETTING_KEYS.displayPercentageMode, 'remaining'],
        [SETTING_KEYS.displayLanguage, 'auto'],
        [SETTING_KEYS.displayTimeFormat, 'both'],
        [SETTING_KEYS.tooltipDensity, 'detailed'],
        [SETTING_KEYS.warningRemainingPercent, 30],
        [SETTING_KEYS.criticalRemainingPercent, 10],
        [SETTING_KEYS.notificationsLevel, 'errors'],
        [SETTING_KEYS.notificationsShowRecoveryActions, true],
      ];
      for (const [key, value] of defaults) await updateSetting(key, value);
      void vscode.window.showInformationMessage(
        `AI Limit Ledger: ${localization.t('settingsReset')}`,
      );
    }),
    vscode.commands.registerCommand(
      'aiLimitLedger.recoverDashboard',
      async (rawInvocation?: unknown) => {
        const correlationId = commandInvocationOf(rawInvocation)?.correlationId;
        const startedAt = Date.now();
        logger.logRecord('info', {
          correlationId,
          action: 'operation.started',
          stage: 'recover-dashboard',
          message: 'Dashboard recovery started.',
        });
        const result = await recoverDashboard(context);
        logger.logRecord('info', {
          correlationId,
          action: 'operation.completed',
          stage: 'recover-dashboard',
          durationMs: Date.now() - startedAt,
          message: `Dashboard recovery finished with status ${result.status}.`,
        });
        if (!isDashboardInvocation(rawInvocation))
          void vscode.window.showInformationMessage(
            result.status === 'success'
              ? localization.t('dashboardRecovered')
              : localization.t('dashboardRecoveryFailed'),
          );
        return isDashboardInvocation(rawInvocation)
          ? ({
              status: result.status,
              retryable: result.retryable,
            } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand('aiLimitLedger.enableClaudeCode', (rawInvocation?: unknown) =>
      enableClaude(
        context,
        () =>
          void refreshOrchestrator.refreshProvider('claude', { source: 'internal', force: true }),
        {
          notify: !isDashboardInvocation(rawInvocation),
        },
      ),
    ),
    vscode.commands.registerCommand('aiLimitLedger.disableClaudeCode', (rawInvocation?: unknown) =>
      disableClaude(
        context,
        () =>
          void refreshOrchestrator.refreshProvider('claude', { source: 'internal', force: true }),
        { notify: !isDashboardInvocation(rawInvocation) },
      ),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.repairClaudeCodeIntegration',
      (rawInvocation?: unknown) =>
        repairClaude(
          context,
          () =>
            void refreshOrchestrator.refreshProvider('claude', { source: 'internal', force: true }),
          {
            notify: !isDashboardInvocation(rawInvocation),
          },
        ),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.enableClaudeAutomaticRepair',
      (rawInvocation?: unknown) =>
        enableClaudeAutoRepair(context, { notify: !isDashboardInvocation(rawInvocation) }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.disableClaudeAutomaticRepair',
      (rawInvocation?: unknown) =>
        disableClaudeAutoRepair({ notify: !isDashboardInvocation(rawInvocation) }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.recheckClaudeIntegrationHealth',
      (rawInvocation?: unknown) =>
        recheckClaudeIntegrationHealth(
          context,
          () =>
            void refreshOrchestrator.refreshProvider('claude', { source: 'internal', force: true }),
          {
            notify: !isDashboardInvocation(rawInvocation),
          },
        ),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.diagnoseClaudeCodeIntegration',
      async (rawInvocation?: unknown) => {
        const report = await diagnoseClaude(context);
        logger.info(`Claude Code integration diagnostics:\n${report}`);
        logger.show();
        if (!isDashboardInvocation(rawInvocation))
          void vscode.window.showInformationMessage(
            localization.t('diagnosticsWritten', { provider: 'Claude Code' }),
          );
        return { status: 'success', retryable: true } satisfies CommandExecutionResult;
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.diagnoseCodexIntegration',
      async (rawInvocation?: unknown) => {
        const provider = getCodexProvider();
        const report = provider
          ? await provider.getCodexDiagnostics(true)
          : {
              selected: false,
              enabled: false,
              resolvedExecutablePath: null,
              executableExists: false,
              cliVersion: null,
              processState: 'not-configured' as const,
              processStartedAt: null,
              processExitCode: null,
              initialized: false,
              protocolVersion: null,
              requestStatus: null,
              lastSuccessfulSnapshotTime: null,
              lastSafeErrorCategory: null,
              stale: false,
              nextRetryAt: null,
              recommendedAction: 'Select Codex in aiLimitLedger.providers.',
              rateLimitsSubscriptionActive: false,
              lastNotificationTime: null,
              fallbackIntervalMs: 60_000,
              singleFlightActive: false,
              consecutiveFailures: 0,
              parsedWindowCount: 0,
            };
        logger.info(`Codex integration diagnostics:\n${formatCodexDiagnostics(report)}`);
        logger.show();
        if (!isDashboardInvocation(rawInvocation))
          void vscode.window.showInformationMessage(
            localization.t('diagnosticsWritten', { provider: 'Codex' }),
          );
        return { status: 'success', retryable: true } satisfies CommandExecutionResult;
      },
    ),
    vscode.commands.registerCommand('aiLimitLedger.openCodexUsagePage', (rawInvocation?: unknown) =>
      openCodexUsagePage({
        notify: !isDashboardInvocation(rawInvocation),
        context: commandInvocationOf(rawInvocation) ?? { source: 'command-palette' },
      }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.openClaudeUsagePage',
      (rawInvocation?: unknown) =>
        openClaudeUsagePage({
          notify: !isDashboardInvocation(rawInvocation),
          context: commandInvocationOf(rawInvocation) ?? { source: 'command-palette' },
        }),
    ),
    vscode.commands.registerCommand('aiLimitLedger.selectProviders', async () => {
      const current =
        settings?.getSnapshot().providers ??
        settingValue<string[]>(SETTING_KEYS.providers, ['codex', 'claude', 'copilot', 'grok']);
      const selected = await vscode.window.showQuickPick(
        [
          { label: 'Codex', id: 'codex', picked: current.includes('codex') },
          { label: 'Claude Code', id: 'claude', picked: current.includes('claude') },
          { label: 'GitHub Copilot', id: 'copilot', picked: current.includes('copilot') },
          { label: 'Grok', id: 'grok', picked: current.includes('grok') },
        ],
        { canPickMany: true, title: localization.t('selectProviders') },
      );
      if (!selected) return;
      await updateSetting(
        SETTING_KEYS.providers,
        selected.map((item) => item.id),
      );
      void vscode.window.showInformationMessage(localization.t('settings'));
    }),
    vscode.commands.registerCommand(
      'aiLimitLedger.restartAppServer',
      async (rawInvocation?: unknown) => {
        const client = getClient();
        const dashboard = isDashboardInvocation(rawInvocation);
        const invocation = commandInvocationOf(rawInvocation);
        if (!client)
          return dashboard
            ? ({
                status: 'error',
                safeErrorCategory: 'process-not-found',
                retryable: true,
              } satisfies CommandExecutionResult)
            : undefined;
        const correlationId = invocation?.correlationId ?? logger.createCorrelationId();
        if (dashboard) {
          try {
            await client.restart();
            await refreshOrchestrator.refreshProvider('codex', {
              source: 'dashboard',
              correlationId,
              force: true,
            });
            return { status: 'success', retryable: true } satisfies CommandExecutionResult;
          } catch (error) {
            return {
              status: 'error',
              safeErrorCategory: classifyErrorCategory(error),
              retryable: true,
            } satisfies CommandExecutionResult;
          }
        }
        {
          const startedAt = Date.now();
          logger.logRecord('info', {
            correlationId,
            action: 'operation.started',
            stage: 'app-server-restart',
            message: 'App Server restart started.',
          });
          try {
            await client.restart();
            await refreshOrchestrator.refreshProvider('codex', {
              source: 'command-palette',
              correlationId,
              force: true,
            });
            logger.logRecord('info', {
              correlationId,
              action: 'operation.completed',
              stage: 'app-server-restart',
              durationMs: Date.now() - startedAt,
              message: 'App Server restart completed.',
            });
          } catch (error) {
            logger.logError(error, {
              correlationId,
              action: 'operation.failed',
              stage: 'app-server-restart',
            });
            await safeErrors.present({
              providerName: 'Codex',
              action: 'restart the App Server',
              category: classifyErrorCategory(error),
            });
          }
        }
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.openSettings',
      async (rawInvocation?: unknown) => {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'aiLimitLedger');
        return isDashboardInvocation(rawInvocation)
          ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand('aiLimitLedger.showLogs', (rawInvocation?: unknown) => {
      logger.show();
      return isDashboardInvocation(rawInvocation)
        ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
        : undefined;
    }),
    vscode.commands.registerCommand(
      'aiLimitLedger.copyRedactedDiagnostics',
      async (rawInvocation?: unknown) => {
        const dashboard = isDashboardInvocation(rawInvocation);
        const invocation = commandInvocationOf(rawInvocation);
        const correlationId = invocation?.correlationId ?? logger.createCorrelationId();
        if (dashboard) {
          try {
            await vscode.env.clipboard.writeText(
              serializeRedacted(redactedDiagnostics(correlationId)),
            );
            return { status: 'success', retryable: true } satisfies CommandExecutionResult;
          } catch (error) {
            return {
              status: 'error',
              safeErrorCategory: classifyErrorCategory(error),
              retryable: true,
            } satisfies CommandExecutionResult;
          }
        }
        const startedAt = Date.now();
        logger.logRecord('info', {
          correlationId,
          action: 'operation.started',
          stage: 'copy-redacted-diagnostics',
          message: 'Redacted diagnostics copy started.',
        });
        try {
          await vscode.env.clipboard.writeText(
            serializeRedacted(redactedDiagnostics(correlationId)),
          );
          logger.logRecord('info', {
            correlationId,
            action: 'operation.completed',
            stage: 'copy-redacted-diagnostics',
            durationMs: Date.now() - startedAt,
            message: 'Redacted diagnostics copied.',
          });
          void vscode.window.showInformationMessage(`${localization.t('copied')}.`);
        } catch (error) {
          logger.logError(error, {
            correlationId,
            action: 'operation.failed',
            stage: 'copy-redacted-diagnostics',
          });
          await safeErrors.present({
            providerName: 'AI Limit Ledger',
            action: 'copy redacted diagnostics',
            category: classifyErrorCategory(error),
          });
        }
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.copyRedactedEffectiveSettings',
      async (rawInvocation?: unknown) => {
        const payload = settings?.redactedSnapshot() ?? {};
        try {
          await vscode.env.clipboard.writeText(serializeRedacted(payload));
          if (!isDashboardInvocation(rawInvocation))
            void vscode.window.showInformationMessage(`${localization.t('copied')}.`);
          return isDashboardInvocation(rawInvocation)
            ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
            : undefined;
        } catch (error) {
          if (isDashboardInvocation(rawInvocation))
            return {
              status: 'error',
              safeErrorCategory: classifyErrorCategory(error),
              retryable: true,
            } satisfies CommandExecutionResult;
          await safeErrors.present({
            providerName: 'AI Limit Ledger',
            action: 'copy redacted effective settings',
            category: classifyErrorCategory(error),
          });
          return undefined;
        }
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.exportRedactedSupportBundle',
      async (rawInvocation?: unknown) => {
        const dashboard = isDashboardInvocation(rawInvocation);
        const invocation = commandInvocationOf(rawInvocation);
        const correlationId = invocation?.correlationId ?? logger.createCorrelationId();
        const startedAt = Date.now();
        if (dashboard) {
          const now = new Date();
          const pad = (value: number) => String(value).padStart(2, '0');
          const suggestedName = `ai-limit-ledger-support-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(suggestedName),
            saveLabel: `${localization.t('exported')} ${localization.t('privacyFirst')}`,
            filters: { JSON: ['json'] },
          });
          if (!target)
            return {
              status: 'cancelled',
              safeErrorCategory: 'cancelled',
              retryable: false,
            } satisfies CommandExecutionResult;
          try {
            const bundle = buildRedactedSupportBundle(
              redactedDiagnostics(correlationId),
              {
                selectedProviders: coordinator.getSelectedProviderIds(),
                effectiveSettings: settings?.redactedSnapshot(),
                refresh: {
                  manualCooldownSeconds: settingValue(
                    SETTING_KEYS.manualRefreshCooldownSeconds,
                    DEFAULT_MANUAL_COOLDOWN_SECONDS,
                  ),
                  codexFallbackSeconds: settingValue(SETTING_KEYS.codexFallbackRefreshSeconds, 60),
                  claudeOAuthSeconds: settingValue(SETTING_KEYS.claudeOAuthRefreshSeconds, 120),
                },
              },
              logger.getRecentRecords(),
            );
            await writeRedactedSupportBundleAtomically(
              {
                writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
                rename: (from, to) => fs.rename(from, to),
                unlink: (filePath) => fs.unlink(filePath),
              },
              target.fsPath,
              bundle,
              `${target.fsPath}.tmp`,
            );
            return { status: 'success', retryable: true } satisfies CommandExecutionResult;
          } catch (error) {
            return {
              status: 'error',
              safeErrorCategory: classifyErrorCategory(error),
              retryable: true,
            } satisfies CommandExecutionResult;
          }
        }
        logger.logRecord('info', {
          correlationId,
          action: 'operation.started',
          stage: 'export-support-bundle',
          message: 'Redacted support bundle export started.',
        });
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, '0');
        const suggestedName = `ai-limit-ledger-support-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(suggestedName),
          saveLabel: `${localization.t('exported')} ${localization.t('privacyFirst')}`,
          filters: { JSON: ['json'] },
        });
        if (!target) {
          logger.logRecord('info', {
            correlationId,
            action: 'operation.cancelled',
            stage: 'export-support-bundle',
            durationMs: Date.now() - startedAt,
            message: 'Support bundle export cancelled.',
          });
          return;
        }
        try {
          const bundle = buildRedactedSupportBundle(
            redactedDiagnostics(correlationId),
            {
              selectedProviders: coordinator.getSelectedProviderIds(),
              effectiveSettings: settings?.redactedSnapshot(),
              refresh: {
                manualCooldownSeconds: settingValue(
                  SETTING_KEYS.manualRefreshCooldownSeconds,
                  DEFAULT_MANUAL_COOLDOWN_SECONDS,
                ),
                codexFallbackSeconds: settingValue(SETTING_KEYS.codexFallbackRefreshSeconds, 60),
                claudeOAuthSeconds: settingValue(SETTING_KEYS.claudeOAuthRefreshSeconds, 120),
              },
            },
            logger.getRecentRecords(),
          );
          const temporaryPath = `${target.fsPath}.tmp`;
          await writeRedactedSupportBundleAtomically(
            {
              writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
              rename: (from, to) => fs.rename(from, to),
              unlink: (filePath) => fs.unlink(filePath),
            },
            target.fsPath,
            bundle,
            temporaryPath,
          );
          logger.logRecord('info', {
            correlationId,
            action: 'operation.completed',
            stage: 'export-support-bundle',
            durationMs: Date.now() - startedAt,
            message: 'Redacted support bundle exported.',
          });
          void vscode.window.showInformationMessage(`${localization.t('exported')}.`);
        } catch (error) {
          logger.logError(error, {
            correlationId,
            action: 'operation.failed',
            stage: 'export-support-bundle',
          });
          await safeErrors.present({
            providerName: 'AI Limit Ledger',
            action: 'export a redacted support bundle',
            category: classifyErrorCategory(error),
          });
        }
      },
    ),
    vscode.commands.registerCommand('aiLimitLedger.clearCachedUsage', async () => {
      const correlationId = logger.createCorrelationId();
      const startedAt = Date.now();
      logger.logRecord('info', {
        correlationId,
        action: 'operation.started',
        stage: 'clear-cached-usage',
        message: 'Cached usage clear requested.',
      });
      const choice = await vscode.window.showWarningMessage(
        `${localization.t('reset')} ${localization.t('aiCredits').toLowerCase()}?`,
        {
          modal: true,
          detail: localization.t('cacheClearDetail'),
        },
        `${localization.t('reset')} ${localization.t('aiCredits')}`,
        localization.t('cancel'),
      );
      if (choice !== `${localization.t('reset')} ${localization.t('aiCredits')}`) {
        logger.logRecord('info', {
          correlationId,
          action: 'operation.cancelled',
          stage: 'clear-cached-usage',
          durationMs: Date.now() - startedAt,
          message: 'Cached usage clear cancelled.',
        });
        return;
      }
      try {
        await clearAllowedCaches(context.globalState);
        safeDashboard?.refresh();
        await refreshOrchestrator.refreshAll({
          source: 'command-palette',
          correlationId,
          force: false,
        });
        logger.logRecord('info', {
          correlationId,
          action: 'operation.completed',
          stage: 'clear-cached-usage',
          durationMs: Date.now() - startedAt,
          message: 'Cached usage cleared.',
        });
        void vscode.window.showInformationMessage(`${localization.t('updated')}.`);
      } catch (error) {
        logger.logError(error, {
          correlationId,
          action: 'operation.failed',
          stage: 'clear-cached-usage',
        });
        await safeErrors.present({
          providerName: 'AI Limit Ledger',
          action: 'clear cached usage',
          category: classifyErrorCategory(error),
        });
      }
    }),
    vscode.commands.registerCommand(
      'aiLimitLedger.openClaudeInstallGuide',
      (rawInvocation?: unknown) =>
        openClaudeInstallGuide({
          notify: !isDashboardInvocation(rawInvocation),
          context: commandInvocationOf(rawInvocation) ?? { source: 'command-palette' },
        }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.launchClaudeInTerminal',
      (rawInvocation?: unknown) =>
        launchClaudeInTerminal({ notify: !isDashboardInvocation(rawInvocation) }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.copyClaudeDiagnostics',
      (rawInvocation?: unknown) =>
        copyClaudeDiagnostics(context, { notify: !isDashboardInvocation(rawInvocation) }),
    ),
    vscode.commands.registerCommand('aiLimitLedger.openClaudeCode', (rawInvocation?: unknown) =>
      openClaudeCode({ notify: !isDashboardInvocation(rawInvocation) }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.copyClaudeUsageCommand',
      (rawInvocation?: unknown) =>
        copyClaudeUsageCommand({ notify: !isDashboardInvocation(rawInvocation) }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.openCliEnhancedModeDocs',
      (rawInvocation?: unknown) =>
        openCliEnhancedModeDocs({
          notify: !isDashboardInvocation(rawInvocation),
          context: commandInvocationOf(rawInvocation) ?? { source: 'command-palette' },
        }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.enableClaudeOAuthUsage',
      (rawInvocation?: unknown) =>
        enableClaudeOAuthUsage(
          context,
          () =>
            void refreshOrchestrator.refreshProvider('claude', {
              source: 'internal',
              force: true,
            }),
          {
            notify: !isDashboardInvocation(rawInvocation),
          },
        ),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.disableClaudeOAuthUsage',
      (rawInvocation?: unknown) =>
        disableClaudeOAuthUsage(
          context,
          () =>
            void refreshOrchestrator.refreshProvider('claude', {
              source: 'internal',
              force: true,
            }),
          {
            notify: !isDashboardInvocation(rawInvocation),
          },
        ),
    ),
    vscode.commands.registerCommand('aiLimitLedger.openExperimentalClaudeUsageDocs', async () => {
      await openExperimentalClaudeUsageDocs(context);
      return { status: 'success', retryable: true } satisfies CommandExecutionResult;
    }),
    vscode.commands.registerCommand(
      'aiLimitLedger.connectCopilotUsage',
      async (rawInvocation?: unknown) => {
        const result = await getCopilotProvider?.()?.connect();
        if (result && !isDashboardInvocation(rawInvocation))
          void vscode.window.showInformationMessage(
            localization.t('copilotUsageConnectionUpdated'),
          );
        if (isDashboardInvocation(rawInvocation))
          return result
            ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
            : ({
                status: 'error',
                safeErrorCategory: 'not-authenticated',
                retryable: false,
              } satisfies CommandExecutionResult);
        return undefined;
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.disconnectCopilotUsage',
      async (rawInvocation?: unknown) => {
        const result = await getCopilotProvider?.()?.disconnect();
        if (!isDashboardInvocation(rawInvocation))
          void vscode.window.showInformationMessage(localization.t('copilotTokenDisconnected'));
        return isDashboardInvocation(rawInvocation)
          ? ({
              status: result ? 'success' : 'error',
              retryable: false,
            } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.refreshCopilotUsage',
      async (rawInvocation?: unknown) => {
        return runProviderCommand('copilot', rawInvocation);
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.configureCopilotPlan',
      async (rawInvocation?: unknown) => {
        const dashboard = isDashboardInvocation(rawInvocation);
        const current = settingValue<CopilotPlan>(SETTING_KEYS.copilotPlan, 'auto');
        const selected = await vscode.window.showQuickPick(
          [
            {
              label: localization.t('auto'),
              description: localization.t('copilotPlanAutoDescription'),
              id: 'auto',
            },
            {
              label: 'Copilot Pro',
              description: localization.t('copilotPlanProDescription'),
              id: 'pro',
            },
            {
              label: 'Copilot Pro+',
              description: localization.t('copilotPlanProPlusDescription'),
              id: 'proPlus',
            },
            {
              label: 'Copilot Max',
              description: localization.t('copilotPlanMaxDescription'),
              id: 'max',
            },
            {
              label: localization.t('custom'),
              description: localization.t('copilotPlanCustomDescription'),
              id: 'custom',
            },
          ],
          { title: localization.t('copilotPlanTitle') },
        );
        if (!selected)
          return dashboard
            ? ({
                status: 'cancelled',
                safeErrorCategory: 'cancelled',
                retryable: false,
              } satisfies CommandExecutionResult)
            : undefined;
        let custom: number | undefined;
        if (selected.id === 'custom') {
          const value = await vscode.window.showInputBox({
            prompt: localization.t('copilotCustomCreditsPrompt'),
            value: String(settingValue(SETTING_KEYS.copilotCustomMonthlyCredits, 0) || ''),
            validateInput: (input) =>
              Number.isFinite(Number(input)) && Number(input) > 0
                ? undefined
                : 'Enter a positive number.',
          });
          if (!value)
            return dashboard
              ? ({
                  status: 'cancelled',
                  safeErrorCategory: 'cancelled',
                  retryable: false,
                } satisfies CommandExecutionResult)
              : undefined;
          custom = Number(value);
          await updateSetting(SETTING_KEYS.copilotCustomMonthlyCredits, custom);
        }
        await updateSetting(SETTING_KEYS.copilotPlan, selected.id);
        if (current !== selected.id || custom !== undefined)
          await refreshOrchestrator.refreshProvider('copilot', {
            source: dashboard ? 'dashboard' : 'command-palette',
            force: true,
          });
        return dashboard
          ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.diagnoseCopilotIntegration',
      (rawInvocation?: unknown) => {
        const provider = getCopilotProvider?.();
        const snapshot = provider?.getSnapshot();
        const meta = snapshot?.metadata ?? {};
        const experimentalAttempted = meta.billingEndpoint === 'experimental-entitlement';
        const report = formatCopilotDiagnostics({
          cli: provider?.cliInfo ?? { installed: false, executablePath: null, version: null },
          extension: provider?.extensionInfo ?? { installed: false, version: null, ids: [] },
          connected: snapshot?.connected ?? false,
          state: snapshot?.availability ?? 'unavailable',
          lastSuccessfulUpdateAt:
            snapshot?.lastSuccessfulUpdateAt ?? snapshot?.lastSuccessfulDataUpdate ?? null,
          nextRetryAt: snapshot?.retryAt ?? null,
          consecutive429s: 0,
          tokenPresent: false,
          experimental: experimentalAttempted
            ? {
                endpointReached: true,
                resultCategory: String(snapshot?.availability ?? 'unknown'),
                endpointPlanPresent:
                  meta.endpointPlan !== 'Not provided' && meta.endpointPlan != null,
                managementClassification: String(meta.accountManagement ?? 'unknown'),
                tokenBasedBilling:
                  typeof meta.tokenBasedBilling === 'boolean' ? meta.tokenBasedBilling : null,
                quotaBucketsRecognized: [
                  meta.premiumInteractionsCreditsUsed !== null ? 'premium_interactions' : null,
                  meta.chatCreditsUsed !== null ? 'chat' : null,
                  meta.completionsCreditsUsed !== null ? 'completions' : null,
                ].filter((value): value is string => value !== null),
                creditsUsedPresent: {
                  premium_interactions: meta.premiumInteractionsCreditsUsed !== null,
                  chat: meta.chatCreditsUsed !== null,
                  completions: meta.completionsCreditsUsed !== null,
                },
                usageMetricValues: {
                  premium_interactions:
                    typeof meta.premiumInteractionsCreditsUsed === 'number'
                      ? meta.premiumInteractionsCreditsUsed
                      : null,
                  chat: typeof meta.chatCreditsUsed === 'number' ? meta.chatCreditsUsed : null,
                  completions:
                    typeof meta.completionsCreditsUsed === 'number'
                      ? meta.completionsCreditsUsed
                      : null,
                },
                resetFieldPresent: typeof meta.quotaResetAt === 'number',
              }
            : undefined,
        });
        logger.info(`GitHub Copilot integration diagnostics:\n${report}`);
        logger.show();
        return isDashboardInvocation(rawInvocation)
          ? ({ status: 'success', retryable: true } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand('aiLimitLedger.openCopilotUsage', (rawInvocation?: unknown) =>
      openCopilotUsagePage({
        notify: !isDashboardInvocation(rawInvocation),
        context: commandInvocationOf(rawInvocation) ?? { source: 'command-palette' },
      }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.enableExperimentalCopilotUsage',
      async (rawInvocation?: unknown) => {
        let failedOutcome: 'cancelled' | 'error' | undefined;
        const ok = await enableExperimentalCopilotUsage(
          () =>
            void refreshOrchestrator.refreshProvider('copilot', {
              source: 'internal',
              force: true,
            }),
          {
            notify: !isDashboardInvocation(rawInvocation),
            onOutcome: (outcome) => {
              failedOutcome = outcome;
            },
            onConsent: () => context.globalState.update(COPILOT_EXPERIMENTAL_CONSENT_KEY, true),
            settings,
          },
        );
        if (!isDashboardInvocation(rawInvocation)) return ok;
        return ok
          ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
          : failedOutcome === 'cancelled'
            ? ({
                status: 'cancelled',
                safeErrorCategory: 'cancelled',
                retryable: false,
              } satisfies CommandExecutionResult)
            : ({
                status: 'error',
                safeErrorCategory: 'configuration-error',
                retryable: false,
              } satisfies CommandExecutionResult);
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.disableExperimentalCopilotUsage',
      async (rawInvocation?: unknown) => {
        let failedOutcome: 'cancelled' | 'error' | undefined;
        const ok = await disableExperimentalCopilotUsage(
          () =>
            void refreshOrchestrator.refreshProvider('copilot', {
              source: 'internal',
              force: true,
            }),
          {
            notify: !isDashboardInvocation(rawInvocation),
            onOutcome: (outcome) => {
              failedOutcome = outcome;
            },
            onConsent: () => context.globalState.update(COPILOT_EXPERIMENTAL_CONSENT_KEY, false),
            settings,
          },
        );
        if (!isDashboardInvocation(rawInvocation)) return ok;
        return ok
          ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
          : failedOutcome === 'cancelled'
            ? ({
                status: 'cancelled',
                safeErrorCategory: 'cancelled',
                retryable: false,
              } satisfies CommandExecutionResult)
            : ({
                status: 'error',
                safeErrorCategory: 'configuration-error',
                retryable: false,
              } satisfies CommandExecutionResult);
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.enableGrokUsage',
      async (rawInvocation?: unknown) => {
        await context.globalState.update('aiLimitLedger.grok.enabled', true);
        const result = await getGrokProvider?.()?.enable();
        return isDashboardInvocation(rawInvocation)
          ? ({
              status: result ? 'success' : 'error',
              retryable: false,
            } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.disableGrokUsage',
      async (rawInvocation?: unknown) => {
        await context.globalState.update('aiLimitLedger.grok.enabled', false);
        const result = getGrokProvider?.()?.disable();
        return isDashboardInvocation(rawInvocation)
          ? ({
              status: result ? 'success' : 'error',
              retryable: false,
            } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.refreshGrokUsage',
      async (rawInvocation?: unknown) => {
        return runProviderCommand('grok', rawInvocation);
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.recheckGrokInstallation',
      async (rawInvocation?: unknown) => {
        const result = await getGrokProvider?.()?.recheckInstallation(true);
        return isDashboardInvocation(rawInvocation)
          ? ({
              status: result ? 'success' : 'error',
              retryable: true,
            } satisfies CommandExecutionResult)
          : result;
      },
    ),
    vscode.commands.registerCommand('aiLimitLedger.launchGrokLogin', (rawInvocation?: unknown) => {
      const terminal = vscode.window.createTerminal({ name: 'Grok Login' });
      terminal.show();
      const executable = getGrokProvider?.()?.cliInfo.executablePath ?? 'grok';
      const command =
        process.platform === 'win32'
          ? `& '${executable.replaceAll("'", "''")}' login`
          : `'${executable.replaceAll("'", "'\\''")}' login`;
      terminal.sendText(command);
      return isDashboardInvocation(rawInvocation)
        ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
        : undefined;
    }),
    vscode.commands.registerCommand(
      'aiLimitLedger.diagnoseGrokIntegration',
      (rawInvocation?: unknown) => {
        const provider = getGrokProvider?.();
        const snapshot = provider?.getSnapshot();
        const report = formatGrokDiagnostics({
          cli: provider?.cliInfo ?? { installed: false, executablePath: null, version: null },
          extension: provider?.extensionInfo ?? {
            installed: false,
            id: null,
            version: null,
            official: false,
          },
          state: snapshot?.availability ?? 'unavailable',
          billingMethod: 'x.ai/billing',
          capabilityCached: snapshot?.availability === 'method-not-supported',
          retryAt: snapshot?.retryAt ?? null,
          experimentalFallbackStatus: provider?.experimentalFallbackStatusText,
        });
        logger.info(`Grok integration diagnostics:\n${report}`);
        logger.show();
        return isDashboardInvocation(rawInvocation)
          ? ({ status: 'success', retryable: true } satisfies CommandExecutionResult)
          : undefined;
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.openGrokInstallGuide',
      (rawInvocation?: unknown) =>
        openGrokInstallGuide({
          notify: !isDashboardInvocation(rawInvocation),
          context: commandInvocationOf(rawInvocation) ?? { source: 'command-palette' },
        }),
    ),
    vscode.commands.registerCommand('aiLimitLedger.openGrokUsage', (rawInvocation?: unknown) =>
      openGrokUsagePage({
        notify: !isDashboardInvocation(rawInvocation),
        context: commandInvocationOf(rawInvocation) ?? { source: 'command-palette' },
      }),
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.enableExperimentalGrokUsage',
      async (rawInvocation?: unknown) => {
        let failedOutcome: 'cancelled' | 'error' | undefined;
        const ok = await enableExperimentalGrokUsage(
          () =>
            void refreshOrchestrator.refreshProvider('grok', {
              source: 'internal',
              force: true,
            }),
          {
            notify: !isDashboardInvocation(rawInvocation),
            onOutcome: (outcome) => {
              failedOutcome = outcome;
            },
            onConsent: () => context.globalState.update(GROK_EXPERIMENTAL_CONSENT_KEY, true),
            settings,
          },
        );
        if (!isDashboardInvocation(rawInvocation)) return ok;
        return ok
          ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
          : failedOutcome === 'cancelled'
            ? ({
                status: 'cancelled',
                safeErrorCategory: 'cancelled',
                retryable: false,
              } satisfies CommandExecutionResult)
            : ({
                status: 'error',
                safeErrorCategory: 'configuration-error',
                retryable: false,
              } satisfies CommandExecutionResult);
      },
    ),
    vscode.commands.registerCommand(
      'aiLimitLedger.disableExperimentalGrokUsage',
      async (rawInvocation?: unknown) => {
        let failedOutcome: 'cancelled' | 'error' | undefined;
        const ok = await disableExperimentalGrokUsage(
          () =>
            void refreshOrchestrator.refreshProvider('grok', {
              source: 'internal',
              force: true,
            }),
          {
            notify: !isDashboardInvocation(rawInvocation),
            onOutcome: (outcome) => {
              failedOutcome = outcome;
            },
            onConsent: () => context.globalState.update(GROK_EXPERIMENTAL_CONSENT_KEY, false),
            settings,
          },
        );
        if (!isDashboardInvocation(rawInvocation)) return ok;
        return ok
          ? ({ status: 'success', retryable: false } satisfies CommandExecutionResult)
          : failedOutcome === 'cancelled'
            ? ({
                status: 'cancelled',
                safeErrorCategory: 'cancelled',
                retryable: false,
              } satisfies CommandExecutionResult)
            : ({
                status: 'error',
                safeErrorCategory: 'configuration-error',
                retryable: false,
              } satisfies CommandExecutionResult);
      },
    ),
  );
}
