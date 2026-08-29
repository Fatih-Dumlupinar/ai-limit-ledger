import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexExecutableResolver } from './appServer/CodexExecutableResolver';
import { CodexAppServerClient } from './appServer/CodexAppServerClient';
import { Logger } from './infrastructure/Logger';
import { StatusBarController } from './ui/StatusBarController';
import { CodexProvider, clampFallbackIntervalMs } from './providers/CodexProvider';
import {
  ClaudeCodeProvider,
  claudeBridgePath,
  claudeHookActivityPath,
} from './providers/ClaudeCodeProvider';
import { normalizeProviderId, ProviderCoordinator } from './providers/ProviderCoordinator';
import { ProviderRefreshOrchestrator } from './providers/ProviderRefreshOrchestrator';
import { registerCommands } from './commands/registerCommands';
import { migrateSettings } from './infrastructure/migrateSettings';
import { refreshDashboard, setDashboardRenderSettings } from './ui/DetailsView';
import {
  buildSafeDashboardDocumentModel,
  SafeDashboardController,
  dashboardModeFromConfiguration,
  setConfiguredDashboardMode,
} from './ui/SafeDashboard';
import {
  autoHealClaude,
  buildClaudeClassifier,
  buildOnSnapshotConfirmed,
  claudeIntegrationAvailable,
  setClaudeSettingsProvider,
} from './providers/ClaudeIntegration';
import {
  loadLastSeenExtensionVersion,
  loadOwnership,
  saveLastSeenExtensionVersion,
} from './providers/claude/ClaudeRecoveryStore';
import { applyClaudeOAuthOverlay } from './providers/claude/ClaudeSourcePriority';
import { ClaudeOAuthUsageService } from './providers/claude/oauth/ClaudeOAuthUsageService';
import type { FetchLike } from './providers/claude/oauth/ClaudeOAuthUsageTransport';
import {
  lastEventOfType,
  readLatestHookActivity,
} from './providers/claude/hooks/ClaudeHookActivityReader';
import type { ProviderSnapshot } from './providers/types';
import { CopilotProvider } from './providers/copilot/CopilotProvider';
import { detectCopilotExtensions } from './providers/copilot/CopilotExtensionDetection';
import { GitHubAuthenticationService } from './providers/copilot/GitHubAuthenticationService';
import { GitHubBillingClient, type GitHubResponse } from './providers/copilot/GitHubBillingClient';
import { GrokAcpClient } from './providers/grok/GrokAcpClient';
import { AcpGrokBillingTransport } from './providers/grok/GrokBillingTransport';
import { GrokProvider } from './providers/grok/GrokProvider';
import { detectGrokExtension } from './providers/grok/GrokExtensionDetection';
import { copilotExperimentalUsageEnabled } from './providers/copilot/CopilotExperimentalConsent';
import { grokExperimentalUsageEnabled } from './providers/grok/GrokExperimentalConsent';
import type { FetchLike as CopilotEntitlementFetchLike } from './providers/copilot/experimental/CopilotEntitlementTransport';
import type { FetchLike as GrokProxyFetchLike } from './providers/grok/experimental/GrokCliProxyTransport';
import {
  COPILOT_EXPERIMENTAL_ENABLED,
  COPILOT_EXECUTABLE_PATH,
  COPILOT_EXPERIMENTAL_CONSENT_KEY,
  GROK_EXPERIMENTAL_ENABLED,
  GROK_EXPERIMENTAL_CONSENT_KEY,
  DASHBOARD_MODE,
  fullSettingKey,
  SETTING_KEYS,
} from './configuration/SettingsKeys';
import { SettingsService } from './configuration/SettingsService';
import { localization } from './localization/LocalizationService';
let cleanup: (() => void) | undefined;

/** Debounces a file-change-triggered refresh so a burst of writes (e.g. one settings save) doesn't cause a refresh storm. */
export function debounce(
  fn: () => void,
  delayMs: number,
): { fire: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    fire: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, delayMs);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Registers the recorded Claude wrapper watcher without making watcher failures fatal to activation. */
export function registerWrapperWatcher(
  wrapperPath: string,
  watchers: vscode.Disposable[],
  refresh: () => void,
  onRegistrationError: () => void,
  createWatcher: (pattern: vscode.RelativePattern) => vscode.FileSystemWatcher = (pattern) =>
    vscode.workspace.createFileSystemWatcher(pattern),
): void {
  const registered: vscode.Disposable[] = [];
  const safeRefresh = (): void => {
    try {
      refresh();
    } catch {
      try {
        onRegistrationError();
      } catch {
        // Diagnostics must not turn a watcher callback failure into an activation failure.
      }
    }
  };
  try {
    const wrapperWatcher = createWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(wrapperPath)),
        path.basename(wrapperPath),
      ),
    );
    registered.push(wrapperWatcher);
    registered.push(wrapperWatcher.onDidChange(safeRefresh));
    registered.push(wrapperWatcher.onDidCreate(safeRefresh));
    registered.push(wrapperWatcher.onDidDelete(safeRefresh));
    watchers.push(...registered);
  } catch {
    registered.forEach((disposable) => {
      try {
        disposable.dispose();
      } catch {
        // Best-effort cleanup only.
      }
    });
    try {
      onRegistrationError();
    } catch {
      // A logging failure must not escape the local watcher boundary.
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  context.subscriptions.push(logger);
  try {
    // Provider selection migration must run before the first configuration read; otherwise the
    // current activation would keep using the legacy list until the next reload.
    await migrateSettings(context);
  } catch (error) {
    logger.error(
      `Settings migration failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  const settings = new SettingsService();
  localization.setLanguage(settings.settings.display.language, vscode.env.language);
  context.subscriptions.push(localization);
  setClaudeSettingsProvider(
    () => settings.settings,
    (key, value) =>
      settings.update(
        key === 'claudeAutoRepair'
          ? SETTING_KEYS.claudeAutoRepair
          : SETTING_KEYS.claudeOAuthEnabled,
        value,
      ),
  );
  logger.setLevel(settings.settings.logging.level);
  const status = new StatusBarController(settings);
  context.subscriptions.push(settings, status);
  const configured = settings.settings.executables.codex;
  const executable = new CodexExecutableResolver().resolve(configured);
  const selected = [...new Set(settings.settings.providers.map(normalizeProviderId))];
  let client: CodexAppServerClient | undefined;
  if (executable) {
    client = new CodexAppServerClient(executable, logger);
  }
  const createCodexProvider = (): CodexProvider => {
    const fallbackSeconds = settings.settings.refresh.codexFallbackSeconds;
    return new CodexProvider(client, logger, clampFallbackIntervalMs(fallbackSeconds * 1000));
  };
  const createClaudeProvider = (): ClaudeCodeProvider =>
    new ClaudeCodeProvider(
      claudeBridgePath(context),
      () => context.globalState.get<boolean>('aiLimitLedger.claudeEnabled', false),
      claudeIntegrationAvailable,
      buildClaudeClassifier(context),
      buildOnSnapshotConfirmed(context),
    );
  const githubAuth = new GitHubAuthenticationService(vscode.authentication, context.secrets, {
    choose: async (items) => {
      const picked = await vscode.window.showQuickPick(items, {
        title: `${localization.t('connect')} GitHub Copilot ${localization.t('usageWindow').toLowerCase()}`,
        placeHolder: `${localization.t('settings')}: ${localization.t('source').toLowerCase()}`,
      });
      return picked as (typeof items)[number] | undefined;
    },
    input: (prompt) => vscode.window.showInputBox({ prompt, password: true }),
  });
  const runtimeFetch = (
    globalThis as {
      fetch?: (url: string, init: { headers: Record<string, string> }) => Promise<GitHubResponse>;
    }
  ).fetch;
  const githubBilling = new GitHubBillingClient(async (url, init) => {
    if (!runtimeFetch) throw new Error('Fetch is unavailable in this VS Code host.');
    return runtimeFetch(url, { headers: init.headers });
  });
  const runtimeFetchGeneric = (globalThis as { fetch?: unknown }).fetch;
  const createCopilotProvider = (): CopilotProvider =>
    new CopilotProvider({
      authentication: githubAuth,
      billing: githubBilling,
      globalState: context.globalState,
      windowId: `${process.pid}-${Math.random().toString(36).slice(2)}`,
      plan: () => settings.settings.providersConfig.copilotPlan,
      customMonthlyCredits: () => settings.settings.providersConfig.copilotCustomMonthlyCredits,
      refreshSeconds: () => settings.settings.refresh.copilotSeconds,
      detectExtensions: () => detectCopilotExtensions(vscode.extensions.all),
      executablePath: () => settings.settings.executables.copilot,
      experimentalEnabled: () =>
        copilotExperimentalUsageEnabled(
          () =>
            settings.settings.experimental.copilotEntitlementEnabled &&
            context.globalState.get<boolean>(COPILOT_EXPERIMENTAL_CONSENT_KEY, false),
        ),
      experimentalFetch: runtimeFetchGeneric as CopilotEntitlementFetchLike | undefined,
    });
  const createGrokProvider = (): GrokProvider =>
    new GrokProvider({
      globalState: context.globalState,
      windowId: `${process.pid}-${Math.random().toString(36).slice(2)}`,
      enabled: () => context.globalState.get<boolean>('aiLimitLedger.grok.enabled', false),
      executablePath: () => settings.settings.executables.grok,
      workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      refreshSeconds: () => settings.settings.refresh.grokSeconds,
      detectExtension: () => detectGrokExtension(vscode.extensions.all),
      createTransport: (executablePath) =>
        new AcpGrokBillingTransport(new GrokAcpClient(executablePath)),
      experimentalEnabled: () =>
        grokExperimentalUsageEnabled(
          () =>
            settings.settings.experimental.grokCliProxyEnabled &&
            context.globalState.get<boolean>(GROK_EXPERIMENTAL_CONSENT_KEY, false),
        ),
      experimentalFetch: runtimeFetchGeneric as GrokProxyFetchLike | undefined,
      authFile: { readFile: (p, enc) => fs.readFile(p, enc) },
      homeDir: () => process.env.USERPROFILE ?? process.env.HOME ?? '',
    });
  // Keep all four lightweight provider objects available so an unselected card gets an explicit
  // not-selected snapshot and a later setting change can start the provider without reloading.
  const providers = [
    createCodexProvider(),
    createClaudeProvider(),
    createCopilotProvider(),
    createGrokProvider(),
  ];
  const coordinator = new ProviderCoordinator(providers, logger, {
    selectedProviderIds: selected,
    providerFactories: {
      codex: createCodexProvider,
      claude: createClaudeProvider,
      copilot: createCopilotProvider,
      grok: createGrokProvider,
    },
  });

  const oauthWindowId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const oauthService = selected.includes('claude')
    ? new ClaudeOAuthUsageService({
        fs: { readFile: (p, enc) => fs.readFile(p, enc) },
        homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '',
        fetchImpl: (globalThis as { fetch?: FetchLike }).fetch as FetchLike,
        globalState: context.globalState as unknown as ConstructorParameters<
          typeof ClaudeOAuthUsageService
        >[0]['globalState'],
        enabled: () => settings.settings.experimental.claudeOAuthEnabled,
        refreshSecondsProvider: () => settings.settings.refresh.claudeOAuthSeconds,
        cacheMaxAgeHoursProvider: () => settings.settings.cache.maxAgeHours,
        showExpiredCacheProvider: () => settings.settings.cache.showExpiredInDashboard,
        windowId: oauthWindowId,
      })
    : undefined;

  /** Overlays the experimental OAuth usage snapshot (if any) onto the Claude provider's own output — see `applyClaudeOAuthOverlay`. Codex and any other provider pass through untouched. */
  const withOAuthOverlay = (snapshots: ProviderSnapshot[]): ProviderSnapshot[] =>
    oauthService
      ? snapshots.map((snapshot) => {
          if (snapshot.providerId !== 'claude') return snapshot;
          const overlay = applyClaudeOAuthOverlay(snapshot, oauthService.getSnapshot());
          return {
            ...overlay,
            metadata: {
              ...overlay.metadata,
              statusLineIntervalSeconds: settings.settings.refresh.claudeStatusLineSeconds,
              oauthRefreshSeconds: settings.settings.refresh.claudeOAuthSeconds,
            },
          };
        })
      : snapshots;

  const safeDashboard = new SafeDashboardController({
    modelSource: () =>
      buildSafeDashboardDocumentModel(withOAuthOverlay(coordinator.getSnapshots()), {
        selectedProviderIds: coordinator.getSelectedProviderIds(),
        version: String(context.extension.packageJSON?.version ?? '0.6.0'),
        providerVisibility: settings.settings.dashboard.providerVisibility,
        providerOrder: settings.settings.dashboard.providerOrder,
        showAvailableIntegrations: settings.settings.dashboard.showAvailableIntegrations,
        percentageMode: settings.settings.display.percentageMode,
        thresholds: settings.settings.thresholds,
        language: settings.settings.display.language,
        timeFormat: settings.settings.display.timeFormat,
        dashboardMode: settings.settings.dashboard.mode,
        statusBarMode: settings.settings.statusBar.mode,
        tooltipDensity: settings.settings.tooltip.density,
        insightsMode: settings.settings.dashboard.insightsMode,
        notificationLevel: settings.settings.notifications.level,
      }),
  });
  safeDashboard.register();
  setConfiguredDashboardMode(dashboardModeFromConfiguration(settings.settings.dashboard.mode));
  setDashboardRenderSettings({
    providerVisibility: settings.settings.dashboard.providerVisibility,
    providerOrder: settings.settings.dashboard.providerOrder,
    showAvailableIntegrations: settings.settings.dashboard.showAvailableIntegrations,
    percentageMode: settings.settings.display.percentageMode,
    language: settings.settings.display.language,
    timeFormat: settings.settings.display.timeFormat,
    thresholds: settings.settings.thresholds,
    insightsMode: settings.settings.dashboard.insightsMode,
  });
  context.subscriptions.push(safeDashboard);

  const refreshOrchestrator = new ProviderRefreshOrchestrator({
    coordinator,
    globalState: context.globalState,
    windowId: `${process.pid}-${Math.random().toString(36).slice(2)}`,
    logger,
    refreshClaudeOAuth: oauthService ? () => oauthService.requestRefresh('manual') : undefined,
  });
  context.subscriptions.push({ dispose: () => refreshOrchestrator.dispose() });

  const renderAll = (): void => {
    const merged = withOAuthOverlay(coordinator.getSnapshots());
    status.renderProviders(merged);
    refreshDashboard(merged);
    safeDashboard.refresh();
  };

  coordinator.onDidChange(() => renderAll());
  oauthService?.onDidChange(() => renderAll());
  // Runtime language changes are render-only. This event never reaches a provider or refresh
  // orchestrator, so an open Rich/Safe dashboard, status bar and tooltip all update from the
  // existing snapshots without a network request or action replay.
  localization.onDidChange(() => renderAll());
  // Commands are available even when migration or provider startup fails.
  registerCommands(
    context,
    coordinator,
    () => client,
    () => coordinator.getProvider<CodexProvider>('codex'),
    logger,
    () => coordinator.getProvider<CopilotProvider>('copilot'),
    () => coordinator.getProvider<GrokProvider>('grok'),
    () => withOAuthOverlay(coordinator.getSnapshots()),
    refreshOrchestrator,
    safeDashboard,
    settings,
  );
  const runAutoHeal = (): void => {
    void autoHealClaude(
      context,
      () =>
        void refreshOrchestrator.refreshProvider('claude', {
          source: 'internal',
          force: true,
        }),
    ).catch((error) =>
      logger.error(
        `Claude auto-heal run failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
    );
  };
  const timer = setInterval(() => {
    void refreshOrchestrator.refreshAll({ source: 'internal', force: false });
    if (coordinator.getSelectedProviderIds().includes('claude')) runAutoHeal();
  }, 30_000);
  timer.unref?.();

  // The experimental OAuth usage transport's own minimum-interval/lease/backoff gates (see
  // `ClaudeOAuthUsageService`) govern the real network cadence; this timer just offers it a
  // chance to run periodically. Calling it while disabled, still in backoff, or already fresh
  // is a cheap no-op — no filesystem or network access happens on those paths.
  let lastProcessedHookObservedAt: string | undefined;
  const oauthTimer = oauthService
    ? setInterval(() => {
        void oauthService.requestRefresh('timer').then(renderAll);
      }, 30_000)
    : undefined;

  const checkHookActivity = (): void => {
    if (!oauthService) return;
    void readLatestHookActivity(
      { readFile: (p, enc) => fs.readFile(p, enc) },
      claudeHookActivityPath(context),
    ).then((events) => {
      const stop = lastEventOfType(events, 'Stop');
      const stopFailure = lastEventOfType(events, 'StopFailure');
      const sessionStart = lastEventOfType(events, 'SessionStart');
      const latest = [stop, stopFailure, sessionStart]
        .filter((e): e is NonNullable<typeof e> => Boolean(e))
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .pop();
      if (!latest || latest.observedAt === lastProcessedHookObservedAt) return;
      lastProcessedHookObservedAt = latest.observedAt;
      // The hook is purely an activity trigger — it never supplies a percentage or a rate-limit
      // decision itself; only the service's own request/response cycle does that.
      void oauthService.requestRefresh('activity').then(renderAll);
    });
  };

  // Settings/snapshot changes (ours or Claude Code's own rewrites) should reconcile state and
  // refresh the dashboard without polling or reopening it.
  const watchedRefresh = debounce(
    () => void refreshOrchestrator.refreshAll({ source: 'internal', force: false }),
    750,
  );
  // Separate, slightly shorter debounce so a burst of Claude-related fs events triggers at most
  // one auto-heal classification/repair pass, independent of the dashboard refresh cadence.
  const autoHealDebounce = debounce(runAutoHeal, 1000);
  const onClaudeFsEvent = (): void => {
    watchedRefresh.fire();
    autoHealDebounce.fire();
  };
  const watchers: vscode.Disposable[] = [];
  if (selected.includes('claude')) {
    const home = process.env.USERPROFILE ?? process.env.HOME;
    for (const pattern of ['**/.claude/settings.json', '**/.claude/settings.local.json']) {
      const projectSettingsWatcher = vscode.workspace.createFileSystemWatcher(pattern);
      watchers.push(
        projectSettingsWatcher,
        projectSettingsWatcher.onDidChange(onClaudeFsEvent),
        projectSettingsWatcher.onDidCreate(onClaudeFsEvent),
        projectSettingsWatcher.onDidDelete(onClaudeFsEvent),
      );
    }
    if (home) {
      const userSettingsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(home), '.claude/settings.json'),
      );
      const snapshotWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(context.globalStorageUri, 'claude-status.json'),
      );
      watchers.push(
        userSettingsWatcher,
        userSettingsWatcher.onDidChange(onClaudeFsEvent),
        userSettingsWatcher.onDidCreate(onClaudeFsEvent),
        userSettingsWatcher.onDidDelete(onClaudeFsEvent),
        snapshotWatcher,
        snapshotWatcher.onDidChange(watchedRefresh.fire),
        snapshotWatcher.onDidCreate(watchedRefresh.fire),
      );
      if (oauthService) {
        // Signal-only: the watcher callback never reads the credential file itself — it only
        // tells the service a fresh read is worth attempting, subject to every normal gate.
        const credentialsWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(home), '.claude/.credentials.json'),
        );
        const activityWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(context.globalStorageUri, 'claude-hook-activity.jsonl'),
        );
        const onCredentialChange = (): void => {
          void oauthService.requestRefresh('activity').then(renderAll);
        };
        watchers.push(
          credentialsWatcher,
          credentialsWatcher.onDidChange(onCredentialChange),
          credentialsWatcher.onDidCreate(onCredentialChange),
          activityWatcher,
          activityWatcher.onDidChange(checkHookActivity),
          activityWatcher.onDidCreate(checkHookActivity),
        );
      }
    }
    // The wrapper's own path is only known once ownership has been recorded (i.e. after at
    // least one successful Enable in a past session). This watches whatever path was recorded
    // at activation time; a wrapper installed for the first time later in this same session is
    // still covered by the settings/snapshot watchers above and the periodic refresh below.
    const wrapperPath = loadOwnership(context.globalState)?.wrapperPath;
    if (wrapperPath)
      registerWrapperWatcher(wrapperPath, watchers, onClaudeFsEvent, () =>
        logger.error('Claude wrapper watcher registration failed; continuing startup.'),
      );
  }

  const applySettings = (
    change: import('./configuration/SettingsService').SettingsChangeEvent,
  ): void => {
    const current = change.settings;
    logger.setLevel(current.logging.level);
    setConfiguredDashboardMode(dashboardModeFromConfiguration(current.dashboard.mode));
    setDashboardRenderSettings({
      providerVisibility: current.dashboard.providerVisibility,
      providerOrder: current.dashboard.providerOrder,
      showAvailableIntegrations: current.dashboard.showAvailableIntegrations,
      percentageMode: current.display.percentageMode,
      language: current.display.language,
      timeFormat: current.display.timeFormat,
      thresholds: current.thresholds,
      insightsMode: current.dashboard.insightsMode,
    });
    // Update render preferences before setLanguage emits. The synchronous localization event then
    // re-renders Rich/Safe/status/tooltip surfaces from the new settings and cached snapshots.
    const localizationChanged = localization.setLanguage(
      current.display.language,
      vscode.env.language,
    );
    coordinator
      .getProvider<CodexProvider>('codex')
      ?.setFallbackIntervalMs(clampFallbackIntervalMs(current.refresh.codexFallbackSeconds * 1000));
    if (change.requiresProviderReconcile) {
      void coordinator
        .reconcile(current.providers)
        .then(renderAll)
        .catch((error) =>
          logger.error(
            `Provider selection reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        );
    }
    // Executable changes only re-run the matching provider detector. No login/model request is
    // started. Directly enabling an experimental boolean intentionally does not refresh: consent
    // commands are the only path that may activate its transport.
    if (change.providerRedetection.includes(SETTING_KEYS.copilotExecutablePath))
      void coordinator.getProvider<CopilotProvider>('copilot')?.recheckCli();
    if (change.providerRedetection.includes(SETTING_KEYS.grokExecutablePath))
      void coordinator.getProvider<GrokProvider>('grok')?.recheckInstallation(false);
    // A language event already rendered every surface. Other settings still use the normal
    // render path; neither path refreshes a provider for display-only changes.
    if (!localizationChanged) renderAll();
  };
  settings.onDidChange(applySettings);
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    // These explicit canonical checks document the security-sensitive paths and retain the
    // manifest-coverage guarantee; SettingsService performs the complete typed reconciliation.
    if (
      event.affectsConfiguration(fullSettingKey(DASHBOARD_MODE)) ||
      event.affectsConfiguration(fullSettingKey(COPILOT_EXPERIMENTAL_ENABLED)) ||
      event.affectsConfiguration(fullSettingKey(GROK_EXPERIMENTAL_ENABLED)) ||
      event.affectsConfiguration(fullSettingKey(COPILOT_EXECUTABLE_PATH))
    ) {
      settings.handleConfigurationChange(event);
      return;
    }
    settings.handleConfigurationChange(event);
  });
  context.subscriptions.push(configWatcher);

  cleanup = () => {
    clearInterval(timer);
    if (oauthTimer) clearInterval(oauthTimer);
    watchedRefresh.dispose();
    autoHealDebounce.dispose();
    watchers.forEach((w) => w.dispose());
    coordinator.dispose();
  };
  context.subscriptions.push({ dispose: cleanup });
  status.loading();
  await coordinator.start();

  if (selected.includes('claude')) {
    const currentExtensionVersion = context.extension.packageJSON?.version as string | undefined;
    const lastSeenVersion = loadLastSeenExtensionVersion(context.globalState);
    if (currentExtensionVersion && currentExtensionVersion !== lastSeenVersion) {
      await saveLastSeenExtensionVersion(context.globalState, currentExtensionVersion);
    }
    runAutoHeal();
  }
  if (settings.settings.dashboard.openOnStartup) {
    // Activation is already onStartupFinished. This render-only open never refreshes a provider.
    void vscode.commands.executeCommand('aiLimitLedger.openDashboard');
  }
}
export function deactivate(): void {
  cleanup?.();
  cleanup = undefined;
}
