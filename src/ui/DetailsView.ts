import * as vscode from 'vscode';
import type { LimitSnapshot } from '../appServer/types';
import { isDashboardActionRequest, type DashboardActionId } from './DashboardActionProtocol';
import {
  getDashboardActionDefinition,
  isRegisteredDashboardAction,
} from './DashboardActionRegistry';
import {
  getDashboardActionIconId,
  renderDashboardIcon,
  type DashboardIconId,
} from './DashboardIcons';
import type { DashboardActionRunner, DashboardActionState } from './DashboardActionRunner';
import {
  normalizeProviderId,
  PROVIDER_CAPABILITY_DESCRIPTORS,
  resolveProviderPresentation,
  resolveProviderPresentations,
  sourceKindForSnapshot,
  type ProviderCapabilityDescriptor,
  type ProviderPresentationState,
} from '../providers/ProviderCapabilityContract';
import type { ProviderId, ProviderSnapshot } from '../providers/types';
import {
  elapsedDuration,
  formatPercent,
  formatReset,
  remainingDuration,
} from '../limits/RateLimitFormatter';
import {
  clampPercentage as clampRemainingPercentage,
  createRemainingCapacityProgress,
  type RemainingCapacityThresholds,
} from '../limits/RemainingCapacityProgress';
import {
  formatConfiguredTime,
  formatProviderCount,
  getUiTextCatalog,
  localizedProviderGuidance,
  localizedProviderLinkLabel,
  localizedProviderSourceLabel,
  localizedRateLimitWindowLabel,
  percentageText,
  rateLimitWindowKind,
  type UiTextCatalog,
} from './UiTextCatalog';
import { localization } from '../localization/LocalizationService';
import type { Logger } from '../infrastructure/Logger';
import { getProviderInstallGuidance, getProviderLink } from '../links/ProviderLinkRegistry';
import {
  createDashboardPanelSession,
  disposeDashboardPanelSession,
  DASHBOARD_READY_TIMEOUT_MS,
  hashHtml,
  isDashboardReadyMessage,
  logDashboardLifecycle,
  type DashboardPanelSession,
} from './DashboardPanelSession';
import {
  getSafeDashboardDiagnosticsSnapshot,
  insightSourceKindLabel,
  localizedInsightLabel,
  recordRichDashboardUsed,
  recordRichDashboardReadyTimeout,
  safeUsageInsightsForSnapshot,
  type SafeUsageInsight,
  type DashboardMode,
} from './SafeDashboard';
import {
  buildProviderPresentationSummary,
  formatPresentedReset,
  presentedPercentageText,
  type PresentedQuotaWindow,
  type ProviderPresentationSummary,
} from './ProviderPresentation';
import type { InsightsMode } from '../configuration/EffectiveSettings';
export const PROVIDER_INITIALIZATION_TIMEOUT_MS = 10_000;
export const DASHBOARD_VERSION = '0.6.0';

export interface DashboardRenderSettings {
  providerVisibility?: 'auto' | 'active-only' | 'all-supported';
  providerOrder?: readonly string[];
  showAvailableIntegrations?: boolean;
  percentageMode?: 'remaining' | 'used' | 'both';
  language?: 'auto' | 'en' | 'tr';
  timeFormat?: 'locale' | 'relative' | 'absolute' | 'both';
  thresholds?: RemainingCapacityThresholds;
  insightsMode?: InsightsMode;
}

let dashboardRenderSettings: DashboardRenderSettings = {};

export function setDashboardRenderSettings(settings: DashboardRenderSettings): void {
  dashboardRenderSettings = {
    ...settings,
    providerOrder: settings.providerOrder?.slice(),
    thresholds: settings.thresholds ? { ...settings.thresholds } : undefined,
  };
}
export function isAllowedMessage(value: unknown): ReturnType<typeof isDashboardActionRequest> {
  return isDashboardActionRequest(value);
}
export function createNonce(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}
export function showDetails(
  snapshot: LimitSnapshot | undefined,
  context: vscode.ExtensionContext,
  runner?: DashboardActionRunner,
): void {
  if (!snapshot) {
    void vscode.window.showInformationMessage(localization.t('noUsageDataYet'));
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'aiLimitLedger.details',
    'AI Limit Ledger',
    vscode.ViewColumn.One,
    { enableScripts: true },
  );
  panel.webview.html = renderWebview(snapshot, createNonce());
  const detailsMessageListener = panel.webview.onDidReceiveMessage(
    (message: unknown) => {
      runner?.handleRequest(message);
    },
    undefined,
    context.subscriptions,
  );
  panel.onDidDispose(() => detailsMessageListener.dispose());
}

let currentSession: DashboardPanelSession | undefined;
let dashboardRunner: DashboardActionRunner | undefined;
let dashboardLogoUri: string | undefined;
let dashboardLogger: Logger | undefined;
let lastKnownSnapshots: ProviderSnapshot[] = [];
let recoveryInFlight: Promise<DashboardRecoveryResult> | undefined;
let safeDashboardOpener: ((fallback: boolean) => Promise<void> | void) | undefined;
const pendingSnapshots = new WeakMap<DashboardPanelSession, ProviderSnapshot[]>();
const renderTimers = new WeakMap<DashboardPanelSession, ReturnType<typeof setTimeout>>();

function providerLinkLabel(
  id: Parameters<typeof getProviderLink>[0],
  catalog: UiTextCatalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto'),
): string {
  return localizedProviderLinkLabel(id, catalog);
}

export function setDashboardActionRunner(runner: DashboardActionRunner): void {
  dashboardRunner = runner;
}

/** Diagnostics/logging never identifies a panel beyond this generation counter — see DashboardPanelSession. */
export function setDashboardLogger(logger: Logger): void {
  dashboardLogger = logger;
}

export function setSafeDashboardOpener(opener: (fallback: boolean) => Promise<void> | void): void {
  safeDashboardOpener = opener;
}

/** Test-only: clears all module-level Dashboard panel state between test runs. */
export function __resetDashboardStateForTests(): void {
  currentSession = undefined;
  dashboardRunner = undefined;
  dashboardLogoUri = undefined;
  dashboardLogger = undefined;
  lastKnownSnapshots = [];
  dashboardRenderSettings = {};
  recoveryInFlight = undefined;
  safeDashboardOpener = undefined;
}

function assignDashboardHtml(
  session: DashboardPanelSession,
  snapshots: ProviderSnapshot[],
  options: { force?: boolean } = {},
): void {
  if (session.disposed || currentSession?.generation !== session.generation) return;
  const actionStates = dashboardRunner?.getActionStates() ?? [];
  const inputHash = hashHtml(JSON.stringify({ snapshots, actionStates, dashboardRenderSettings }));
  if (!options.force && session.lastHtmlHash === inputHash) return;
  session.lastHtmlHash = inputHash;
  session.htmlAssignmentCount += 1;
  session.panel.webview.html = renderDashboard(
    snapshots,
    createNonce(),
    actionStates,
    dashboardLogoUri,
    session.panel.webview.cspSource,
  );
}

/** Coalesces rapid successive render requests (e.g. a burst of provider snapshot changes) into a single `webview.html` assignment, and defers any render until the panel's script has confirmed it is ready. */
function scheduleDashboardRender(
  session: DashboardPanelSession,
  snapshots: ProviderSnapshot[],
): void {
  if (session.disposed) return;
  pendingSnapshots.set(session, snapshots);
  if (!session.ready) return;
  if (renderTimers.has(session)) return;
  const timer = setTimeout(() => {
    renderTimers.delete(session);
    if (session.disposed || currentSession?.generation !== session.generation) return;
    const latest = pendingSnapshots.get(session);
    pendingSnapshots.delete(session);
    if (latest) assignDashboardHtml(session, latest);
  }, 50);
  renderTimers.set(session, timer);
  session.disposables.push({ dispose: () => clearTimeout(timer) });
}

function markSessionReady(session: DashboardPanelSession): void {
  if (session.disposed || session.ready) return;
  session.ready = true;
  session.readyAt = Date.now();
  if (dashboardLogger)
    logDashboardLifecycle(dashboardLogger, 'dashboard.panel.ready', session.generation, {
      readyLatencyMs: session.readyAt - session.createdAt,
    });
  const pending = pendingSnapshots.get(session);
  pendingSnapshots.delete(session);
  if (pending) assignDashboardHtml(session, pending);
}

function startReadyTimeout(session: DashboardPanelSession, context: vscode.ExtensionContext): void {
  const timer = setTimeout(() => {
    if (session.disposed || session.ready || session.readyTimeoutNotified) return;
    session.readyTimeoutNotified = true;
    recordRichDashboardReadyTimeout();
    if (dashboardLogger)
      logDashboardLifecycle(dashboardLogger, 'dashboard.panel.ready-timeout', session.generation);
    void vscode.window
      .showWarningMessage(
        localization.t('webviewInitFailed'),
        {},
        localization.t('openSafeDashboard'),
        localization.t('recreateDashboard'),
        localization.t('reloadWebviews'),
        localization.t('showLogs'),
        localization.t('cancel'),
      )
      .then((choice) => {
        if (choice === localization.t('openSafeDashboard')) {
          if (safeDashboardOpener) void Promise.resolve(safeDashboardOpener(true));
          else void vscode.commands.executeCommand('aiLimitLedger.openSafeDashboard');
        } else if (choice === localization.t('recreateDashboard')) void recoverDashboard(context);
        else if (choice === localization.t('reloadWebviews'))
          void vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
        else if (choice === localization.t('showLogs')) dashboardLogger?.show();
      });
  }, DASHBOARD_READY_TIMEOUT_MS);
  session.disposables.push({ dispose: () => clearTimeout(timer) });
}

/**
 * Opens (or reveals) the single AI Limit Ledger Dashboard panel.
 *
 * A live, non-disposed panel is revealed rather than recreated. A panel that exists
 * but has not yet sent `dashboard.ready` is still revealed, but no second panel is
 * created underneath it. A disposed/invalid panel reference is dropped and a fresh
 * one is created. If a Recover Dashboard run is in flight, this defers to it instead
 * of racing a second panel into existence.
 */
export function showDashboard(
  snapshots: ProviderSnapshot[],
  context: vscode.ExtensionContext,
  runner: DashboardActionRunner = dashboardRunner as DashboardActionRunner,
): void {
  lastKnownSnapshots = snapshots;
  // Rich is only recorded when this function is explicitly used; safe-native mode never calls it.
  recordRichDashboardUsed();
  dashboardRunner = runner;
  runner?.attachSink((message) => {
    if (!currentSession || currentSession.disposed) return;
    void currentSession.panel.webview.postMessage(message);
  });

  if (currentSession && !currentSession.disposed) {
    currentSession.panel.reveal();
    if (currentSession.ready) assignDashboardHtml(currentSession, snapshots);
    else pendingSnapshots.set(currentSession, snapshots);
    return;
  }

  if (recoveryInFlight) return;

  currentSession = undefined;

  const panel = vscode.window.createWebviewPanel(
    'aiLimitLedger.dashboard',
    'AI Limit Ledger Dashboard',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
    },
  );
  const session = createDashboardPanelSession(panel);
  currentSession = session;
  dashboardLogoUri = panel.webview
    .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png'))
    .toString();
  if (dashboardLogger)
    logDashboardLifecycle(dashboardLogger, 'dashboard.panel.created', session.generation);

  assignDashboardHtml(session, snapshots, { force: true });

  const dashboardMessageListener = panel.webview.onDidReceiveMessage(
    (message: unknown) => {
      if (session.disposed) return;
      if (isDashboardReadyMessage(message)) {
        markSessionReady(session);
        return;
      }
      runner?.handleRequest(message);
    },
    undefined,
    session.disposables,
  );
  session.disposables.push(dashboardMessageListener);

  startReadyTimeout(session, context);

  panel.onDidDispose(
    () => {
      disposeDashboardPanelSession(session);
      if (dashboardLogger)
        logDashboardLifecycle(dashboardLogger, 'dashboard.panel.disposed', session.generation);
      if (currentSession === session) currentSession = undefined;
      if (currentSession === undefined) dashboardLogoUri = undefined;
      if (dashboardRunner === runner) runner?.detachSink();
    },
    undefined,
    context.subscriptions,
  );
}

/** Re-renders the open Dashboard webview (if any) from a live provider-state change, without recreating the panel. */
export function refreshDashboard(snapshots: ProviderSnapshot[]): void {
  lastKnownSnapshots = snapshots;
  if (!currentSession || currentSession.disposed) return;
  scheduleDashboardRender(currentSession, snapshots);
}

/** Disposes only a Rich panel that failed its ready handshake before opening the safe fallback. */
export function disposeDashboardIfNotReady(): void {
  const session = currentSession;
  if (!session || session.disposed || session.ready) return;
  disposeDashboardPanelSession(session);
  try {
    session.panel.dispose();
  } catch {
    // The host may have already disposed the panel while the timeout notification was open.
  }
  if (currentSession === session) currentSession = undefined;
  dashboardLogoUri = undefined;
}

export interface DashboardRecoveryResult {
  status: 'success' | 'throttled' | 'error';
  retryable: boolean;
}

/**
 * Disposes the current Dashboard panel session (if any) and creates exactly one new
 * one. Single-flight: a concurrent call while a recovery is already running returns
 * the same in-flight result instead of starting a second recovery. Never touches
 * provider state, credentials, settings, or any cache.
 */
export function recoverDashboard(
  context: vscode.ExtensionContext,
): Promise<DashboardRecoveryResult> {
  if (recoveryInFlight) return recoveryInFlight;
  const run = (async (): Promise<DashboardRecoveryResult> => {
    try {
      if (currentSession) {
        const stale = currentSession;
        disposeDashboardPanelSession(stale);
        try {
          stale.panel.dispose();
        } catch {
          // The panel may already be gone (e.g. the user closed it moments earlier).
        }
        if (currentSession === stale) currentSession = undefined;
      }
      showDashboard(lastKnownSnapshots, context, dashboardRunner as DashboardActionRunner);
      if (dashboardLogger && currentSession)
        logDashboardLifecycle(
          dashboardLogger,
          'dashboard.panel.recovered',
          currentSession.generation,
        );
      return { status: 'success', retryable: true };
    } catch {
      return { status: 'error', retryable: true };
    }
  })();
  recoveryInFlight = run.finally(() => {
    recoveryInFlight = undefined;
  });
  return recoveryInFlight;
}

export interface DashboardDiagnosticsSnapshot {
  panelPresent: boolean;
  generation: number | null;
  ready: boolean;
  visible: boolean;
  disposed: boolean;
  createdAt: number | null;
  readyAt: number | null;
  readyLatencyMs: number | null;
  htmlAssignmentCount: number;
  recoveryInProgress: boolean;
  configuredMode: DashboardMode;
  lastRendererUsed: 'rich-webview' | 'safe-native' | null;
  safeDashboardRegistered: boolean;
  safeDashboardOpen: boolean;
  safeDashboardLastRenderedAt: number | null;
  safeDashboardRenderCount: number;
  lastRichDashboardReadyTimeout: number | null;
  lastFallbackAction: string | null;
}

/** Redacted, safe-for-diagnostics view of the Dashboard panel's lifecycle state — no panel id, webview origin, or path. */
export function getDashboardDiagnosticsSnapshot(): DashboardDiagnosticsSnapshot {
  const session = currentSession;
  return {
    panelPresent: session !== undefined && !session.disposed,
    generation: session?.generation ?? null,
    ready: session?.ready ?? false,
    visible: session?.panel.visible ?? false,
    disposed: session?.disposed ?? true,
    createdAt: session?.createdAt ?? null,
    readyAt: session?.readyAt ?? null,
    readyLatencyMs:
      session?.readyAt !== undefined && session !== undefined
        ? session.readyAt - session.createdAt
        : null,
    htmlAssignmentCount: session?.htmlAssignmentCount ?? 0,
    recoveryInProgress: recoveryInFlight !== undefined,
    ...getSafeDashboardDiagnosticsSnapshot(),
  };
}

function renderDashboardRaw(
  snapshots: ProviderSnapshot[],
  nonce: string,
  actionStates: readonly DashboardActionState[] = [],
  logoUri?: string,
  cspSource = "'none'",
): string {
  const stateMap = new Map(actionStates.map((state) => [state.actionId, state]));
  const presentations = resolveProviderPresentations(snapshots);
  const snapshotById = new Map<string, ProviderSnapshot>();
  snapshots.forEach((snapshot) => {
    const id = normalizeProviderId(snapshot.providerId);
    if (!snapshotById.has(id)) snapshotById.set(id, snapshot);
  });
  const presentationById = new Map(
    presentations.map((presentation) => [
      normalizeProviderId(presentation.providerId),
      presentation,
    ]),
  );
  const descriptors = (
    dashboardRenderSettings.providerOrder ??
    PROVIDER_CAPABILITY_DESCRIPTORS.map((descriptor) => descriptor.providerId)
  )
    .map((providerId) =>
      PROVIDER_CAPABILITY_DESCRIPTORS.find(
        (descriptor) => descriptor.providerId === normalizeProviderId(providerId),
      ),
    )
    .filter((descriptor): descriptor is ProviderCapabilityDescriptor => Boolean(descriptor));
  for (const descriptor of PROVIDER_CAPABILITY_DESCRIPTORS) {
    if (!descriptors.some((entry) => entry.providerId === descriptor.providerId))
      descriptors.push(descriptor);
  }
  const entries = descriptors.map((descriptor) => ({
    descriptor,
    snapshot: snapshotById.get(descriptor.providerId),
    presentation: presentationById.get(descriptor.providerId),
  }));
  const activeEntries = entries.filter(
    ({ presentation }) => presentation?.dashboardPlacement === 'active',
  );
  const availableEntries =
    dashboardRenderSettings.showAvailableIntegrations === false ||
    dashboardRenderSettings.providerVisibility === 'active-only'
      ? []
      : entries.filter(
          ({ presentation }) => !presentation || presentation.dashboardPlacement === 'available',
        );
  const latestCheck = snapshots.reduce<number | undefined>((latest, snapshot) => {
    const value = validTimestamp(snapshot.checkedAt) ?? validTimestamp(snapshot.observedAt);
    return value !== undefined && (latest === undefined || value > latest) ? value : latest;
  }, undefined);
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const allProvidersFailed =
    presentations.length > 1 &&
    presentations.length === snapshots.length &&
    presentations.every(
      (presentation) =>
        presentation.normalizedState === 'error' ||
        presentation.normalizedState === 'startup-error',
    );
  const renderGroup = (
    title: string,
    headingId: string,
    cards: string,
    emptyText: string,
  ): string =>
    `<section class="provider-group" aria-labelledby="${headingId}"><div class="section-heading"><div><p class="eyebrow">${catalog.status}</p><h2 id="${headingId}">${title}</h2></div><span class="section-count">${cards ? catalog.shown : catalog.notAvailable}</span></div><div class="provider-grid">${cards || `<div class="empty-state"><p>${emptyText}</p></div>`}</div></section>`;
  const activeCards = activeEntries
    .map(({ descriptor, snapshot, presentation }) =>
      renderDashboardProviderCard(snapshot, descriptor, presentation, stateMap),
    )
    .join('');
  const availableCards = availableEntries
    .map(({ descriptor, snapshot, presentation }) =>
      renderDashboardAvailableProviderCard(descriptor, snapshot, presentation, stateMap),
    )
    .join('');
  const logo = logoUri
    ? `<img class="brand-mark" src="${escapeHtml(logoUri)}" alt="AI Limit Ledger">`
    : '';
  const activeSummary = formatProviderCount(activeEntries.length, catalog);
  const globalAlert = allProvidersFailed
    ? `<p class="global-alert" role="status">${catalog.unavailable}.</p>`
    : '';
  const preferences = `<aside class="preferences-summary" aria-label="Preferences"><strong>Preferences</strong><span>Dashboard: ${dashboardRenderSettings.providerVisibility ?? 'auto'} · Percentage: ${dashboardRenderSettings.percentageMode ?? 'remaining'} · Available integrations: ${dashboardRenderSettings.showAvailableIntegrations === false ? 'hidden' : 'shown'}</span></aside>`;
  const activeEmpty =
    dashboardRenderSettings.language === 'tr'
      ? `${catalog.activeProviders}: ${catalog.notProvided}`
      : 'No active providers yet. Choose an integration below to start monitoring usage.';
  const availableEmpty =
    dashboardRenderSettings.language === 'tr'
      ? `${catalog.availableIntegrations}: ${catalog.notProvided}`
      : 'All supported integrations are currently active.';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeHtml(logoUri ? cspSource : "'none'")}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">${dashboardStylesWithInsights()}${dashboardIconStyles()}</style></head><body><main class="dashboard-shell" data-dashboard-version="${DASHBOARD_VERSION}"><header class="dashboard-header"><div class="brand-row">${logo}<div class="brand-copy"><p class="eyebrow">PRIVATE DEVELOPER TOOL</p><h1>AI Limit Ledger</h1><p class="tagline">AI coding usage, limits and reset windows in one place.</p></div></div><div class="header-meta"><div><strong>${activeSummary}</strong><span>${latestCheck === undefined ? `${catalog.lastCheck}: ${catalog.notProvided}` : `${catalog.lastCheck}: ${escapeHtml(formatDate(latestCheck))}`}</span></div><span class="header-status"><span class="status-dot" aria-hidden="true"></span>Local snapshots</span></div>${preferences}<div class="global-actions">${actionButton('refresh-all', 'Refresh All', stateMap, 'primary')}${actionButton('open-provider-settings', 'Provider Settings', stateMap, 'secondary')}<details class="more-actions"><summary aria-label="More actions">${renderDashboardIcon('more', { className: 'more-actions__icon' })}<span>More actions</span></summary><div class="more-actions__menu">${actionButton('show-logs', 'Show Logs', stateMap, 'menu')}${actionButton('copy-redacted-diagnostics', 'Copy Diagnostics', stateMap, 'menu')}${actionButton('export-redacted-support-bundle', 'Export Support Bundle', stateMap, 'menu')}</div></details></div>${globalAlert}<div id="dashboard-action-status" class="action-feedback" role="status" aria-live="polite"></div></header>${renderGroup(catalog.activeProviders, 'active-providers-heading', activeCards, activeEmpty)}${renderGroup(catalog.availableIntegrations, 'available-integrations-heading', availableCards, availableEmpty)}<footer class="dashboard-footer"><span>Data is read locally from provider integrations and cached snapshots.</span><span>Privacy-first · v${DASHBOARD_VERSION}</span></footer></main><script nonce="${nonce}">${dashboardScript(catalog)}</script></body></html>`;
}

/** Applies translations to the static Rich Dashboard chrome after the existing safe HTML
 * renderer has built it. Dynamic provider names, model names and raw provider fields are left
 * untouched. This wrapper also keeps action state and the single-panel lifecycle unchanged. */
export function renderDashboard(
  snapshots: ProviderSnapshot[],
  nonce: string,
  actionStates: readonly DashboardActionState[] = [],
  logoUri?: string,
  cspSource = "'none'",
): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  let html = renderDashboardRaw(snapshots, nonce, actionStates, logoUri, cspSource);
  // The English raw renderer is the compatibility baseline. Only translate its chrome when the
  // runtime preference resolves to Turkish; dynamic provider data and action state remain intact.
  if (catalog === getUiTextCatalog('en')) return html;
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ['PRIVATE DEVELOPER TOOL', catalog.privateDeveloperTool],
    ['AI coding usage, limits and reset windows in one place.', catalog.dashboardSubtitle],
    ['Local snapshots', catalog.localSnapshots],
    ['Refresh All', catalog.refreshAll],
    ['Provider Settings', catalog.providerSettings],
    ['More actions', catalog.moreActions],
    ['Show Logs', catalog.showLogs],
    ['Copy Diagnostics', catalog.copyDiagnostics],
    ['Export Support Bundle', catalog.exportSupportBundle],
    ['Usage data is temporarily unavailable.', catalog.unavailable],
    ['Preferences', catalog.settings],
    [
      'No active providers yet. Choose an integration below to start monitoring usage.',
      `${catalog.activeProviders}: ${catalog.notProvided}`,
    ],
    ['All supported integrations are currently active.', catalog.availableIntegrations],
    [
      'Data is read locally from provider integrations and cached snapshots.',
      catalog.dataReadLocally,
    ],
    ['Privacy-first', catalog.privacyFirst],
    ['Visible', catalog.ready],
    ['Empty', catalog.notProvided],
    ['MONITORING', catalog.status],
    ['Status:', `${catalog.status}:`],
    ['Source:', `${catalog.source}:`],
    ['Plan:', `${catalog.plan}:`],
    ['Used ', `${catalog.used} `],
    ['Remaining ', `${catalog.remaining} `],
    ['Reset ', `${catalog.reset} `],
    ['Last check:', `${catalog.lastCheck}:`],
    ['Last successful data update:', `${catalog.lastSuccessfulUpdate}:`],
    ['Last provider event:', `${catalog.lastProviderEvent}:`],
    ['Snapshot age:', `${catalog.snapshotAge}:`],
    ['Next automatic check:', `${catalog.nextAutomaticCheck}:`],
    ['Data status:', `${catalog.dataState}:`],
    ['Stale data', catalog.stale],
    ['Experimental', catalog.experimental],
    ['Details', catalog.detailed],
    ['Commands:', `${catalog.commands}:`],
    ['Refresh', catalog.refresh],
    ['Restart App Server', `${catalog.refresh} App Server`],
    ['Diagnose', catalog.diagnose],
    ['Enable CLI-free usage', `${catalog.enabled} CLI-free usage`],
    ['Learn more', catalog.note],
    ['Connect Claude Code', `${catalog.connect} Claude Code`],
    ['Disable CLI-free usage', `${catalog.disabledAction} CLI-free usage`],
    ['Open Claude Code', `Claude Code ${catalog.openDashboard.toLowerCase()}`],
    ['Copy /usage', 'Copy /usage'],
    ['Recheck automatic tracking', `${catalog.refresh} automatic tracking`],
    ['Learn about enhanced CLI mode', `${catalog.note}: enhanced CLI mode`],
    ['Try Automatic Claude Usage Tracking', `${catalog.enableIntegration}: Claude usage`],
    ['Repair integration', catalog.repairIntegration],
    ['Refresh Claude Usage', `${catalog.refresh} Claude usage`],
    ['Disable integration', catalog.disableIntegration],
    ['Starting…', catalog.starting],
    ['Refreshing…', catalog.refreshing],
    ['Refreshing Codex', `${catalog.refresh} Codex`],
    ['Refreshing Claude', `${catalog.refresh} Claude`],
    ['Opening…', catalog.opening],
    ['Copying…', catalog.copying],
    ['Exporting…', catalog.exporting],
    ['Restarting…', `${catalog.refresh}…`],
    ['Checking…', catalog.checking],
    ['Enabling…', catalog.enabling],
    ['Disabling…', catalog.disabling],
    ['Repairing…', `${catalog.repairIntegration}…`],
    ['Connecting…', catalog.connecting],
    ['Disconnecting…', catalog.disconnecting],
    ['Saving…', catalog.saving],
    ['Cancelled', catalog.cancelled],
    ['Try again later', catalog.tryAgainLater],
    ['Security validation failed.', catalog.securityValidationFailed],
    ['Failed', catalog.failed],
    ['Ready (experimental)', `${catalog.ready} (${catalog.experimental.toLowerCase()})`],
    ['Ready', catalog.ready],
    [
      'Stale — showing last known good data',
      `${catalog.stale} — ${catalog.lastKnownGood.toLowerCase()}`,
    ],
    [
      'Rate limited — showing last known good data',
      `${catalog.rateLimited} — ${catalog.lastKnownGood.toLowerCase()}`,
    ],
    ['Rate limited', catalog.rateLimited],
    ['Sign-in required', catalog.signInRequired],
    ['Authentication required', catalog.authenticationRequired],
    ['CLI not installed', catalog.cliNotInstalled],
    ['Setup required', catalog.setupRequired],
    ['Disabled', catalog.disabled],
    ['Not selected', catalog.notSelected],
    ['Provider is not selected or has not started.', catalog.providerNotStarted],
    ['Select Provider', catalog.selectProvider],
    ['Select this provider in settings to start it.', catalog.selectProviderInSettings],
    ['No usage data yet.', catalog.usageDataUnavailableYet],
    ['No usage data', catalog.noUsageData],
    ['Percentage not provided', catalog.percentageNotProvided],
    ['Limit exhausted', catalog.limitExhausted],
    ['Critical — limit nearly exhausted', catalog.criticalNearlyExhausted],
    ['Low remaining capacity', catalog.lowRemainingCapacity],
    ['Official', catalog.official],
    ['Community', catalog.community],
    ['Recheck integration health', `${catalog.refresh} integration health`],
    ['Enable automatic repair', `${catalog.enabled} automatic repair`],
    ['Disable automatic repair', `${catalog.disabledAction} automatic repair`],
    ['Recheck integration', `${catalog.refresh} integration`],
    ['Launch Claude Terminal', 'Claude Terminal aç'],
    ['Connect', catalog.connect],
    ['Disconnect', catalog.disconnect],
    ['Configure plan', catalog.configurePlan],
    ['Enable experimental usage', `${catalog.enabled} ${catalog.experimental.toLowerCase()} usage`],
    [
      'Disable experimental usage',
      `${catalog.disabledAction} ${catalog.experimental.toLowerCase()} usage`,
    ],
    ['Recheck installation', catalog.recheckInstallation],
    ['Connect Grok', `${catalog.connect} Grok`],
    ['Enable integration', catalog.enableIntegration],
    ['Disable integration', catalog.disableIntegration],
    ['No usage data', catalog.noNumericUsage],
    ['Usage data is not available yet.', catalog.numericUsageUnavailable],
    ['Numeric usage is not exposed by this source.', catalog.numericUsageUnavailable],
    [
      'Monthly allowance not provided. Raw metrics are shown without a fabricated percentage.',
      catalog.numericUsageUnavailable,
    ],
    ['Monthly AI credits', catalog.monthlyAiCredits],
    ['AI credits', catalog.aiCredits],
    ['Premium interactions', catalog.premiumInteractions],
    ['Chat quota', catalog.chatQuota],
    ['Completions quota', catalog.completionsQuota],
    ['Account management', catalog.accountManagement],
    ['Endpoint plan', catalog.endpointPlan],
    ['Build usage', catalog.buildUsage],
    ['Extra credits', catalog.extraCredits],
    ['Current session context window', catalog.contextUsed],
    ['Session cost', catalog.sessionCostUsd],
    ['Session cost (USD)', catalog.sessionCostUsd],
    ['Connection:', `${catalog.connection}:`],
    ['Connected', catalog.connected],
    ['Not connected', catalog.notConnected],
    ['Not provided', catalog.notProvided],
  ];
  for (const [from, to] of replacements) html = html.replaceAll(from, to);
  html = html.replace(
    /<aside class="preferences-summary"[\s\S]*?<\/aside>/,
    `<aside class="preferences-summary" aria-label="${catalog.settings}"><strong>${catalog.settings}</strong><span>${preferenceSummary(catalog)}</span></aside>`,
  );
  html = html.replace(
    /<p class="card-note">[^<]*Showing last known usage\.<\/p>/g,
    `<p class="card-note">${catalog.showingLastKnownUsage}</p>`,
  );
  return html;
}

function dashboardIconStyles(): string {
  return `.action-button__leading-icon,.action-button__state-icon,.action-button__state-icon-item,.more-actions__icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 1rem;width:1rem;height:1rem;color:currentColor}.action-button__leading-icon[hidden],.action-button__state-icon[hidden],.action-button__state-icon-item[hidden],.action-button__spinner[hidden]{display:none}.action-button__leading-icon svg,.action-button__state-icon svg,.action-button__state-icon-item svg,.more-actions__icon{display:block;width:1rem;height:1rem}.action-button__spinner{display:inline-block;visibility:visible;width:1rem;height:1rem;flex:0 0 1rem;border-width:2px}.more-actions summary{gap:7px}.more-actions summary::after{content:none}.usage-progress--warning{border-color:var(--vscode-editorWarning-foreground)}.usage-progress--critical{border-color:var(--vscode-editorError-foreground)}.usage-progress__status{font-weight:600}.usage-progress__status--warning{color:var(--vscode-editorWarning-foreground)}.usage-progress__status--critical{color:var(--vscode-editorError-foreground)}@media(forced-colors:active){.action-button__leading-icon,.action-button__state-icon,.more-actions__icon,.usage-progress--warning,.usage-progress--critical{color:ButtonText;border-color:ButtonText}}`;
}

function preferenceValue(value: string | undefined, catalog: UiTextCatalog): string {
  switch (value) {
    case 'auto':
      return catalog.auto;
    case 'remaining':
      return catalog.remaining;
    case 'used':
      return catalog.used;
    case 'both':
      return catalog.both;
    case 'active-only':
      return catalog.compact;
    case 'all-supported':
      return catalog.detailed;
    default:
      return value ?? catalog.auto;
  }
}

function preferenceSummary(catalog: UiTextCatalog): string {
  const visibility = preferenceValue(dashboardRenderSettings.providerVisibility, catalog);
  const percentage = preferenceValue(dashboardRenderSettings.percentageMode, catalog);
  const integrations =
    dashboardRenderSettings.showAvailableIntegrations === false ? catalog.hidden : catalog.shown;
  return `${catalog.dashboard}: ${visibility} · ${catalog.percentageDisplay}: ${percentage} · ${catalog.availableIntegrations}: ${integrations}`;
}

function localizedActionLabel(
  actionId: DashboardActionId,
  fallback: string,
  catalog: UiTextCatalog,
): string {
  const providerRefresh: Partial<Record<DashboardActionId, string>> = {
    'refresh-codex': `${catalog.refresh} Codex`,
    'refresh-claude': catalog.refreshClaudeUsage,
    'refresh-copilot': `${catalog.refresh} GitHub Copilot`,
    'refresh-grok': `${catalog.refresh} Grok`,
  };
  if (actionId === 'refresh-claude' && fallback === 'Recheck automatic tracking')
    return catalog.recheckAutomaticTracking;
  if (providerRefresh[actionId]) return providerRefresh[actionId]!;
  switch (actionId) {
    case 'refresh-all':
      return catalog.refreshAll;
    case 'open-provider-settings':
      return catalog.providerSettings;
    case 'show-logs':
      return catalog.showLogs;
    case 'copy-redacted-diagnostics':
      return catalog.copyDiagnostics;
    case 'export-redacted-support-bundle':
      return catalog.exportSupportBundle;
    case 'restart-codex-app-server':
      return `${catalog.refresh} App Server`;
    case 'diagnose-codex':
    case 'diagnose-claude':
    case 'diagnose-copilot':
    case 'diagnose-grok':
      return catalog.diagnose;
    case 'open-codex-usage':
      return localizedProviderLinkLabel('codex-usage', catalog);
    case 'open-claude-usage':
      return localizedProviderLinkLabel('claude-usage', catalog);
    case 'open-claude-install-guide':
      return localizedProviderLinkLabel('claude-install', catalog);
    case 'open-claude-enhanced-mode-docs':
      return localizedProviderLinkLabel('claude-vscode-docs', catalog);
    case 'open-copilot-usage':
      return localizedProviderLinkLabel('copilot-billing', catalog);
    case 'open-grok-usage':
      return localizedProviderLinkLabel('grok-billing', catalog);
    case 'copy-grok-usage':
      return catalog.copyUsageCommand;
    case 'open-grok-install-guide':
      return localizedProviderLinkLabel('grok-install', catalog);
    case 'enable-claude':
      return catalog.tryAutomaticClaudeUsage;
    case 'disable-claude':
      return catalog.disableIntegration;
    case 'repair-claude':
      return catalog.repairIntegration;
    case 'recheck-claude':
      return catalog.recheckIntegration;
    case 'recheck-grok':
      return catalog.recheckInstallation;
    case 'enable-claude-oauth':
      return `${catalog.enabled} ${catalog.cliFreeUsage}`;
    case 'disable-claude-oauth':
      return `${catalog.disabledAction} ${catalog.cliFreeUsage}`;
    case 'open-claude-code':
      return `${catalog.openDashboard}: Claude Code`;
    case 'copy-claude-usage':
      return catalog.copyUsageCommand;
    case 'open-claude-oauth-docs':
      return catalog.note;
    case 'enable-copilot-experimental':
    case 'enable-grok-experimental':
      return `${catalog.enabled} ${catalog.experimental.toLowerCase()} usage`;
    case 'disable-copilot-experimental':
    case 'disable-grok-experimental':
      return `${catalog.disabledAction} ${catalog.experimental.toLowerCase()} usage`;
    case 'connect-copilot':
      return `${catalog.connect} GitHub Copilot`;
    case 'disconnect-copilot':
      return `${catalog.disconnect} GitHub Copilot`;
    case 'configure-copilot-plan':
      return catalog.configurePlan;
    case 'enable-grok':
      return `${catalog.enableIntegration}: Grok`;
    case 'disable-grok':
      return `${catalog.disableIntegration}: Grok`;
    case 'launch-grok-login':
      return `${catalog.connect} Grok`;
    case 'launch-claude-terminal':
      return `${catalog.openDashboard}: Claude Terminal`;
    case 'enable-claude-auto-repair':
      return `${catalog.enabled} ${catalog.automaticRepair}`;
    case 'disable-claude-auto-repair':
      return `${catalog.disabledAction} ${catalog.automaticRepair}`;
    case 'copy-claude-diagnostics':
      return catalog.copyDiagnostics;
    default:
      return fallback;
  }
}

function localizedActionWorkingLabel(actionId: DashboardActionId, catalog: UiTextCatalog): string {
  const definition = getDashboardActionDefinition(actionId);
  if (!definition) return catalog.working;
  if (definition.kind === 'refresh')
    return actionId === 'refresh-all'
      ? catalog.refreshing
      : `${catalog.refreshing} ${actionId.split('-')[1] ?? ''}`.trim();
  if (definition.kind === 'clipboard') return catalog.copying;
  if (definition.kind === 'export') return catalog.exporting;
  if (definition.kind === 'diagnostic') return catalog.checking;
  if (definition.kind === 'mutation') return catalog.enabling;
  return catalog.opening;
}

function localizeActionMessage(message: string, catalog: UiTextCatalog): string {
  const values: Readonly<Record<string, string>> = {
    Updated: catalog.updated,
    Opened: catalog.opened,
    Copied: catalog.copied,
    Exported: catalog.exported,
    Saved: catalog.saved,
    Enabled: catalog.enabled,
    Disabled: catalog.disabledAction,
    Connected: catalog.connectedAction,
    Disconnected: catalog.disconnectedAction,
    Checked: catalog.checked,
    Cancelled: catalog.cancelled,
    Failed: catalog.failed,
    'Try again later': catalog.tryAgainLater,
    'Security validation failed.': catalog.securityValidationFailed,
  };
  return values[message] ?? message;
}

function stateIconId(state: DashboardActionState['state']): DashboardIconId | undefined {
  switch (state) {
    case 'success':
      return 'check';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'info';
    case 'throttled':
      return 'warning';
    default:
      return undefined;
  }
}

const USAGE_INSIGHTS_STYLES =
  '.usage-insights{margin-top:14px}.usage-insights h4{margin:0 0 8px}.usage-insights-table{width:100%;border-collapse:collapse;font-size:.88em}.usage-insights-table th,.usage-insights-table td{padding:6px 8px;border:1px solid var(--vscode-panel-border);text-align:left;vertical-align:middle}.usage-insights-table th{color:var(--vscode-descriptionForeground);font-weight:600}.usage-insights-table__trend{display:flex;align-items:center;gap:8px}.usage-insights-table__bar{display:inline-block;flex:1;min-width:28px;height:6px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--vscode-panel-border) 70%,transparent)}.usage-insights-table__bar i{display:block;height:100%;min-width:2px;border-radius:inherit;background:var(--vscode-progressBar-background)}';

function dashboardStyles(): string {
  return `:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:clamp(16px,4vw,40px);font:var(--vscode-font-weight) var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}button,summary{font:inherit}.dashboard-shell{width:min(100%,1180px);margin:0 auto}.dashboard-header{display:grid;gap:18px;padding-bottom:28px;border-bottom:1px solid var(--vscode-panel-border)}.brand-row{display:flex;align-items:center;gap:16px;min-width:0}.brand-mark{width:48px;height:48px;flex:0 0 48px;object-fit:contain;border-radius:10px}.brand-copy{min-width:0}.eyebrow{margin:0 0 5px;color:var(--vscode-descriptionForeground);font-size:.72em;font-weight:600;letter-spacing:.12em}.brand-copy h1{margin:0;font-size:clamp(1.45rem,4vw,2rem);line-height:1.15}.tagline{margin:7px 0 0;color:var(--vscode-descriptionForeground);max-width:62ch}.header-meta{display:flex;align-items:center;gap:18px;flex-wrap:wrap;color:var(--vscode-descriptionForeground)}.header-meta div{display:grid;gap:3px}.header-meta strong{color:var(--vscode-editor-foreground);font-size:1.05em}.header-status{display:inline-flex;align-items:center;gap:7px}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--vscode-testing-iconPassed);outline:1px solid var(--vscode-panel-border)}.global-actions,.action-toolbar,.action-toolbar__primary,.action-toolbar__secondary,.more-actions__menu{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.global-actions{align-items:flex-start}.provider-group{margin-top:30px}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:12px}.section-heading h2{margin:0;font-size:1.15rem}.section-count{color:var(--vscode-descriptionForeground);font-size:.85em}.provider-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px}.provider-card,.setup-card{display:flex;flex-direction:column;min-width:0;padding:18px;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-sideBar-background);box-shadow:0 1px 1px color-mix(in srgb,var(--vscode-editor-foreground) 8%,transparent)}.provider-card:focus-within,.setup-card:focus-within{border-color:var(--vscode-focusBorder)}.card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}.provider-title{display:flex;align-items:center;gap:8px;min-width:0}.provider-title h3{margin:0;min-width:0;font-size:1.05rem;overflow-wrap:anywhere}.severity-indicator{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:var(--vscode-testing-iconPassed)}.severity-indicator--warning{background:var(--vscode-editorWarning-foreground)}.severity-indicator--error{background:var(--vscode-editorError-foreground)}.badge-row{display:flex;justify-content:flex-end;gap:5px;flex-wrap:wrap}.badge{display:inline-flex;align-items:center;max-width:100%;padding:3px 7px;border:1px solid var(--vscode-widget-border);border-radius:999px;color:var(--vscode-editor-foreground);font-size:.75em;line-height:1.2;overflow-wrap:anywhere}.badge--source{color:var(--vscode-descriptionForeground)}.badge--experimental{border-color:var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground)}.badge--warning{border-color:var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground)}.badge--error{border-color:var(--vscode-editorError-foreground);color:var(--vscode-editorError-foreground)}.card-summary{display:grid;gap:7px;margin:18px 0 14px}.primary-usage{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}.primary-usage__value{font-size:clamp(1.65rem,5vw,2.1rem);font-weight:700;letter-spacing:-.03em}.primary-usage__label{color:var(--vscode-descriptionForeground)}.usage-window-list{display:grid;gap:12px;margin:0}.usage-window{display:grid;gap:7px;min-width:0}.usage-window__header,.usage-window__meta{display:flex;justify-content:space-between;align-items:baseline;gap:10px;min-width:0}.usage-window__header strong{overflow-wrap:anywhere}.usage-window__meta{color:var(--vscode-descriptionForeground);font-size:.84em;flex-wrap:wrap}.usage-progress{height:9px;min-width:40px;overflow:hidden;border:1px solid var(--vscode-panel-border);border-radius:999px;background:var(--vscode-progressBar-background);background-color:color-mix(in srgb,var(--vscode-panel-border) 65%,transparent)}.usage-progress__fill{height:100%;min-width:0;background:var(--vscode-testing-iconPassed);border-radius:inherit}.usage-progress--warning .usage-progress__fill{background:var(--vscode-editorWarning-foreground)}.usage-progress--critical .usage-progress__fill{background:var(--vscode-editorError-foreground)}.usage-progress__text{font-size:.9em}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr));gap:8px}.metric-tile{min-width:0;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:6px}.metric-tile dt{color:var(--vscode-descriptionForeground);font-size:.78em}.metric-tile dd{margin:4px 0 0;font-size:1.05em;font-weight:600;overflow-wrap:anywhere}.card-note,.state,.muted{color:var(--vscode-descriptionForeground)}.card-note{margin:0;font-size:.9em}.freshness-summary{display:flex;gap:8px;flex-wrap:wrap;color:var(--vscode-descriptionForeground);font-size:.83em}.freshness-summary strong{color:var(--vscode-editor-foreground)}.backoff-notice,.global-alert{margin:0;padding:9px 11px;border-left:3px solid var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground);background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 10%,transparent)}.global-alert{border-left-color:var(--vscode-editorError-foreground);color:var(--vscode-editorError-foreground)}.action-toolbar{margin-top:auto;padding-top:16px;align-items:flex-start}.action-toolbar__primary,.action-toolbar__secondary{align-items:flex-start}.action-button{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:30px;max-width:100%;padding:6px 10px;border:1px solid transparent;border-radius:4px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);transition:background-color .12s ease,border-color .12s ease,opacity .12s ease}.action-button:hover{background:var(--vscode-button-hoverBackground)}.action-button:active{transform:translateY(1px)}.action-button:focus-visible,.more-actions summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.action-button[data-action-role="secondary"],.action-button[data-action-role="menu"]{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border-color:var(--vscode-panel-border)}.action-button:disabled{color:var(--vscode-disabledForeground);background:var(--vscode-button-secondaryBackground);cursor:wait;opacity:.8}.action-button--success{border-color:var(--vscode-testing-iconPassed)}.action-button--error{border-color:var(--vscode-editorError-foreground);color:var(--vscode-editorError-foreground)}.action-button--throttled{border-color:var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground)}.action-button__spinner{width:12px;height:12px;flex:0 0 12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;visibility:hidden}.action-button[aria-busy="true"] .action-button__spinner{visibility:visible;animation:dashboard-spin .8s linear infinite}.action-button__icon{width:1em;text-align:center}.action-button__label{min-width:0;overflow-wrap:anywhere}.more-actions{position:relative}.more-actions summary{display:inline-flex;align-items:center;min-height:30px;padding:6px 10px;border:1px solid var(--vscode-panel-border);border-radius:4px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);cursor:pointer;list-style:none}.more-actions summary::-webkit-details-marker{display:none}.more-actions summary::after{content:'⌄';margin-left:7px}.more-actions__menu{margin-top:7px;padding:8px;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-editor-background);z-index:2}.details-panel{margin-top:14px;border-top:1px solid var(--vscode-panel-border)}.details-panel summary{padding:11px 0;color:var(--vscode-textLink-foreground);cursor:pointer}.details-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px 16px;padding-bottom:4px}.detail-item{min-width:0}.detail-item dt{color:var(--vscode-descriptionForeground);font-size:.78em}.detail-item dd{margin:2px 0 0;overflow-wrap:anywhere}.empty-state{padding:22px;border:1px dashed var(--vscode-panel-border);border-radius:8px;color:var(--vscode-descriptionForeground)}.setup-card{padding:15px}.setup-card h3{margin:0}.setup-card p{margin:8px 0}.setup-requirement{color:var(--vscode-descriptionForeground);font-size:.9em}.dashboard-footer{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:34px;padding-top:16px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:.82em}.action-feedback{min-height:1.4em;margin:0;color:var(--vscode-descriptionForeground)}.action-feedback__controls{display:inline-flex;gap:6px;margin-left:8px}.action-feedback__controls button{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-panel-border);padding:3px 7px;border-radius:3px;cursor:pointer}.compare{width:100%;border-collapse:collapse;margin-top:10px;font-size:.9em}.compare th,.compare td{padding:6px 8px;border:1px solid var(--vscode-panel-border);text-align:left}.compare th{color:var(--vscode-descriptionForeground);font-weight:600}@keyframes dashboard-spin{to{transform:rotate(360deg)}}@media(max-width:680px){body{padding:16px}.card-header,.primary-usage{align-items:flex-start}.badge-row{justify-content:flex-start}.dashboard-footer{display:grid}.action-toolbar__primary,.action-toolbar__secondary{width:100%}.action-toolbar .action-button{flex:1 1 auto}}@media(prefers-reduced-motion:reduce){.action-button{transition:none}.action-button[aria-busy="true"] .action-button__spinner{animation:none;border-right-color:currentColor;opacity:.6}}@media(forced-colors:active){.provider-card,.setup-card,.usage-progress,.more-actions summary,.more-actions__menu{border:1px solid ButtonText}.usage-progress__fill{background:Highlight}.badge{border-color:ButtonText}.severity-indicator{background:ButtonText}}`;
}

function dashboardStylesWithInsights(): string {
  return `${USAGE_INSIGHTS_STYLES}${dashboardStyles()}`;
}

function actionButton(
  actionId: DashboardActionId,
  label: string,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
  role: 'primary' | 'secondary' | 'menu' = 'secondary',
): string {
  if (!isRegisteredDashboardAction(actionId)) return '';
  const definition = getDashboardActionDefinition(actionId);
  if (!definition) return '';
  const actionState = states.get(actionId);
  const state = actionState?.state ?? 'idle';
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const localizedLabel = localizedActionLabel(actionId, label, catalog);
  const busy = state === 'submitting' || state === 'working';
  const displayLabel =
    state === 'working' || state === 'submitting'
      ? localizedActionWorkingLabel(actionId, catalog)
      : state === 'success' || state === 'error' || state === 'cancelled' || state === 'throttled'
        ? localizeActionMessage(actionState?.message ?? localizedLabel, catalog)
        : localizedLabel;
  const leadingIcon = renderDashboardIcon(getDashboardActionIconId(actionId));
  const resultIconId = stateIconId(state);
  const resultIconMarkup = (['success', 'error', 'cancelled', 'throttled'] as const)
    .map(
      (resultState) =>
        `<span class="action-button__state-icon-item" data-state-icon="${resultState}"${resultIconId !== resultState ? ' hidden' : ''}>${renderDashboardIcon(stateIconId(resultState) as DashboardIconId)}</span>`,
    )
    .join('');
  return `<button type="button" class="action-button action-button--${state}" data-action-id="${actionId}" data-action-role="${role}" data-action-state="${state}" data-action-icon="${getDashboardActionIconId(actionId)}"${actionState?.requestId ? ` data-request-id="${escapeHtml(actionState.requestId)}"` : ''}${actionState?.correlationId ? ` data-correlation-id="${escapeHtml(actionState.correlationId)}"` : ''} data-retryable="${actionState?.retryable === true ? 'true' : 'false'}" data-default-label="${escapeHtml(localizedLabel)}" aria-describedby="dashboard-action-status" aria-busy="${busy ? 'true' : 'false'}"${busy ? ' disabled' : ''}><span class="action-button__leading-icon" aria-hidden="true"${busy || resultIconId ? ' hidden' : ''}>${leadingIcon}</span><span class="action-button__spinner" aria-hidden="true"${busy ? '' : ' hidden'}></span><span class="action-button__state-icon" aria-hidden="true"${busy || !resultIconId ? ' hidden' : ''}>${resultIconMarkup}</span><span class="action-button__label">${escapeHtml(displayLabel)}</span></button>`;
}

function dashboardScript(catalog: UiTextCatalog = getUiTextCatalog()): string {
  const strings = {
    starting: `${catalog.starting}`,
    stillWaiting: `${catalog.stillWaiting}`,
    working: `${catalog.working}…`,
    retry: catalog.retry,
    showLogs: catalog.showLogs,
    failed: catalog.failed,
    dashboardNoResponse: catalog.dashboardNoResponse,
  };
  return `const strings=${JSON.stringify(strings)};const vscode=acquireVsCodeApi();
try{vscode.postMessage({type:'dashboard.ready',clientVersion:1});}catch{}
const current=new Map();
const waitTimers=new Map();
const responseTimers=new Map();
let requestCounter=0;
const statusNode=document.getElementById('dashboard-action-status');
const validActionId=(value)=>typeof value==='string'&&/^[a-z0-9-]+$/.test(value);
const validRequestId=(value)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const actionButtons=(actionId)=>Array.from(document.querySelectorAll('button[data-action-id]')).filter((button)=>button.dataset.actionId===actionId);
const clearTimer=(map,actionId)=>{const timer=map.get(actionId);if(timer!==undefined){clearTimeout(timer);map.delete(actionId);}};
 const setButtons=(actionId,state,message)=>{actionButtons(actionId).forEach((button)=>{const label=button.querySelector('.action-button__label');const leadingIcon=button.querySelector('.action-button__leading-icon');const spinner=button.querySelector('.action-button__spinner');const stateIcon=button.querySelector('.action-button__state-icon');const stateIconItems=button.querySelectorAll('.action-button__state-icon-item');const busy=state==='submitting'||state==='working';const resultState=['success','error','cancelled','throttled'].includes(state);button.className='action-button action-button--'+state;button.dataset.actionState=state;button.disabled=busy;button.setAttribute('aria-busy',busy?'true':'false');if(label)label.textContent=message||button.dataset.defaultLabel||'';if(leadingIcon)leadingIcon.hidden=busy||resultState;if(spinner)spinner.hidden=!busy;if(stateIcon){stateIcon.hidden=busy||!resultState;stateIconItems.forEach((item)=>{item.hidden=item.dataset.stateIcon!==state;});}});};
 const post=(actionId)=>{if(!validActionId(actionId)||current.has(actionId))return;requestCounter+=1;const requestId='dashboard-'+Date.now().toString(36)+'-'+requestCounter.toString(36);current.set(actionId,{requestId,state:'submitting',retryable:true});clearTimer(waitTimers,actionId);clearTimer(responseTimers,actionId);setButtons(actionId,'submitting',strings.starting);try{vscode.postMessage({type:'dashboard.action.request',requestId,actionId});}catch{setResult(actionId,requestId,'error',strings.dashboardNoResponse,true);}waitTimers.set(actionId,setTimeout(()=>{if(current.get(actionId)?.requestId===requestId&&current.get(actionId)?.state==='submitting'){setButtons(actionId,'submitting',strings.stillWaiting);}},2000));responseTimers.set(actionId,setTimeout(()=>{if(current.get(actionId)?.requestId===requestId){setResult(actionId,requestId,'error',strings.dashboardNoResponse,true);}},15000));};
 const setResult=(actionId,requestId,state,message,retryable)=>{const item=current.get(actionId);if(!item||item.requestId!==requestId)return;clearTimer(waitTimers,actionId);clearTimer(responseTimers,actionId);item.state=state;item.retryable=retryable;setButtons(actionId,state,message);if(statusNode){statusNode.textContent=message;const controls=document.createElement('span');controls.className='action-feedback__controls';if((state==='error'||state==='throttled')&&retryable){const retry=document.createElement('button');retry.type='button';retry.textContent=strings.retry;retry.addEventListener('click',()=>{current.delete(actionId);post(actionId);});controls.appendChild(retry);}if(state==='error'){const logs=document.createElement('button');logs.type='button';logs.textContent=strings.showLogs;logs.addEventListener('click',()=>post('show-logs'));controls.appendChild(logs);}statusNode.appendChild(controls);}if(state==='success'||state==='cancelled'){setTimeout(()=>{if(current.get(actionId)?.requestId===requestId){current.delete(actionId);setButtons(actionId,'idle','');if(statusNode)statusNode.textContent='';}},2000);}};
document.querySelectorAll('button[data-action-id]').forEach((button)=>{const actionId=button.dataset.actionId;const state=button.dataset.actionState;const requestId=button.dataset.requestId;if(validActionId(actionId)&&validRequestId(requestId)&&state&&state!=='idle'){current.set(actionId,{requestId,state,retryable:button.dataset.retryable==='true'});if(state==='success'||state==='cancelled')setTimeout(()=>{if(current.get(actionId)?.requestId===requestId){current.delete(actionId);setButtons(actionId,'idle','');}},2000);}});
document.querySelectorAll('button[data-action-id]').forEach((button)=>button.addEventListener('click',()=>post(button.dataset.actionId)));
 window.addEventListener('message',(event)=>{const message=event.data;if(!message||typeof message!=='object'||typeof message.type!=='string'||!validActionId(message.actionId)||!validRequestId(message.requestId))return;const item=current.get(message.actionId);if(!item||item.requestId!==message.requestId)return;if(message.type==='dashboard.action.accepted'){clearTimer(waitTimers,message.actionId);item.state='working';setButtons(message.actionId,'working',strings.working);return;}if(message.type==='dashboard.action.result'&&['success','error','cancelled','throttled'].includes(message.status)){setResult(message.actionId,message.requestId,message.status,typeof message.message==='string'?message.message:strings.failed,message.retryable===true);}});`;
}

const RECHECK_STATES = new Set([
  'restart-required',
  'configuration-shadowed',
  'external-change',
  'incompatible-cli',
  'waiting-for-first-response',
  'upstream-statusline-not-invoked',
  'unsupported-surface',
]);

/** States where AI Limit Ledger has confirmed something is wrong and offers the install-guide / terminal / copy-diagnostics actions, not just Recheck. */
const TROUBLESHOOT_STATES = new Set([
  'unavailable',
  'incompatible-cli',
  'upstream-statusline-not-invoked',
  'unsupported-surface',
]);

/** "Last check" is always meaningful; "Last successful data update" only when real data was parsed. */
/* eslint-disable @typescript-eslint/no-unused-vars */
function timestampLines(
  checkedAt: number | undefined,
  observedAt: number,
  hasRealData: boolean,
): string {
  const lastCheck = `<b>Last check:</b> ${escapeHtml(new Date(checkedAt ?? observedAt).toLocaleString())}`;
  const lastUpdate = hasRealData
    ? `<br><b>Last successful data update:</b> ${escapeHtml(new Date(observedAt).toLocaleString())}`
    : '';
  return `${lastCheck}${lastUpdate}`;
}

/**
 * "Last provider event", "Next fallback refresh", and "Snapshot age" — kept distinct from "Last
 * check"/"Last successful data update" so a stale-but-preserved snapshot never silently reads as
 * fresh. Missing fields render "Not provided"/"Not applicable" rather than being omitted, so a
 * 10-minute-old "100% left" is never presented without its age.
 */
function freshnessLines(snapshot: ProviderSnapshot, hasRealData: boolean): string {
  const lastEvent =
    snapshot.lastProviderEventAt != null
      ? escapeHtml(new Date(snapshot.lastProviderEventAt).toLocaleString())
      : 'Not provided';
  const nextFallback =
    snapshot.nextFallbackRefreshAt != null
      ? escapeHtml(new Date(snapshot.nextFallbackRefreshAt).toLocaleString())
      : 'Not applicable';
  const age = hasRealData ? escapeHtml(elapsedDuration(snapshot.observedAt)) : 'Not applicable';
  return `<br><b>Last provider event:</b> ${lastEvent}<br><b>Next fallback refresh:</b> ${nextFallback}<br><b>Snapshot age:</b> ${age}`;
}

function renderProviderCard(
  snapshot: ProviderSnapshot | undefined,
  id: string,
  presentation?: ProviderPresentationState,
  states: ReadonlyMap<DashboardActionId, DashboardActionState> = new Map(),
): string {
  const name =
    id === 'claude'
      ? 'Claude Code'
      : id === 'copilot'
        ? 'GitHub Copilot'
        : id === 'grok'
          ? 'Grok'
          : 'Codex';
  if (!snapshot)
    return `<section class="card"><h2>${name}</h2><p class="state">Provider is not selected or has not started.</p>${actionButton('open-provider-settings', 'Select Provider', states)}</section>`;
  const resolvedPresentation =
    presentation ?? resolveProviderPresentation({ snapshot, now: Date.now() });
  const displaySnapshot =
    resolvedPresentation.reasonCode === 'initialization-timeout'
      ? {
          ...snapshot,
          availability: 'startup-error' as const,
          warning: 'Provider initialization timed out. Refresh or open diagnostics.',
        }
      : snapshot;
  if (displaySnapshot.availability === 'not-selected')
    return `<section class="card"><h2>${name}</h2><p class="state">Not selected</p><p>${escapeHtml(displaySnapshot.warning ?? 'Select this provider in settings to start it.')}</p>${actionButton('open-provider-settings', 'Select Provider', states)}</section>`;
  if (id === 'claude') return renderClaudeCard(displaySnapshot, states);
  if (id === 'copilot') return renderCopilotCard(displaySnapshot, states);
  if (id === 'grok') return renderGrokCard(displaySnapshot, states);
  const windows =
    snapshot.usageWindows
      .map(
        (window) =>
          `<tr><td>${escapeHtml(window.label)}</td><td>${formatPercent(window.remainingPercent)}% left</td><td>${window.resetsAt ? escapeHtml(new Date(window.resetsAt * 1000).toLocaleString()) : 'Not provided'}</td></tr>`,
      )
      .join('') || '<tr><td colspan="3">No usage data yet.</td></tr>';
  const hasRealData = snapshot.usageWindows.length > 0;
  return `<section class="card"><h2>${name}</h2><p class="state">${escapeHtml(snapshot.availability)}${snapshot.warning ? ` — ${escapeHtml(snapshot.warning)}` : ''}</p><p><b>Plan:</b> ${escapeHtml(snapshot.plan ?? 'Not available')}<br><b>CLI:</b> ${escapeHtml(snapshot.cliVersion ?? 'Not available')}<br>${timestampLines(snapshot.checkedAt, snapshot.observedAt, hasRealData)}${freshnessLines(snapshot, hasRealData)}<br><b>Source:</b> ${escapeHtml(snapshot.source)}</p><table><tbody>${windows}</tbody></table>${actionButton('refresh-codex', 'Refresh Codex Usage', states)}${actionButton('restart-codex-app-server', 'Restart App Server', states)}${actionButton('diagnose-codex', 'Diagnose Codex Integration', states)}${actionButton('open-codex-usage', providerLinkLabel('codex-usage'), states)}</section>`;
}

function renderCopilotCard(
  snapshot: ProviderSnapshot,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  const credits = snapshot.credits;
  const meta = snapshot.metadata ?? {};
  const window = snapshot.usageWindows[0];
  const used = credits?.used ?? null;
  const allowance = credits?.allowance ?? null;
  const remaining = credits?.remaining ?? null;
  const percent = window?.remainingPercent;
  const rows = window
    ? `<tr><td>Monthly AI Credits</td><td>${formatNumber(used)} / ${formatNumber(allowance)} used</td><td>${formatNumber(remaining)} — ${formatPercent(percent ?? 0)}% left</td><td>${escapeHtml(resetCell(window.resetsAt))}</td></tr>`
    : used === null
      ? `<tr><td colspan="4">No usage data yet.</td></tr>`
      : `<tr><td colspan="4">AI credits reported by endpoint: ${formatNumber(used)} — Monthly allowance not configured</td></tr>`;
  const state = snapshot.availability === 'ready-calculated' ? 'ready' : snapshot.availability;
  const extension = snapshot.extensionVersion ?? meta.extensionVersion;
  const buttons: string[] = [
    actionButton('refresh-copilot', 'Refresh GitHub Copilot Usage', states),
    actionButton('configure-copilot-plan', 'Configure Copilot Plan', states),
    actionButton('open-copilot-usage', providerLinkLabel('copilot-billing'), states),
    actionButton('diagnose-copilot', 'Diagnose GitHub Copilot Integration', states),
  ];
  if (snapshot.availability === 'authentication-required') {
    buttons.unshift(actionButton('connect-copilot', 'Connect GitHub Copilot Usage', states));
  } else if (
    snapshot.availability !== 'organization-managed' &&
    snapshot.availability !== 'ready-experimental'
  ) {
    buttons.push(actionButton('disconnect-copilot', 'Disconnect GitHub Copilot Usage', states));
  }
  const experimentalActive = meta.billingEndpoint === 'experimental-entitlement';
  if (snapshot.availability === 'organization-managed' || experimentalActive) {
    buttons.push(actionButton('open-copilot-usage', providerLinkLabel('copilot-billing'), states));
    buttons.push(
      experimentalActive
        ? actionButton('disable-copilot-experimental', 'Disable Experimental Copilot Usage', states)
        : actionButton('enable-copilot-experimental', 'Enable Experimental Copilot Usage', states),
    );
  }
  const bucketCell = (value: unknown): string =>
    typeof value === 'number' ? formatNumber(value) : 'Not provided';
  const experimentalLines = experimentalActive
    ? `<br><b>Account management:</b> ${escapeHtml(String(meta.accountManagement ?? 'unknown'))}` +
      `<br><b>Endpoint plan:</b> ${escapeHtml(String(meta.endpointPlan ?? 'Not provided'))}` +
      `<br><b>Configured billing scope:</b> ${escapeHtml(String(meta.configuredBillingScope ?? 'auto'))}` +
      `<br><b>Individual allowance:</b> Not provided — organization managed` +
      `<br><b>Token-based billing:</b> ${meta.tokenBasedBilling === null || meta.tokenBasedBilling === undefined ? 'Not provided' : meta.tokenBasedBilling ? 'Yes' : 'No'}` +
      `<br><b>Reset:</b> ${fmtTimeOrNotAvailable(meta.quotaResetAt)}` +
      `<br><b>AI credits:</b> ${bucketCell(meta.premiumInteractionsCreditsUsed)}` +
      `<br><b>Premium interactions:</b> ${bucketCell(meta.premiumInteractionsCreditsUsed)}` +
      `<br><b>Chat quota:</b> ${bucketCell(meta.chatCreditsUsed)}` +
      `<br><b>Completions quota:</b> ${bucketCell(meta.completionsCreditsUsed)}`
    : '';
  return `<section class="card"><h2>GitHub Copilot</h2><p class="state">${escapeHtml(state)}${snapshot.warning ? ` — ${escapeHtml(snapshot.warning)}` : ''}</p><table><tbody>${rows}</tbody></table><p><b>Included/discounted quantity:</b> ${formatNumber(credits?.included ?? null)}<br><b>Additional/billable quantity:</b> ${formatNumber(credits?.additional ?? null)}<br><b>Cost:</b> ${credits?.cost === null || credits?.cost === undefined ? 'Not provided' : `$${credits.cost.toFixed(2)}`}<br><b>Current period:</b> ${escapeHtml(String(meta.currentPeriod ?? 'Not provided'))}<br><b>CLI:</b> ${escapeHtml(snapshot.cliVersion ?? (meta.cliInstalled ? 'Detected' : 'Not installed'))}<br><b>Extension:</b> ${escapeHtml(extension ? String(extension) : meta.extensionInstalled ? 'Detected' : 'Not detected')}${experimentalLines}<br>${timestampLines(snapshot.checkedAt, snapshot.observedAt, used !== null)}${freshnessLines(snapshot, used !== null)}<br><b>Next refresh:</b> ${fmtTimeOrNotAvailable(meta.nextRefreshAt)}<br><b>Backoff:</b> ${fmtTimeOrNotAvailable(snapshot.retryAt)}<br><b>Source:</b> ${escapeHtml(snapshot.source)}<br><b>Provenance:</b> ${escapeHtml(snapshot.provenance ?? 'Not provided')}</p><p class="muted">${escapeHtml(String(meta.billingDelayNotice ?? 'GitHub billing data may not update immediately after each Copilot request.'))}</p><p class="muted"><b>Model breakdown:</b> ${escapeHtml(String(meta.modelBreakdown ?? 'Not provided'))}</p>${buttons.join('')}</section>`;
}

function renderGrokCard(
  snapshot: ProviderSnapshot,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  const meta = snapshot.metadata ?? {};
  const rows =
    snapshot.usageWindows
      .map(
        (window) =>
          `<tr><td>${escapeHtml(window.label)}</td><td>${formatPercent(window.usedPercent)}% used</td><td>${formatPercent(window.remainingPercent)}% left</td><td>${escapeHtml(resetCell(window.resetsAt))}</td></tr>`,
      )
      .join('') || '<tr><td colspan="4">Weekly usage percentage: Not provided</td></tr>';
  const buttons: string[] = [
    actionButton('open-grok-usage', providerLinkLabel('grok-billing'), states),
    actionButton('copy-grok-usage', localization.t('copyUsageCommand'), states),
    actionButton('diagnose-grok', 'Diagnose Grok Integration', states),
  ];
  if (snapshot.availability === 'disabled')
    buttons.unshift(actionButton('enable-grok', 'Enable Grok Usage', states));
  else
    buttons.unshift(
      actionButton('disable-grok', 'Disable Grok Usage', states),
      actionButton('refresh-grok', 'Refresh Grok Usage', states),
    );
  if (snapshot.availability === 'cli-not-installed') {
    buttons.unshift(
      actionButton('open-grok-install-guide', providerLinkLabel('grok-install'), states),
      actionButton('recheck-grok', 'Recheck Grok Installation', states),
    );
  }
  if (snapshot.availability === 'authentication-required')
    buttons.unshift(
      actionButton('launch-grok-login', 'Launch Grok Login in VS Code Terminal', states),
    );
  const acpFallbackActive = meta.acpBillingCapability === 'unavailable-safe-fallback-active';
  if (snapshot.availability === 'method-not-supported' || acpFallbackActive) {
    buttons.push(
      acpFallbackActive
        ? actionButton('disable-grok-experimental', 'Disable Experimental Grok Usage', states)
        : actionButton('enable-grok-experimental', 'Enable Experimental Grok Usage', states),
    );
  }
  const fallbackStatus = meta.experimentalFallbackStatus;
  const acpCapabilityLine = acpFallbackActive
    ? '<br><b>ACP billing capability:</b> Not available in this CLI version; safe fallback active'
    : typeof fallbackStatus === 'string' && fallbackStatus !== 'not-opted-in'
      ? `<br><b>Experimental fallback status:</b> ${escapeHtml(fallbackStatus)}`
      : '';
  const community = meta.extensionInstalled
    ? `${String(meta.extensionId ?? 'Community extension')} ${String(meta.extensionVersion ?? '')}`
    : 'Not detected';
  const grokUsageInstruction =
    getProviderInstallGuidance('grok').cliUsageInstruction ??
    'Use /usage inside Grok Build for the official account view.';
  return `<section class="card"><h2>Grok</h2><p class="state">${escapeHtml(snapshot.availability)}${snapshot.warning ? ` — ${escapeHtml(snapshot.warning)}` : ''}</p><table><tbody>${rows}</tbody></table><p><b>Plan:</b> ${escapeHtml(snapshot.plan ?? 'Not provided')}<br><b>Community Grok extension:</b> ${escapeHtml(community)}<br><b>Official Grok Build CLI:</b> ${snapshot.cliVersion ? escapeHtml(snapshot.cliVersion) : 'Not installed'}<br><b>Automatic weekly usage:</b> ${snapshot.cliVersion ? 'Available after CLI login and billing capability' : 'Requires official Grok Build CLI'}${acpCapabilityLine}<br><b>Product breakdown:</b> ${escapeHtml(String(meta.productBreakdown ?? 'Not provided'))}<br><b>Build usage:</b> ${formatNumber(typeof meta.buildUsage === 'number' ? meta.buildUsage : null)}<br><b>Extra credit balance:</b> ${formatNumber(typeof meta.extraCreditBalance === 'number' ? meta.extraCreditBalance : null)}<br>${timestampLines(snapshot.checkedAt, snapshot.observedAt, snapshot.usageWindows.length > 0)}${freshnessLines(snapshot, snapshot.usageWindows.length > 0)}<br><b>Next refresh:</b> ${fmtTimeOrNotAvailable(meta.nextRefreshAt)}<br><b>Backoff:</b> ${fmtTimeOrNotAvailable(snapshot.retryAt)}<br><b>Source:</b> ${escapeHtml(snapshot.source)}<br><b>Provenance:</b> ${escapeHtml(snapshot.provenance ?? 'Not provided')}</p><p class="muted">Experimental — Grok Build billing extension. ${escapeHtml(grokUsageInstruction)}</p>${buttons.join('')}</section>`;
}

function resetCell(resetsAt: number | null): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  if (!isFiniteNumber(resetsAt) || resetsAt <= 0) return catalog.notProvided;
  const timestamp = new Date(resetsAt * 1000);
  if (!Number.isFinite(timestamp.getTime())) return catalog.notProvided;
  return formatConfiguredTime(
    timestamp.getTime(),
    Date.now(),
    dashboardRenderSettings.timeFormat ?? 'both',
    catalog,
    'deadline',
  );
}

const ACCESS_MODE_LABELS: Record<string, string> = {
  'vscode-extension': 'VS Code extension',
  'standalone-cli': 'Standalone CLI',
  hybrid: 'VS Code extension + CLI',
  unavailable: 'Not detected',
};

const CAPABILITY_COMPARISON_TABLE = `<table class="compare"><thead><tr><th>Feature</th><th>VS Code extension mode</th><th>CLI-enhanced mode</th></tr></thead><tbody>
<tr><td>Use Claude in VS Code</td><td>Yes</td><td>Yes</td></tr>
<tr><td>Code editing and agent work</td><td>Yes</td><td>Yes</td></tr>
<tr><td>Open Claude panel</td><td>Yes</td><td>Yes</td></tr>
<tr><td>Manual /usage</td><td>Yes</td><td>Yes</td></tr>
<tr><td>Automatic limit tracking</td><td>Host-dependent</td><td>Optional — coming in a later AI Limit Ledger update</td></tr>
<tr><td>CLI installation required</td><td>No</td><td>Yes</td></tr>
<tr><td>Terminal-based sessions</td><td>No</td><td>Yes</td></tr>
</tbody></table>`;

/** CLI absence is only "proven" when host detection actually ran and found the extension but no CLI. */
function cliLine(snapshot: ProviderSnapshot): string {
  const accessMode = snapshot.metadata?.accessMode;
  if (accessMode === 'standalone-cli' || accessMode === 'hybrid') {
    return `<b>Claude Code CLI:</b> ${escapeHtml(snapshot.cliVersion ?? 'Detected')}`;
  }
  if (accessMode === 'vscode-extension') {
    return `<b>Claude Code CLI:</b> Not installed — optional`;
  }
  return `<b>Claude Code CLI:</b> Not provided`;
}

const CLAUDE_WINDOW_TITLES: Record<string, string> = {
  'five-hour': 'Account limit — 5-hour window',
  'seven-day': 'Account limit — 7-day window',
};

const CLAUDE_METRIC_DISCLAIMER_EN =
  'Session context usage and account rate-limit usage are separate metrics and may show different percentages.';
const CLAUDE_METRIC_DISCLAIMER_TR =
  'Oturum bağlam kullanımı ile hesap kullanım limiti farklı ölçümlerdir; yüzdeleri aynı olmak zorunda değildir.';

const EXPERIMENTAL_STATES = new Set([
  'ready-experimental',
  'stale-experimental',
  'rate-limited-experimental',
  'authentication-required',
  'consent-required',
]);

function renderClaudeCard(
  snapshot: ProviderSnapshot,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  if (EXPERIMENTAL_STATES.has(snapshot.availability))
    return renderClaudeExperimentalCard(snapshot, states);
  if (snapshot.availability === 'manual-only') return renderClaudeManualCard(snapshot, states);
  const fiveHour = snapshot.usageWindows.find((w) => w.id === 'five-hour');
  const sevenDay = snapshot.usageWindows.find((w) => w.id === 'seven-day');
  const tokens = snapshot.tokens ?? {};
  const contextUsed = tokens.contextUsedPercent;
  const contextRemaining = tokens.contextRemainingPercent;
  const cost = tokens.totalCostUsd;
  const rateLimitRows =
    fiveHour || sevenDay
      ? [fiveHour, sevenDay]
          .filter((w): w is NonNullable<typeof w> => Boolean(w))
          .map(
            (w) =>
              `<tr><td>${escapeHtml(CLAUDE_WINDOW_TITLES[w.id] ?? w.label)}</td><td>${formatPercent(w.usedPercent)}% used</td><td>${formatPercent(w.remainingPercent)}% left</td><td>${escapeHtml(resetCell(w.resetsAt))}</td></tr>`,
          )
          .join('')
      : `<tr><td colspan="4">Not provided — the official status-line contract only reports account rate limits for Claude.ai Pro/Max subscribers, and only after the first API response.</td></tr>`;
  const hostKind = snapshot.metadata?.hostKind;
  const buttons: string[] = [];
  buttons.push(actionButton('refresh-claude', 'Refresh Claude Usage', states));
  buttons.push(actionButton('open-claude-usage', providerLinkLabel('claude-usage'), states));
  if (
    snapshot.availability !== 'integration-required' &&
    snapshot.availability !== 'integration-disabled' &&
    snapshot.availability !== 'authentication-required'
  ) {
    buttons.push(actionButton('disable-claude', 'Disable integration', states));
  }
  if (snapshot.metadata?.autoHealHealth !== undefined) {
    buttons.push(actionButton('recheck-claude', 'Recheck integration health', states));
    buttons.push(
      snapshot.metadata?.autoRepairEnabled === false
        ? actionButton('enable-claude-auto-repair', 'Enable automatic repair', states)
        : actionButton('disable-claude-auto-repair', 'Disable automatic repair', states),
    );
  }
  if (snapshot.availability === 'restart-required') {
    buttons.push(actionButton('recheck-claude', 'Recheck integration', states));
  } else if (
    snapshot.availability === 'integration-required' ||
    snapshot.availability === 'integration-disabled'
  ) {
    buttons.push(actionButton('enable-claude', 'Try Automatic Claude Usage Tracking', states));
  } else if (snapshot.availability === 'repair-required') {
    // One clear action, not the setup button plus a generic recheck — repair is idempotent and
    // safe to invoke directly.
    buttons.push(actionButton('repair-claude', 'Repair integration', states));
  } else if (RECHECK_STATES.has(snapshot.availability)) {
    buttons.push(actionButton('recheck-claude', 'Recheck integration', states));
  }
  if (TROUBLESHOOT_STATES.has(snapshot.availability)) {
    buttons.push(
      actionButton('open-claude-install-guide', providerLinkLabel('claude-install'), states),
    );
    if (hostKind === 'standalone-cli' || hostKind === 'both') {
      buttons.push(
        actionButton('launch-claude-terminal', 'Launch Claude Code in VS Code Terminal', states),
      );
    }
    buttons.push(actionButton('copy-claude-diagnostics', 'Copy redacted diagnostics', states));
  }
  const hasRealData = snapshot.usageWindows.length > 0;
  return `<section class="card"><h2>Claude Code</h2><p class="state">${escapeHtml(snapshot.availability)}${snapshot.warning ? ` — ${escapeHtml(snapshot.warning)}` : ''}</p><table><tbody>${rateLimitRows}</tbody></table><p title="Account rate limits reset on a rolling 5-hour/7-day schedule and reflect your Claude.ai plan usage. Context-window usage is how much of the current conversation's token budget has been used and resets every new conversation. Session cost is the estimated dollar cost of API usage in this session — the three numbers are independent and can differ."><b>Account plan:</b> Not exposed by the VS Code extension<br><b>Current session context window:</b> ${contextUsed === null || contextUsed === undefined ? 'Not provided' : `${formatPercent(contextUsed)}% used, ${contextRemaining === null || contextRemaining === undefined ? '?' : formatPercent(contextRemaining)}% left`}<br><b>Session cost:</b> ${cost === null || cost === undefined ? 'Not provided' : `$${cost.toFixed(4)}`}<br><b>Model:</b> ${escapeHtml(String(snapshot.metadata?.modelName ?? snapshot.metadata?.modelId ?? 'Not provided'))}<br>${cliLine(snapshot)}<br>${timestampLines(snapshot.checkedAt, snapshot.observedAt, hasRealData)}${freshnessLines(snapshot, hasRealData)}<br><b>Source:</b> ${escapeHtml(snapshot.source)}</p>${autoHealLines(snapshot)}<p class="muted">${escapeHtml(CLAUDE_METRIC_DISCLAIMER_EN)}<br>${escapeHtml(CLAUDE_METRIC_DISCLAIMER_TR)}</p>${buttons.join('')}</section>`;
}

/** "Integration health"/"Automatic repair"/etc — omitted entirely when auto-heal has not run yet in this profile. */
function autoHealLines(snapshot: ProviderSnapshot): string {
  const meta = snapshot.metadata;
  if (!meta || meta.autoHealHealth === undefined) return '';
  const fmtTime = (value: number | null | undefined): string =>
    value === null || value === undefined ? 'Not available' : new Date(value).toLocaleString();
  const fmtValue = (value: number | string | boolean | null | undefined): string =>
    value === null || value === undefined ? 'Not available' : escapeHtml(String(value));
  return `<p><b>Integration health:</b> ${escapeHtml(String(meta.autoHealHealth ?? 'unknown'))}<br><b>Automatic repair:</b> ${meta.autoRepairEnabled === false ? 'Disabled' : 'Enabled'}<br><b>Last health check:</b> ${fmtTime(meta.autoHealLastCheckAt as number | null)}<br><b>Last automatic repair:</b> ${fmtTime(meta.autoHealLastRepairAt as number | null)}<br><b>Last repair reason:</b> ${fmtValue(meta.autoHealLastRepairReason)}<br><b>Wrapper version:</b> ${fmtValue(meta.wrapperVersion)}<br><b>Expected wrapper version:</b> ${fmtValue(meta.expectedWrapperVersion)}</p>`;
}

/**
 * Extension-only/manual mode: Claude Code is connected and fully usable, but AI Limit Ledger
 * cannot automatically read account limits on this host. This is a supported limited-capability
 * mode, not an error — no warning styling, no CLI pressure.
 */
function renderClaudeManualCard(
  snapshot: ProviderSnapshot,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  const accessMode = String(snapshot.metadata?.accessMode ?? 'vscode-extension');
  const modeLabel = ACCESS_MODE_LABELS[accessMode] ?? accessMode;
  const extensionVersion = snapshot.metadata?.extensionVersion;
  const explanation =
    'Claude Code is connected through the official VS Code extension. This host did not invoke the documented status-line command, so AI Limit Ledger cannot automatically read account limits. You can view current usage with /usage inside Claude Code. Installing the standalone CLI is optional and is not required to use Claude Code.';
  const oauthAvailability = snapshot.metadata?.oauthAvailability;
  const oauthButton =
    oauthAvailability === undefined ||
    oauthAvailability === null ||
    oauthAvailability === 'disabled'
      ? actionButton('enable-claude-oauth', 'Enable CLI-free Claude Usage', states)
      : '';
  return `<section class="card"><h2>Claude Code</h2><p class="state">Claude Code extension connected — usage is available manually in Claude Code on this host.</p><p><b>Connection:</b> Connected<br><b>Mode:</b> ${escapeHtml(modeLabel)}<br>${extensionVersion ? `<b>Extension version:</b> ${escapeHtml(String(extensionVersion))}<br>` : ''}${cliLine(snapshot)}<br><b>Automatic usage tracking:</b> Not available on this host<br><b>Account plan:</b> Not exposed by the VS Code extension<br><b>Context usage:</b> Available after a documented status-line snapshot<br>${timestampLines(snapshot.checkedAt, snapshot.observedAt, false)}<br><b>Data source:</b> Official Claude Code VS Code extension</p><p class="muted">${escapeHtml(explanation)}</p>${CAPABILITY_COMPARISON_TABLE}${oauthButton}${actionButton('open-claude-code', 'Open Claude Code', states)}${actionButton('copy-claude-usage', 'Copy /usage', states)}${actionButton('open-claude-usage', providerLinkLabel('claude-usage'), states)}${actionButton('refresh-claude', 'Recheck automatic tracking', states)}${actionButton('diagnose-claude', 'Diagnose integration', states)}${actionButton('open-claude-enhanced-mode-docs', providerLinkLabel('claude-vscode-docs'), states)}</section>`;
}

const OAUTH_SOURCE_LABELS: Record<string, string> = {
  'experimental-oauth': 'Experimental OAuth usage',
  'last-known-good-oauth': 'Experimental OAuth usage (last known good)',
  none: 'Not available',
};

function fmtTimeOrNotAvailable(value: unknown): string {
  return typeof value === 'number' ? escapeHtml(new Date(value).toLocaleString()) : 'Not available';
}

/**
 * The experimental-transport card: shown only when the official status-line has no automatic
 * account-limit data on this host and the experimental OAuth usage transport is what is actually
 * driving the numbers (or the reason there aren't any). `ready-experimental`/`stale-experimental`/
 * `rate-limited-experimental` are never presented as `upstream-statusline-not-invoked` — that
 * label is reserved for when nothing experimental is available either.
 */
function renderClaudeExperimentalCard(
  snapshot: ProviderSnapshot,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  const meta = snapshot.metadata ?? {};
  const accountLimitsSource =
    OAUTH_SOURCE_LABELS[String(meta.accountLimitsSource ?? 'none')] ?? 'Not available';
  const sidebarActivity = meta.sidebarActivityDetected === true ? 'Detected' : 'Not detected';
  const stateLabel: Record<string, string> = {
    'ready-experimental': 'Experimental usage — connected',
    'stale-experimental': 'Experimental usage — showing last known usage',
    'rate-limited-experimental': 'rate-limited — showing last known usage',
    'authentication-required': 'Sign-in required',
    'consent-required': 'Consent required',
  };
  const windows =
    snapshot.usageWindows
      .map(
        (w) =>
          `<tr><td>${escapeHtml(CLAUDE_WINDOW_TITLES[w.id] ?? w.label)}</td><td>${formatPercent(w.usedPercent)}% used</td><td>${formatPercent(w.remainingPercent)}% left</td><td>${escapeHtml(resetCell(w.resetsAt))}</td></tr>`,
      )
      .join('') || '<tr><td colspan="4">No usage data yet.</td></tr>';
  const buttons: string[] = [];
  if (snapshot.availability === 'consent-required') {
    buttons.push(actionButton('enable-claude-oauth', 'Enable CLI-free Claude Usage', states));
    buttons.push(actionButton('open-claude-oauth-docs', 'Learn more', states));
  } else if (snapshot.availability === 'authentication-required') {
    buttons.push(actionButton('open-claude-code', 'Open Claude Code', states));
    buttons.push(actionButton('open-claude-usage', providerLinkLabel('claude-usage'), states));
  } else {
    buttons.push(actionButton('refresh-claude', 'Refresh Claude Usage', states));
    buttons.push(actionButton('disable-claude-oauth', 'Disable CLI-free Claude Usage', states));
    buttons.push(actionButton('open-claude-usage', providerLinkLabel('claude-usage'), states));
  }
  return `<section class="card"><h2>Claude Code</h2><p class="state">${escapeHtml(stateLabel[snapshot.availability] ?? snapshot.availability)}</p><table><tbody>${windows}</tbody></table><p><b>Account limits source:</b> ${escapeHtml(accountLimitsSource)}<br><b>Context source:</b> Not available<br>${cliLine(snapshot)}<br><b>VS Code sidebar activity:</b> ${sidebarActivity}<br><b>Last usage fetch:</b> ${fmtTimeOrNotAvailable(meta.oauthCheckedAt)}<br><b>Last known good:</b> ${fmtTimeOrNotAvailable(meta.oauthLastKnownGoodAt)}<br><b>Backoff until:</b> ${fmtTimeOrNotAvailable(meta.oauthRetryAt)}<br><b>Source:</b> ${escapeHtml(snapshot.source)}</p><p class="muted">Experimental — undocumented Anthropic usage endpoint. May be rate-limited or may stop working if Anthropic changes it.</p>${buttons.join('')}</section>`;
}
/* eslint-enable @typescript-eslint/no-unused-vars */
function renderLocalizedLegacyWebview(snapshot: LimitSnapshot, nonce: string): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const locale = catalog === getUiTextCatalog('tr') ? 'tr-TR' : 'en-US';
  const number = (value: number | null): string =>
    value === null ? catalog.notProvided : value.toLocaleString(locale);
  const seconds = (value: number | null): string => {
    if (value === null) return catalog.notProvided;
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    return `${minutes}${catalog.minutesShort} ${rest}${catalog.secondsShort}`;
  };
  const limitCards =
    snapshot.limits
      .map((limit) => {
        const label = localizedRateLimitWindowLabel(
          limit.limitId ?? undefined,
          limit.label,
          limit.durationMins,
          catalog,
        );
        const reset =
          limit.resetsAt === null
            ? catalog.notProvided
            : formatConfiguredTime(
                limit.resetsAt * 1000,
                Date.now(),
                dashboardRenderSettings.timeFormat ?? 'both',
                catalog,
                'deadline',
              );
        return `<article class="card"><h2>${escapeHtml(label)}</h2><div class="percent">${formatPercent(limit.remainingPercent)}% <small>${escapeHtml(catalog.remaining.toLowerCase())}</small></div><div class="bar"><i style="width:${limit.remainingPercent}%"></i></div><p>${formatPercent(limit.usedPercent)}% ${escapeHtml(catalog.used.toLowerCase())}</p><dl><dt>${escapeHtml(catalog.reset)}</dt><dd>${escapeHtml(reset)}</dd><dt>${escapeHtml(catalog.resetsIn)}</dt><dd>${escapeHtml(reset)}</dd></dl></article>`;
      })
      .join('') ||
    `<p>${escapeHtml(catalog.usageWindowGeneric)}: ${escapeHtml(catalog.notAvailable)}</p>`;
  const usage = snapshot.usage;
  const max = Math.max(...usage.dailyUsageBuckets.map((bucket) => bucket.tokens), 1);
  const buckets =
    usage.dailyUsageBuckets
      .map(
        (bucket) =>
          `<li><span>${escapeHtml(bucket.startDate)}</span><i style="width:${Math.round((bucket.tokens / max) * 100)}%" aria-label="${escapeHtml(number(bucket.tokens))}"></i><b>${escapeHtml(number(bucket.tokens))}</b></li>`,
      )
      .join('') || `<li>${escapeHtml(catalog.notAvailable)}</li>`;
  const plan = snapshot.planType === null ? catalog.notAvailable : snapshot.planType;
  const cli = snapshot.cliVersion === null ? catalog.notProvided : snapshot.cliVersion;
  const updated = formatConfiguredTime(
    snapshot.updatedAt.getTime(),
    Date.now(),
    dashboardRenderSettings.timeFormat ?? 'both',
    catalog,
    'past-event',
  );
  const connection = snapshot.connected ? catalog.connected : catalog.disconnected;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">body{font:var(--vscode-font-weight) var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);margin:24px;max-width:1000px}.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.card,section{border:1px solid var(--vscode-panel-border);padding:16px;border-radius:6px}.percent{font-size:30px;font-weight:bold}.percent small{font-size:13px;color:var(--vscode-descriptionForeground)}.bar{height:8px;background:color-mix(in srgb,var(--vscode-panel-border) 70%,transparent);border-radius:5px}.bar i,li i{display:block;height:100%;background:var(--vscode-progressBar-background);border-radius:5px}dl{display:grid;grid-template-columns:auto 1fr;gap:6px;color:var(--vscode-descriptionForeground)}dd{margin:0;color:var(--vscode-editor-foreground)}.action-button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 11px;margin:4px;border-radius:3px}.action-button:hover{background:var(--vscode-button-hoverBackground)}ul{list-style:none;padding:0}li{display:grid;grid-template-columns:90px 1fr auto;gap:10px;align-items:center;margin:6px 0}li i{min-width:2px}.muted{color:var(--vscode-descriptionForeground)}</style></head><body><h1>${escapeHtml(catalog.codexUsage)}</h1><div class="grid">${limitCards}</div><section><h2>${escapeHtml(catalog.accountSummary)}</h2><p><b>${escapeHtml(catalog.plan)}:</b> ${escapeHtml(plan)}<br><b>${escapeHtml(catalog.cli)}:</b> ${escapeHtml(cli)}<br><b>${escapeHtml(catalog.appServer)}:</b> ${escapeHtml(connection)}<br><b>${escapeHtml(catalog.lastSuccessfulUpdate)}:</b> ${escapeHtml(updated)}<br><b>${escapeHtml(catalog.resetCredits)}:</b> ${escapeHtml(number(snapshot.resetCredits))}</p></section><section><h2>${escapeHtml(catalog.tokenActivity)}</h2><p class="muted">${escapeHtml(catalog.lifetimeTokens)}: ${escapeHtml(number(usage.lifetimeTokens))} · ${escapeHtml(catalog.peakDaily)}: ${escapeHtml(number(usage.peakDailyTokens))} · ${escapeHtml(catalog.longestTurn)}: ${escapeHtml(seconds(usage.longestRunningTurnSec))}<br>${escapeHtml(catalog.currentStreak)}: ${escapeHtml(number(usage.currentStreakDays))} · ${escapeHtml(catalog.longestStreak)}: ${escapeHtml(number(usage.longestStreakDays))}</p><ul>${buckets}</ul></section><section>${actionButton('refresh-codex', 'Refresh Codex Usage', new Map())}${actionButton('open-codex-usage', 'Open Codex Usage Page', new Map())}${actionButton('open-provider-settings', 'Open Settings', new Map())}${actionButton('show-logs', 'Show Logs', new Map())}${actionButton('restart-codex-app-server', 'Restart App Server', new Map())}<div id="dashboard-action-status" class="action-feedback" role="status" aria-live="polite"></div></section><footer>${escapeHtml(catalog.dataReadLocally)} · ${escapeHtml(catalog.privacyFirst)}</footer><script nonce="${nonce}">${dashboardScript(catalog)}</script></body></html>`;
}

export function renderWebview(snapshot: LimitSnapshot, nonce: string): string {
  return renderLocalizedLegacyWebview(snapshot, nonce);
  // eslint-disable-next-line no-unreachable
  const limitCards =
    snapshot.limits
      .map(
        (limit) =>
          `<article class="card"><h2>${escapeHtml(limit.label)} window</h2><div class="percent">${formatPercent(limit.remainingPercent)}% <small>remaining</small></div><div class="bar"><i style="width:${limit.remainingPercent}%"></i></div><p>${formatPercent(limit.usedPercent)}% used</p><dl><dt>Resets</dt><dd>${escapeHtml(formatReset(limit.resetsAt))}</dd><dt>Time left</dt><dd>${escapeHtml(remainingDuration(limit.resetsAt))}</dd></dl></article>`,
      )
      .join('') || '<p>Limit windows are not available.</p>';
  const usage = snapshot.usage;
  const max = Math.max(...usage.dailyUsageBuckets.map((bucket) => bucket.tokens), 1);
  const buckets =
    usage.dailyUsageBuckets
      .map(
        (bucket) =>
          `<li><span>${escapeHtml(bucket.startDate)}</span><i style="width:${Math.round((bucket.tokens / max) * 100)}%" aria-label="${bucket.tokens} tokens"></i><b>${formatNumber(bucket.tokens)}</b></li>`,
      )
      .join('') || '<li>Not available</li>';
  const detailsStates = new Map<DashboardActionId, DashboardActionState>();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">body{font:var(--vscode-font-weight) var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);margin:24px;max-width:1000px}.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.card,section{border:1px solid var(--vscode-panel-border);padding:16px;border-radius:6px}.percent{font-size:30px;font-weight:bold}.percent small{font-size:13px;color:var(--vscode-descriptionForeground)}.bar{height:8px;background:color-mix(in srgb,var(--vscode-panel-border) 70%,transparent);border-radius:5px}.bar i,li i{display:block;height:100%;background:var(--vscode-progressBar-background);border-radius:5px}dl{display:grid;grid-template-columns:auto 1fr;gap:6px;color:var(--vscode-descriptionForeground)}dd{margin:0;color:var(--vscode-editor-foreground)}.action-button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 11px;margin:4px;border-radius:3px}.action-button:hover{background:var(--vscode-button-hoverBackground)}ul{list-style:none;padding:0}li{display:grid;grid-template-columns:90px 1fr auto;gap:10px;align-items:center;margin:6px 0}li i{min-width:2px}.muted{color:var(--vscode-descriptionForeground)}</style></head><body><h1>Codex Usage</h1><div class="grid">${limitCards}</div><section><h2>Account summary</h2><p><b>Plan:</b> ${escapeHtml(snapshot.planType ?? 'Not available')}<br><b>Codex CLI:</b> ${escapeHtml(snapshot.cliVersion ?? 'Not available')}<br><b>App Server:</b> ${snapshot.connected ? 'Connected' : 'Disconnected'}<br><b>Last successful update:</b> ${escapeHtml(snapshot.updatedAt.toLocaleString())}<br><b>Reset credits:</b> ${snapshot.resetCredits ?? 'Not available'}</p></section><section><h2>Token activity</h2><p class="muted">Lifetime ${formatNumber(usage.lifetimeTokens)} · Peak daily ${formatNumber(usage.peakDailyTokens)} · Longest turn ${formatSeconds(usage.longestRunningTurnSec)}<br>Current streak ${formatNumber(usage.currentStreakDays)} days · Longest streak ${formatNumber(usage.longestStreakDays)} days</p><ul>${buckets}</ul></section><section>${actionButton('refresh-codex', 'Refresh Codex Usage', detailsStates)}${actionButton('open-codex-usage', 'Open Codex Usage Page', detailsStates)}${actionButton('open-provider-settings', 'Open Settings', detailsStates)}${actionButton('show-logs', 'Show Logs', detailsStates)}${actionButton('restart-codex-app-server', 'Restart App Server', detailsStates)}<div id="dashboard-action-status" class="action-feedback" role="status" aria-live="polite"></div></section><script nonce="${nonce}">${dashboardScript()}</script></body></html>`;
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
function formatNumber(value: number | null): string {
  return value === null ? 'Not available' : value.toLocaleString();
}
function formatSeconds(value: number | null): string {
  return value === null ? 'Not available' : `${Math.floor(value / 60)}m ${value % 60}s`;
}

function richInsightTable(
  insights: readonly SafeUsageInsight[],
  catalog: UiTextCatalog,
  includeFieldProvenance = false,
): string {
  const trendValues = insights
    .filter((insight) => insight.label.startsWith('dailyTokens:'))
    .map((insight) => Number(insight.value.replace(/[^0-9]/g, '')))
    .filter((value) => Number.isFinite(value));
  const maxTrendValue = Math.max(...trendValues, 1);
  const rows = insights
    .map((insight) => {
      const label = insight.label.startsWith('dailyTokens:')
        ? `${catalog.lifetimeTokens} (${insight.label.slice('dailyTokens:'.length)})`
        : localizedInsightLabel(insight.label, catalog);
      const flags = [
        insight.isEstimated ? catalog.estimatedSessionCost : '',
        insight.isDerived ? catalog.derivedMetric : '',
        insight.isExperimental ? catalog.experimentalSource : '',
      ].filter(Boolean);
      const value = `${insight.value}${flags.length ? ` (${flags.join(', ')})` : ''}`;
      const trendValue = insight.label.startsWith('dailyTokens:')
        ? Number(insight.value.replace(/[^0-9]/g, ''))
        : NaN;
      const trendBar = Number.isFinite(trendValue)
        ? `<span class="usage-insights-table__trend"><span>${escapeHtml(value)}</span><span class="usage-insights-table__bar" aria-hidden="true"><i style="width:${Math.round((trendValue / maxTrendValue) * 100)}%"></i></span></span>`
        : escapeHtml(value);
      const provenance = includeFieldProvenance
        ? `${insightSourceKindLabel(insight.sourceKind, catalog)}: ${insight.sourceLabel}`
        : '';
      return `<tr><th scope="row">${escapeHtml(label)}</th><td>${trendBar}</td>${includeFieldProvenance ? `<td>${escapeHtml(provenance)}</td>` : ''}</tr>`;
    })
    .join('');
  return `<table class="usage-insights-table"><thead><tr><th scope="col">${escapeHtml(catalog.metric)}</th><th scope="col">${escapeHtml(catalog.value)}</th>${includeFieldProvenance ? `<th scope="col">${escapeHtml(catalog.sourceProvenance)}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderRichUsageInsights(snapshot: ProviderSnapshot): string {
  const mode = dashboardRenderSettings.insightsMode ?? 'summary';
  if (mode === 'hidden' || !snapshot.usageInsights) return '';
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const insights = safeUsageInsightsForSnapshot(
    snapshot,
    Date.now(),
    dashboardRenderSettings.language ?? 'auto',
  ).filter((insight) => {
    if (insight.label === 'planType' && snapshot.plan) return false;
    if (insight.label === 'rateLimits') return false;
    if (
      insight.label === 'resetAt' &&
      uniqueUsageWindows(snapshot).some((window) => window.resetsAt)
    )
      return false;
    if (insight.label === 'aiCreditsRemainingPercent' && copilotProgressWindow(snapshot))
      return false;
    return true;
  });
  if (insights.length === 0) return '';
  const visible = insights.slice(0, 5);
  const rest = insights.slice(5);
  const sourceKind = sourceKindForSnapshot(snapshot.source, snapshot.metadata);
  const sourceLabel = localizedProviderSourceLabel(
    normalizeProviderId(snapshot.providerId) as ProviderId,
    sourceKind,
    catalog,
  );
  const hasFieldProvenance = visible.some((insight) => insight.sourceKind !== sourceKind);
  const sessionHeading =
    snapshot.usageInsights.sessionMetrics && snapshot.providerId === 'claude'
      ? `<p class="card-note">${escapeHtml(catalog.latestObservedCliSession)}</p>`
      : '';
  const detail =
    rest.length > 0
      ? `<details class="usage-insights-details"${mode === 'detailed' ? ' open' : ''}><summary>${escapeHtml(catalog.detailed)} (${rest.length})</summary>${richInsightTable(rest, catalog, hasFieldProvenance)}</details>`
      : '';
  const provenance = `<p class="usage-insights__provenance"><strong>${escapeHtml(catalog.sourceProvenance)}:</strong> ${escapeHtml(sourceLabel)}${hasFieldProvenance ? ` · ${escapeHtml(catalog.detailed)}` : ''}</p>`;
  return `<section class="usage-insights"><h4>${escapeHtml(catalog.usageInsights)}</h4>${sessionHeading}${provenance}${richInsightTable(visible, catalog, hasFieldProvenance)}${detail}</section>`;
}

type DashboardActionItem = readonly [DashboardActionId, string];

function renderDashboardProviderCard(
  snapshot: ProviderSnapshot | undefined,
  descriptor: ProviderCapabilityDescriptor,
  presentation: ProviderPresentationState | undefined,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  if (!snapshot)
    return renderDashboardAvailableProviderCard(descriptor, snapshot, presentation, states);
  const resolved = presentation ?? resolveProviderPresentation({ snapshot, now: Date.now() });
  const displaySnapshot =
    resolved.reasonCode === 'initialization-timeout'
      ? {
          ...snapshot,
          availability: 'startup-error' as const,
          warning: 'Provider initialization timed out. Refresh or open diagnostics.',
        }
      : snapshot;
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const sourceKind = resolved.sourceKind;
  const semantic = buildProviderPresentationSummary(displaySnapshot, {
    now: Date.now(),
    thresholds: dashboardRenderSettings.thresholds,
    language: dashboardRenderSettings.language ?? 'auto',
    resolved,
  });
  const hasNumeric = semantic.quotaWindows.some(
    (window) => window.usedPercentage !== undefined || window.remainingPercentage !== undefined,
  );
  const stateLabel = dashboardStateLabel(displaySnapshot, resolved, hasNumeric);
  const capacitySeverity = semantic.quotaWindows
    .map((window) => window.severity)
    .find((severity) => severity === 'critical' || severity === 'warning');
  const severity =
    resolved.attention === 'error'
      ? 'error'
      : (capacitySeverity ?? (resolved.attention === 'warning' ? 'warning' : 'normal'));
  const badges = renderProviderBadges(displaySnapshot, resolved, stateLabel, sourceKind, catalog);
  const summary = renderLocalizedDashboardUsageSummary(
    displaySnapshot,
    descriptor,
    resolved,
    hasNumeric,
    catalog,
    semantic,
  );
  const freshness = renderDashboardFreshness(displaySnapshot, hasNumeric, resolved, semantic);
  const actions = renderDashboardActionToolbar(
    renderDashboardProviderActions(displaySnapshot, descriptor.providerId),
    states,
  );
  const technicalDetails = renderLocalizedDashboardDetails(displaySnapshot, descriptor, hasNumeric);
  const usageInsights = renderRichUsageInsights(displaySnapshot);
  return `<article class="provider-card" data-provider-id="${descriptor.providerId}" data-provider-state="${escapeHtml(displaySnapshot.availability)}" data-source-kind="${escapeHtml(sourceKind)}"><div class="card-header"><div class="provider-title"><span class="severity-indicator severity-indicator--${severity}" aria-hidden="true"></span><h3>${escapeHtml(descriptor.displayName)}</h3></div><div class="badge-row">${badges}</div></div>${summary}${freshness}${renderBackoffNotice(displaySnapshot)}${usageInsights}${technicalDetails}${actions}</article>`;
}

function renderDashboardAvailableProviderCard(
  descriptor: ProviderCapabilityDescriptor,
  snapshot: ProviderSnapshot | undefined,
  presentation: ProviderPresentationState | undefined,
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  const compactSetupStates = new Set(['cli-not-installed', 'not-selected', 'disabled']);
  if (snapshot && !compactSetupStates.has(snapshot.availability)) {
    return renderDashboardProviderCard(snapshot, descriptor, presentation, states);
  }
  const sourceKind = presentation?.sourceKind ?? defaultSourceKind(descriptor);
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const state = snapshot && presentation ? catalog[presentation.statusKey] : catalog.setupRequired;
  const description = availableProviderDescription(descriptor.providerId);
  const warning = undefined;
  const actions = snapshot
    ? renderDashboardProviderActions(snapshot, descriptor.providerId)
    : defaultAvailableActions(descriptor.providerId);
  const details = snapshot ? renderLocalizedDashboardDetails(snapshot, descriptor, false) : '';
  return `<article class="setup-card" data-provider-id="${descriptor.providerId}" data-provider-state="${escapeHtml(snapshot?.availability ?? 'available')}"><div class="card-header"><div class="provider-title"><h3>${escapeHtml(descriptor.displayName)}</h3></div><div class="badge-row"><span class="badge">${escapeHtml(state)}</span><span class="badge badge--source">${escapeHtml(sourceBadgeLabel(sourceKind))}</span></div></div><p class="setup-requirement">${escapeHtml(description)}</p>${warning ? `<p class="card-note">${escapeHtml(warning)}</p>` : ''}<p class="card-note">${catalog.numericUsageUnavailable}</p>${details}${renderDashboardActionToolbar(actions, states)}</article>`;
}

type ProviderBadgeId =
  'official' | 'experimental' | 'stale' | 'last-known-good' | 'warning' | 'error';

function renderProviderBadges(
  snapshot: ProviderSnapshot,
  presentation: ProviderPresentationState,
  stateLabel: string,
  sourceKind: ProviderPresentationState['sourceKind'],
  catalog: UiTextCatalog,
): string {
  const badges = new Map<ProviderBadgeId, { label: string; className: string }>();
  if (sourceKind === 'official')
    badges.set('official', { label: catalog.official, className: 'badge--source' });
  else if (sourceKind.startsWith('experimental'))
    badges.set('experimental', { label: catalog.experimental, className: 'badge--experimental' });
  const lastKnownGood = presentation.dataAvailability === 'numeric-last-known-good';
  const stale = snapshot.stale || presentation.dataAvailability === 'numeric-stale';
  if (lastKnownGood)
    badges.set('last-known-good', { label: catalog.staleData, className: 'badge--warning' });
  else if (stale) badges.set('stale', { label: catalog.stale, className: 'badge--warning' });
  if (presentation.attention === 'error')
    badges.set('error', { label: catalog.error, className: 'badge--error' });
  else if (presentation.attention === 'warning')
    badges.set('warning', { label: catalog.warning, className: 'badge--warning' });
  const status = `<span class="badge" data-badge="status">${escapeHtml(stateLabel)}</span>`;
  const ordered = [
    'official',
    'experimental',
    'stale',
    'last-known-good',
    'warning',
    'error',
  ] as const;
  return `${status}${ordered
    .map((id) => {
      const badge = badges.get(id);
      return badge
        ? `<span class="badge ${badge.className}" data-badge="${id}">${escapeHtml(badge.label)}</span>`
        : '';
    })
    .join('')}`;
}

function renderLocalizedDashboardUsageSummary(
  snapshot: ProviderSnapshot,
  descriptor: ProviderCapabilityDescriptor,
  presentation: ProviderPresentationState,
  hasNumeric: boolean,
  catalog: UiTextCatalog,
  semantic: ProviderPresentationSummary,
): string {
  if (snapshot.availability === 'manual-only' && descriptor.providerId === 'claude') {
    return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">${catalog.connectedStatus}</span><span class="primary-usage__label">${catalog.manualUsageMode}</span></div><p class="card-note">${catalog.claudeExtensionConnected}</p><p class="card-note">${catalog.claudeAutomaticUsageRequirement}</p><p class="card-note">${catalog.automaticUsageUnavailable}</p></div>`;
  }
  if (descriptor.providerId === 'copilot') {
    const progressWindow = semantic.quotaWindows.find(
      (window) => window.id === 'monthly-ai-credits' && window.fillPercentage !== undefined,
    );
    const metrics = copilotMetricTilesLocalized(snapshot, catalog);
    const progressMarkup = progressWindow
      ? `<div class="card-summary"><div class="usage-window-list">${renderPresentedDashboardProgressWindow(descriptor.displayName, descriptor.providerId, progressWindow, catalog)}</div></div>`
      : '';
    return `${progressMarkup}${metrics ? `<dl class="metric-grid">${metrics}</dl>` : ''}${!progressMarkup && !metrics ? `<p class="card-note">${catalog.numericUsageUnavailable}</p>` : !progressMarkup ? `<p class="card-note">${catalog.monthlyAllowanceNotProvidedShort}</p>` : ''}`;
  }
  if (
    descriptor.providerId === 'grok' &&
    !hasNumeric &&
    snapshot.connected &&
    (snapshot.availability === 'connected-no-billing-method' ||
      String(snapshot.plan ?? '').toLowerCase() === 'free')
  ) {
    return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">${catalog.freePlan}</span><span class="primary-usage__label">${catalog.connectedStatus}</span></div><p class="card-note">${catalog.numericUsageNotExposed}</p></div>`;
  }
  const windows = semantic.quotaWindows.filter(
    (window) => window.usedPercentage !== undefined || window.remainingPercentage !== undefined,
  );
  if (!windows.length)
    return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">${catalog.noUsageData}</span><span class="primary-usage__label">${localizedPresentationText(presentation, catalog)}</span></div><p class="card-note">${catalog.numericUsageUnavailable}</p>${snapshot.availability === 'waiting-for-first-response' ? `<p class="card-note">${catalog.claudeResponseDataRequirement}</p>` : ''}</div>`;
  return `<div class="card-summary"><div class="usage-window-list">${windows.map((window) => renderPresentedDashboardProgressWindow(descriptor.displayName, descriptor.providerId, window, catalog)).join('')}</div></div>`;
}

function localizedPresentationText(
  presentation: ProviderPresentationState,
  catalog: UiTextCatalog,
): string {
  return presentation.explanationKey
    ? catalog[presentation.explanationKey]
    : catalog[presentation.statusKey];
}

function copilotMetricTilesLocalized(snapshot: ProviderSnapshot, catalog: UiTextCatalog): string {
  const meta = snapshot.metadata ?? {};
  const metrics: Array<readonly [string, number | undefined]> = [
    [
      catalog.aiCredits,
      finiteMetadataNumber(snapshot.credits?.used) ??
        finiteMetadataNumber(meta.aiCreditsUsed) ??
        finiteMetadataNumber(meta.premiumInteractionsCreditsUsed),
    ],
    [catalog.premiumInteractions, finiteMetadataNumber(meta.premiumInteractionsCreditsUsed)],
    [catalog.chatQuota, finiteMetadataNumber(meta.chatCreditsUsed)],
    [catalog.completionsQuota, finiteMetadataNumber(meta.completionsCreditsUsed)],
  ];
  return metrics
    .filter(([, value]) => value !== undefined)
    .map(
      ([label, value]) =>
        `<div class="metric-tile"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatSafeNumber(value))}</dd></div>`,
    )
    .join('');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderDashboardUsageSummary(
  snapshot: ProviderSnapshot,
  descriptor: ProviderCapabilityDescriptor,
  presentation: ProviderPresentationState,
  hasNumeric: boolean,
): string {
  if (snapshot.availability === 'manual-only' && descriptor.providerId === 'claude') {
    return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">Connected</span><span class="primary-usage__label">Manual usage mode</span></div><p class="card-note">Claude Code extension connected — usage is available manually in Claude Code on this host.</p><p class="card-note">Automatic usage tracking: Not available on this host.</p></div>`;
  }
  if (descriptor.providerId === 'copilot') return renderCopilotDashboardSummary(snapshot);
  if (
    descriptor.providerId === 'grok' &&
    !hasNumeric &&
    snapshot.connected &&
    (snapshot.availability === 'connected-no-billing-method' ||
      String(snapshot.plan ?? '').toLowerCase() === 'free')
  ) {
    return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">Free plan</span><span class="primary-usage__label">Connected</span></div><p class="card-note">Numeric usage is not exposed by this source.</p></div>`;
  }
  const windows = uniqueUsageWindows(snapshot).filter(
    (window) =>
      createRemainingCapacityProgress(window.usedPercent, dashboardRenderSettings.thresholds) !==
      undefined,
  );
  if (!windows.length) {
    const explanation = snapshot.warning ?? dashboardStateLabel(snapshot, presentation, false);
    return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">No usage data</span><span class="primary-usage__label">${escapeHtml(explanation)}</span></div><p class="card-note">Usage data is not available yet.</p></div>`;
  }
  const primary = windows[0];
  const progress = createRemainingCapacityProgress(
    primary.usedPercent,
    dashboardRenderSettings.thresholds,
  );
  if (!progress) {
    return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">No usage data</span><span class="primary-usage__label">Percentage not provided</span></div><p class="card-note">Usage data is not available yet.</p></div>`;
  }
  const windowLabel = displayWindowLabel(descriptor.providerId, primary);
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const percentage = percentageText(
    progress.remainingPercent,
    progress.usedPercent,
    dashboardRenderSettings.percentageMode ?? 'both',
    catalog,
  );
  const primaryPercentage =
    progress.severity === 'critical'
      ? `${percentage} · ${catalog.critical.toLowerCase()}`
      : percentage;
  return `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">${primaryPercentage}</span><span class="primary-usage__label">${escapeHtml(windowLabel)}</span></div><div class="usage-window-list">${windows.map((window) => renderDashboardProgressWindow(descriptor.displayName, descriptor.providerId, window)).join('')}</div></div>`;
}

function renderCopilotDashboardSummary(snapshot: ProviderSnapshot): string {
  const progressWindow = copilotProgressWindow(snapshot);
  const metrics = copilotMetricTiles(snapshot);
  const progressModel = progressWindow
    ? createRemainingCapacityProgress(
        progressWindow.usedPercent,
        dashboardRenderSettings.thresholds,
      )
    : undefined;
  const allowanceNotice = progressModel
    ? ''
    : '<p class="card-note">Monthly allowance not provided. Raw metrics are shown without a fabricated percentage.</p>';
  const progress =
    progressWindow && progressModel
      ? `<div class="card-summary"><div class="primary-usage"><span class="primary-usage__value">${percentageText(progressModel.remainingPercent, progressModel.usedPercent, dashboardRenderSettings.percentageMode ?? 'both', getUiTextCatalog(dashboardRenderSettings.language ?? 'auto'))}</span><span class="primary-usage__label">Monthly AI credits</span></div><div class="usage-window-list">${renderDashboardProgressWindow('GitHub Copilot', 'copilot', progressWindow)}</div></div>`
      : '';
  return `${progress}${metrics ? `<dl class="metric-grid">${metrics}</dl>` : ''}${allowanceNotice || (!progress && !metrics ? '<p class="card-note">Usage data is not available yet.</p>' : '')}`;
}

function renderDashboardProgressWindow(
  providerName: string,
  providerId: string,
  window: ProviderSnapshot['usageWindows'][number],
): string {
  const progress = createRemainingCapacityProgress(
    window.usedPercent,
    dashboardRenderSettings.thresholds,
  );
  if (!progress) return '';
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const label = displayWindowLabel(providerId, window, catalog);
  const ariaLabel = `${providerName} ${window.id || label} ${catalog.accountLimit.toLowerCase()} ${catalog.remaining.toLowerCase()}`;
  const statusText =
    progress.severity === 'critical'
      ? catalog.critical
      : progress.severity === 'warning'
        ? catalog.warning
        : undefined;
  const status = statusText
    ? `<span class="usage-progress__status usage-progress__status--${progress.severity}">${escapeHtml(statusText)}</span>`
    : '';
  const percentage = percentageText(
    progress.remainingPercent,
    progress.usedPercent,
    dashboardRenderSettings.percentageMode ?? 'both',
    catalog,
  );
  return `<div class="usage-window" data-window-id="${escapeHtml(window.id || label)}"><div class="usage-window__header"><strong>${escapeHtml(label)}</strong><span class="usage-progress__text">${percentage}</span></div><div class="usage-progress usage-progress--${progress.severity}" role="progressbar" aria-label="${escapeHtml(ariaLabel)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.ariaValueNow}" aria-valuetext="${escapeHtml(progress.ariaValueText)}"><div class="usage-progress__fill" style="width:${progress.fillPercent}%"></div></div><div class="usage-window__meta">${status}<span>${catalog.reset} ${escapeHtml(resetCell(window.resetsAt))}</span></div></div>`;
}

function renderPresentedDashboardProgressWindow(
  providerName: string,
  providerId: string,
  window: PresentedQuotaWindow,
  catalog: UiTextCatalog,
): string {
  const percentage =
    presentedPercentageText(window, dashboardRenderSettings.percentageMode ?? 'both', catalog) ??
    catalog.percentageNotProvided;
  const status = window.statusText
    ? `<span class="usage-progress__status usage-progress__status--${window.severity ?? 'normal'}">${escapeHtml(window.statusText)}</span>`
    : '';
  const ariaValueText =
    window.ariaValueText ??
    `${window.remainingPercentage ?? window.ariaValueNow ?? 0}% ${catalog.remaining.toLowerCase()}`;
  const reset = window.reset
    ? formatPresentedReset(window.reset, dashboardRenderSettings.timeFormat ?? 'both', catalog)
    : catalog.notProvided;
  const ariaLabel = `${providerName} ${window.id} ${catalog.accountLimit.toLowerCase()} ${catalog.remaining.toLowerCase()}`;
  const progressMarkup =
    window.fillPercentage !== undefined && window.ariaValueNow !== undefined
      ? `<div class="usage-progress usage-progress--${window.severity ?? 'normal'}" role="progressbar" aria-label="${escapeHtml(ariaLabel)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${window.ariaValueNow}" aria-valuetext="${escapeHtml(ariaValueText)}"><div class="usage-progress__fill" style="width:${window.fillPercentage}%"></div></div>`
      : '';
  return `<div class="usage-window${progressMarkup ? '' : ' usage-window--text-only'}" data-window-id="${escapeHtml(window.id)}"><div class="usage-window__header"><strong>${escapeHtml(window.label)}</strong><span class="usage-progress__text">${escapeHtml(percentage)}</span></div>${progressMarkup}<div class="usage-window__meta">${status}<span>${escapeHtml(catalog.reset)} ${escapeHtml(reset)}</span></div></div>`;
}

function renderLocalizedDashboardFreshness(
  snapshot: ProviderSnapshot,
  hasNumeric: boolean,
  presentation: ProviderPresentationState,
  semantic?: ProviderPresentationSummary,
): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const presentationSummary =
    semantic ??
    buildProviderPresentationSummary(snapshot, {
      now: Date.now(),
      thresholds: dashboardRenderSettings.thresholds,
      language: dashboardRenderSettings.language ?? 'auto',
      resolved: presentation,
    });
  const freshness = presentationSummary.freshness;
  if (freshness.state === 'fresh')
    return `<div class="freshness-summary"><span><strong>${catalog.dataFreshness}:</strong> ${escapeHtml(freshness.summaryText)}</span></div>`;
  const details = freshness.detailLines
    .map(
      (line) =>
        `<span><strong>${escapeHtml(line.label)}:</strong> ${escapeHtml(line.value)}</span>`,
    )
    .join('');
  return `<div class="freshness-summary">${details}</div><p class="card-note">${catalog.showingLastKnownUsage}</p>`;
}

function renderDashboardFreshness(
  snapshot: ProviderSnapshot,
  hasNumeric: boolean,
  presentation: ProviderPresentationState,
  semantic?: ProviderPresentationSummary,
): string {
  return renderLocalizedDashboardFreshness(snapshot, hasNumeric, presentation, semantic);
  /* istanbul ignore next -- retained legacy implementation for source compatibility. */
  // eslint-disable-next-line no-unreachable
  const checked = validTimestamp(snapshot.checkedAt) ?? validTimestamp(snapshot.observedAt);
  const observed = validTimestamp(snapshot.observedAt);
  const successful =
    validTimestamp(snapshot.lastSuccessfulDataUpdate) ??
    validTimestamp(snapshot.lastSuccessfulUpdateAt) ??
    (hasNumeric ? observed : undefined);
  const next =
    validTimestamp(snapshot.nextFallbackRefreshAt) ??
    validMetadataTimestamp(snapshot.metadata?.nextRefreshAt);
  const lastEvent = validTimestamp(snapshot.lastProviderEventAt);
  const nextFallback = validTimestamp(snapshot.nextFallbackRefreshAt);
  const age = hasNumeric && observed !== undefined ? elapsedDuration(observed) : 'Not applicable';
  const stale =
    snapshot.stale ||
    presentation.dataAvailability === 'numeric-stale' ||
    presentation.dataAvailability === 'numeric-last-known-good';
  const lastKnownGood = presentation.dataAvailability === 'numeric-last-known-good' || stale;
  const successfulLine =
    successful === undefined
      ? ''
      : `<span><strong>Last successful data update:</strong> ${escapeHtml(formatDate(successful))}</span>`;
  return `<div class="freshness-summary"><span><strong>Last check:</strong> ${escapeHtml(formatDate(checked))}</span>${successfulLine}<span><strong>Last provider event:</strong> ${escapeHtml(formatDate(lastEvent))}</span><span><strong>Next fallback refresh:</strong> ${escapeHtml(formatDate(nextFallback))}</span><span><strong>Snapshot age:</strong> ${escapeHtml(age)}</span><span><strong>Next automatic check:</strong> ${escapeHtml(formatDate(next))}</span></div>${stale ? `<p class="card-note">${lastKnownGood ? 'Showing last known usage.' : 'Stale data.'}</p>` : ''}`;
}

function renderBackoffNotice(snapshot: ProviderSnapshot): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const retryAt = validTimestamp(snapshot.retryAt);
  return retryAt === undefined
    ? ''
    : `<p class="backoff-notice" role="status">${catalog.retryPausedUntil} ${escapeHtml(formatDate(retryAt, 'future-target'))}</p>`;
}

function renderLocalizedDashboardDetails(
  snapshot: ProviderSnapshot,
  descriptor: ProviderCapabilityDescriptor,
  hasNumeric: boolean,
): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const sourceKind = sourceKindForSnapshot(snapshot.source, snapshot.metadata);
  const hasPlanInsight = safeUsageInsightsForSnapshot(
    snapshot,
    Date.now(),
    dashboardRenderSettings.language ?? 'auto',
  ).some((insight) => insight.label === 'planType');
  const values: Array<readonly [string, string | undefined]> = [
    [
      catalog.plan,
      snapshot.plan ? safeText(snapshot.plan) : hasPlanInsight ? undefined : catalog.notProvided,
    ],
    [catalog.cli, safeText(snapshot.cliVersion) ?? catalog.notProvided],
    [catalog.extension, safeText(snapshot.extensionVersion ?? snapshot.metadata?.extensionVersion)],
    [catalog.dataSource, localizedProviderSourceLabel(descriptor.providerId, sourceKind, catalog)],
    [
      catalog.lastProviderEvent,
      formatDate(validTimestamp(snapshot.lastProviderEventAt), 'past-event'),
    ],
    [
      catalog.nextFallbackRefresh,
      formatDate(validTimestamp(snapshot.nextFallbackRefreshAt), 'future-target'),
    ],
    [
      catalog.snapshotAge,
      hasNumeric ? elapsedDuration(snapshot.observedAt) : catalog.notApplicable,
    ],
    [catalog.backoff, formatDate(validTimestamp(snapshot.retryAt), 'future-target')],
  ];
  if (descriptor.providerId === 'claude') {
    const tokens = snapshot.tokens ?? {};
    const contextUsed = finiteMetadataNumber(tokens.contextUsedPercent);
    const contextRemaining = finiteMetadataNumber(tokens.contextRemainingPercent);
    values.push([
      catalog.currentSessionContextWindow,
      contextUsed === undefined
        ? catalog.notProvided
        : `${formatPercent(contextUsed)}% ${catalog.used.toLowerCase()}, ${formatPercent(contextRemaining)}% ${catalog.left}`,
    ]);
    const cost = finiteMetadataNumber(tokens.totalCostUsd);
    if (cost !== undefined) values.push([catalog.sessionCostUsd, `$${cost.toFixed(4)}`]);
    values.push(
      [catalog.accountPlanNotExposed, catalog.accountPlanNotExposed],
      [catalog.contextSource, catalog.contextUsageAfterSnapshot],
      [catalog.note, catalog.claudeMetricDisclaimer],
    );
    if (catalog === getUiTextCatalog('en'))
      values.push([catalog.note, getUiTextCatalog('tr').claudeMetricDisclaimer]);
    if (!hasNumeric) values.push([catalog.usageWindow, catalog.claudeRateLimitAvailability]);
    if (sourceKind.startsWith('experimental'))
      values.push([catalog.source, catalog.experimentalClaudeEndpointDescription]);
  }
  if (descriptor.providerId === 'copilot') {
    values.push(
      [
        catalog.accountManagement,
        localizedMetadataEnum(snapshot.metadata?.accountManagement, catalog),
      ],
      [catalog.endpointPlan, safeText(snapshot.metadata?.endpointPlan)],
    );
  }
  const model = safeText(snapshot.metadata?.modelName ?? snapshot.metadata?.modelId);
  if (model !== undefined) values.push([catalog.model, model]);
  const items = values
    .filter(([, value]) => value !== undefined)
    .map(
      ([label, value]) =>
        `<div class="detail-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '')}</dd></div>`,
    )
    .join('');
  const manualSummary =
    descriptor.providerId === 'claude' && snapshot.availability === 'manual-only'
      ? `<p class="card-note"><b>${catalog.connection}:</b> ${snapshot.connected ? catalog.connected : catalog.notConnected}<br><b>${catalog.mode}:</b> ${escapeHtml(accessModeDisplay(snapshot, catalog))}<br><b>${catalog.extension}:</b> ${escapeHtml(String(snapshot.metadata?.extensionVersion ?? snapshot.extensionVersion ?? catalog.notProvided))}<br><b>${catalog.cli}:</b> ${escapeHtml(cliLineText(snapshot, catalog))}<br><b>${catalog.automaticUsageTracking}:</b> ${catalog.automaticUsageUnavailable}<br><b>${catalog.accountPlan}:</b> ${catalog.accountPlanValue}<br><b>${catalog.contextSource}:</b> ${catalog.contextUsageAfterSnapshot}<br><b>${catalog.dataSource}:</b> ${localizedProviderSourceLabel('claude', 'official', catalog)}<br>${catalog.cliEnhancedModeOptional}</p>`
      : '';
  return `<details class="details-panel"><summary>${catalog.detailed}</summary><dl class="details-grid"><div class="detail-item"><dt>${catalog.providerSettings}</dt><dd>${escapeHtml(descriptor.displayName)}</dd></div>${items}</dl>${manualSummary}</details>`;
}

function localizedMetadataEnum(value: unknown, catalog: UiTextCatalog): string {
  if (value === 'auto') return catalog.auto;
  if (value === 'shown') return catalog.shown;
  if (value === 'hidden') return catalog.hidden;
  if (value === 'organization-managed') return catalog.accountManagement;
  return safeText(value) ?? catalog.notProvided;
}

/* Legacy renderer retained as documentation; rich dashboard uses the semantic renderer above.
function renderDashboardDetails(
  snapshot: ProviderSnapshot,
  descriptor: ProviderCapabilityDescriptor,
  hasNumeric: boolean,
): string {
  const meta = snapshot.metadata ?? {};
  const values: Array<readonly [string, string | undefined]> = [
    ['Plan', safeText(snapshot.plan)],
    ['CLI version', safeText(snapshot.cliVersion)],
    ['Extension version', safeText(snapshot.extensionVersion ?? meta.extensionVersion)],
    ['Data source', safeText(snapshot.source)],
    ['Source provenance', safeText(snapshot.provenance)],
    ['Last provider event', formatDate(validTimestamp(snapshot.lastProviderEventAt))],
    ['Next fallback refresh', formatDate(validTimestamp(snapshot.nextFallbackRefreshAt))],
    [
      'Snapshot age',
      hasNumeric && validTimestamp(snapshot.observedAt) !== undefined
        ? elapsedDuration(snapshot.observedAt)
        : undefined,
    ],
    ['Backoff', formatDate(validTimestamp(snapshot.retryAt))],
  ];
  if (descriptor.providerId === 'claude' && snapshot.availability === 'manual-only') {
    values.push(
      ['Connection', snapshot.connected ? 'Connected' : 'Not connected'],
      ['Mode', safeMetadataValue(meta.accessMode)],
      ['Claude Code CLI', cliLineText(snapshot)],
      ['Automatic usage tracking', 'Not available on this host'],
      ['Account plan', 'Not exposed by the VS Code extension'],
      ['Context usage', 'Available after a documented status-line snapshot'],
    );
  }
  if (descriptor.providerId === 'claude') {
    const tokens = snapshot.tokens ?? {};
    const contextUsed = finiteMetadataNumber(tokens.contextUsedPercent);
    const contextRemaining = finiteMetadataNumber(tokens.contextRemainingPercent);
    if (contextUsed !== undefined) {
      values.push([
        catalog.currentSessionContextWindow,
        `${formatPercent(contextUsed)}% used, ${formatPercent(contextRemaining)}% left`,
      ]);
    } else {
      values.push([catalog.currentSessionContextWindow, catalog.notProvided]);
    }
    const cost = finiteMetadataNumber(tokens.totalCostUsd);
    if (cost !== undefined) values.push(['Session cost', `$${cost.toFixed(4)}`]);
    values.push(
      [catalog.accountPlanNotExposed, catalog.accountPlanNotExposed],
      [catalog.note, catalog.claudeMetricDisclaimer],
    );
    if (!hasNumeric) {
      values.push([
        catalog.usageWindow,
        catalog.claudeRateLimitAvailability,
      ]);
    }
    if (sourceKindForSnapshot(snapshot.source, snapshot.metadata).startsWith('experimental')) {
      values.push([catalog.source, catalog.experimentalClaudeEndpointDescription]);
    }
  }
  const metadataFields: Array<readonly [string, string]> = [
    ['Refresh mode', 'refreshMode'],
    ['Account management', 'accountManagement'],
    ['Endpoint plan', 'endpointPlan'],
    ['Configured billing scope', 'configuredBillingScope'],
    ['Token-based billing', 'tokenBasedBilling'],
    ['Model breakdown', 'modelBreakdown'],
    ['Context source', 'contextSource'],
    ['ACP capability', 'acpBillingCapability'],
    ['Product breakdown', 'productBreakdown'],
    ['Integration health', 'autoHealHealth'],
    ['Automatic repair', 'autoRepairEnabled'],
    ['Experimental fallback', 'experimentalFallbackStatus'],
    ['Model', 'modelName'],
    ['Model ID', 'modelId'],
    ['Claude access mode', 'accessMode'],
    ['Current session context window', 'contextUsedPercent'],
    ['Session cost (USD)', 'totalCostUsd'],
  ];
  for (const [label, key] of metadataFields) {
    const value = safeMetadataValue(meta[key]);
    if (value !== undefined) values.push([label, value]);
  }
  const items = values
    .filter(([, value]) => value !== undefined)
    .map(
      ([label, value]) =>
        `<div class="detail-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '')}</dd></div>`,
    )
    .join('');
  const manualSummary =
    descriptor.providerId === 'claude' && snapshot.availability === 'manual-only'
      ? `<p class="card-note"><b>Connection:</b> ${snapshot.connected ? 'Connected' : 'Not connected'}<br><b>Mode:</b> ${escapeHtml(accessModeDisplay(snapshot))}<br><b>Extension version:</b> ${escapeHtml(String(snapshot.metadata?.extensionVersion ?? snapshot.extensionVersion ?? 'Not provided'))}<br><b>Claude Code CLI:</b> ${escapeHtml(cliLineText(snapshot))}<br><b>Automatic usage tracking:</b> Not available on this host<br><b>Account plan:</b> Not exposed by the VS Code extension<br><b>Context usage:</b> Available after a documented status-line snapshot<br><b>Data source:</b> Official Claude Code VS Code extension</p>`
      : '';
  const comparison =
    descriptor.providerId === 'claude' && snapshot.availability === 'manual-only'
      ? CAPABILITY_COMPARISON_TABLE
      : '';
  return `<details class="details-panel"><summary>Details</summary><dl class="details-grid"><div class="detail-item"><dt>Provider</dt><dd>${escapeHtml(descriptor.displayName)}</dd></div>${items}</dl>${manualSummary}${comparison}</details>`;
}

*/
function renderDashboardActionToolbar(
  items: readonly DashboardActionItem[],
  states: ReadonlyMap<DashboardActionId, DashboardActionState>,
): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  const localizedItems = items.map(
    ([id, label]) => [id, localizedActionLabel(id, label, catalog)] as const,
  );
  const unique = localizedItems.filter(
    (item, index, all) => all.findIndex((candidate) => candidate[0] === item[0]) === index,
  );
  if (!unique.length) return '';
  const [primary, secondary, ...more] = unique;
  const moreMenu = more.length
    ? `<details class="more-actions"><summary aria-label="${catalog.moreActions}">${renderDashboardIcon('more', { className: 'more-actions__icon' })}<span>${catalog.moreActions}</span></summary><div class="more-actions__menu">${more.map(([id, label]) => actionButton(id, label, states, 'menu')).join('')}</div></details>`
    : '';
  return `<div class="action-toolbar"><div class="action-toolbar__primary">${actionButton(primary[0], primary[1], states, 'primary')}</div>${secondary ? `<div class="action-toolbar__secondary">${actionButton(secondary[0], secondary[1], states, 'secondary')}</div>` : ''}${moreMenu}</div>`;
}

function renderDashboardProviderActions(
  snapshot: ProviderSnapshot,
  providerId: string,
): DashboardActionItem[] {
  const items: DashboardActionItem[] = [];
  const add = (id: DashboardActionId, label: string): void => {
    items.push([id, label]);
  };
  if (providerId === 'codex') {
    add('refresh-codex', 'Refresh');
    add('open-codex-usage', providerLinkLabel('codex-usage'));
    add('restart-codex-app-server', 'Restart App Server');
    add('diagnose-codex', 'Diagnose');
    return items;
  }
  if (providerId === 'claude') {
    if (EXPERIMENTAL_STATES.has(snapshot.availability)) {
      if (snapshot.availability === 'consent-required') {
        add('enable-claude-oauth', 'Enable CLI-free usage');
        add('open-claude-oauth-docs', 'Learn more');
      } else if (snapshot.availability === 'authentication-required') {
        add('open-claude-code', 'Connect Claude Code');
        add('open-claude-usage', providerLinkLabel('claude-usage'));
      } else {
        add('refresh-claude', 'Refresh');
        add('open-claude-usage', providerLinkLabel('claude-usage'));
        add('disable-claude-oauth', 'Disable CLI-free usage');
      }
      return items;
    }
    if (snapshot.availability === 'manual-only') {
      add('open-claude-code', 'Open Claude Code');
      add('copy-claude-usage', 'Copy /usage');
      add('open-claude-usage', providerLinkLabel('claude-usage'));
      add('refresh-claude', 'Recheck automatic tracking');
      add('diagnose-claude', 'Diagnose');
      add('open-claude-enhanced-mode-docs', 'Learn about enhanced CLI mode');
      return items;
    }
    if (
      snapshot.availability === 'integration-required' ||
      snapshot.availability === 'integration-disabled'
    ) {
      add('enable-claude', 'Try Automatic Claude Usage Tracking');
    } else if (snapshot.availability === 'repair-required') {
      add('repair-claude', 'Repair integration');
    } else {
      add('refresh-claude', 'Refresh Claude Usage');
    }
    add('open-claude-usage', providerLinkLabel('claude-usage'));
    if (
      snapshot.availability !== 'integration-required' &&
      snapshot.availability !== 'integration-disabled' &&
      snapshot.availability !== 'authentication-required'
    )
      add('disable-claude', 'Disable integration');
    if (snapshot.metadata?.autoHealHealth !== undefined) {
      add('recheck-claude', 'Recheck integration health');
      add(
        snapshot.metadata.autoRepairEnabled === false
          ? 'enable-claude-auto-repair'
          : 'disable-claude-auto-repair',
        snapshot.metadata.autoRepairEnabled === false
          ? 'Enable automatic repair'
          : 'Disable automatic repair',
      );
    }
    if (snapshot.availability === 'restart-required' || RECHECK_STATES.has(snapshot.availability))
      add('recheck-claude', 'Recheck integration');
    if (snapshot.availability === 'repair-required')
      add('copy-claude-diagnostics', 'Copy diagnostics');
    if (TROUBLESHOOT_STATES.has(snapshot.availability)) {
      add('open-claude-install-guide', providerLinkLabel('claude-install'));
      const hostKind = snapshot.metadata?.hostKind;
      if (hostKind === 'standalone-cli' || hostKind === 'both')
        add('launch-claude-terminal', 'Launch Claude Terminal');
      add('copy-claude-diagnostics', 'Copy diagnostics');
    }
    return items;
  }
  if (providerId === 'copilot') {
    if (snapshot.availability === 'authentication-required') add('connect-copilot', 'Connect');
    else add('refresh-copilot', 'Refresh');
    add('open-copilot-usage', providerLinkLabel('copilot-billing'));
    if (
      snapshot.availability !== 'authentication-required' &&
      snapshot.availability !== 'organization-managed' &&
      snapshot.availability !== 'ready-experimental'
    )
      add('disconnect-copilot', 'Disconnect');
    add('configure-copilot-plan', 'Configure plan');
    add('diagnose-copilot', 'Diagnose');
    const experimental =
      snapshot.metadata?.billingEndpoint === 'experimental-entitlement' ||
      snapshot.availability === 'organization-managed';
    add(
      experimental ? 'disable-copilot-experimental' : 'enable-copilot-experimental',
      experimental ? 'Disable experimental usage' : 'Enable experimental usage',
    );
    return items;
  }
  if (snapshot.availability === 'cli-not-installed') {
    add('open-grok-install-guide', providerLinkLabel('grok-install'));
    add('recheck-grok', 'Recheck installation');
  } else if (snapshot.availability === 'authentication-required') {
    add('launch-grok-login', 'Connect Grok');
    add('refresh-grok', 'Refresh');
  } else if (snapshot.availability === 'disabled') {
    add('enable-grok', 'Enable integration');
    add('open-grok-usage', providerLinkLabel('grok-billing'));
    add('copy-grok-usage', localization.t('copyUsageCommand'));
  } else {
    add('refresh-grok', 'Refresh');
    add('open-grok-usage', providerLinkLabel('grok-billing'));
    add('copy-grok-usage', localization.t('copyUsageCommand'));
    add('disable-grok', 'Disable integration');
  }
  add('diagnose-grok', 'Diagnose');
  add('open-grok-install-guide', providerLinkLabel('grok-install'));
  const experimental =
    snapshot.metadata?.acpBillingCapability === 'unavailable-safe-fallback-active' ||
    snapshot.availability === 'method-not-supported';
  add(
    experimental ? 'disable-grok-experimental' : 'enable-grok-experimental',
    experimental ? 'Disable experimental usage' : 'Enable experimental usage',
  );
  return items;
}

function defaultAvailableActions(providerId: string): DashboardActionItem[] {
  switch (providerId) {
    case 'codex':
      return [
        ['open-provider-settings', 'Provider Settings'],
        ['open-codex-usage', providerLinkLabel('codex-usage')],
        ['diagnose-codex', 'Diagnose'],
      ];
    case 'claude':
      return [
        ['open-provider-settings', 'Provider Settings'],
        ['open-claude-usage', providerLinkLabel('claude-usage')],
        ['open-claude-install-guide', providerLinkLabel('claude-install')],
      ];
    case 'copilot':
      return [
        ['connect-copilot', 'Connect'],
        ['open-copilot-usage', providerLinkLabel('copilot-billing')],
        ['diagnose-copilot', 'Diagnose'],
      ];
    case 'grok':
      return [
        ['open-grok-install-guide', providerLinkLabel('grok-install')],
        ['open-grok-usage', providerLinkLabel('grok-billing')],
        ['copy-grok-usage', localization.t('copyUsageCommand')],
        ['recheck-grok', 'Recheck installation'],
      ];
    default:
      return [['open-provider-settings', 'Provider Settings']];
  }
}

function availableProviderDescription(providerId: string): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  if (
    providerId === 'codex' ||
    providerId === 'claude' ||
    providerId === 'copilot' ||
    providerId === 'grok'
  )
    return localizedProviderGuidance(providerId, catalog).summary;
  if (providerId === 'claude') return getProviderInstallGuidance('claude').summary;
  switch (providerId) {
    case 'codex':
      return getProviderInstallGuidance('codex').summary;
    case 'claude':
      return 'Claude CLI: official status-line metrics · CLI-free usage: experimental account-limit source.';
    case 'copilot':
      return getProviderInstallGuidance('copilot').summary;
    case 'grok':
      return `${getProviderInstallGuidance('grok').summary} Free accounts may not expose numeric usage.`;
    default:
      return 'Setup is required before automatic usage can be monitored.';
  }
}

function dashboardStateLabel(
  snapshot: ProviderSnapshot,
  presentation: ProviderPresentationState,
  hasNumeric: boolean,
): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  if (snapshot.availability === 'rate-limited-experimental')
    return catalog.rateLimitedShowingLastKnownUsage;
  if (snapshot.availability === 'stale-experimental') return catalog.staleShowingLastKnownUsage;
  return catalog[presentation.statusKey];
  /* istanbul ignore next -- retained legacy state mapping for source compatibility. */
  // eslint-disable-next-line no-unreachable
  if (snapshot.availability === 'rate-limited-experimental')
    return 'rate-limited — showing last known usage';
  if (snapshot.availability === 'stale-experimental')
    return 'Stale data — showing last known usage';
  if (snapshot.availability === 'ready-experimental') return 'Ready';
  if (
    snapshot.availability === 'connected-no-billing-method' &&
    snapshot.providerId.toLowerCase().includes('grok')
  )
    return 'Free — no numeric usage';
  switch (presentation.normalizedState) {
    case 'ready':
      return 'Ready';
    case 'stale':
      return 'Stale';
    case 'rate-limited':
      return 'Rate limited';
    case 'authentication-required':
      return 'Authentication required';
    case 'cli-not-installed':
      return 'CLI not installed';
    case 'integration-disabled':
      return 'Disabled';
    case 'setup-required':
      return 'Setup required';
    case 'no-numeric-usage':
      return hasNumeric
        ? 'Ready'
        : snapshot.providerId.toLowerCase().includes('grok')
          ? 'Free — no numeric usage'
          : 'No numeric usage';
    case 'experimental':
      return 'Ready';
    case 'startup-error':
      return 'Startup error';
    case 'error':
      return 'Error';
    case 'not-selected':
      return 'Not selected';
    default:
      return 'Setup required';
  }
}

function sourceBadgeLabel(sourceKind: ProviderPresentationState['sourceKind']): string {
  const catalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto');
  if (sourceKind === 'official') return catalog.official;
  if (sourceKind === 'experimental-documented' || sourceKind === 'experimental-undocumented')
    return catalog.experimental;
  if (sourceKind === 'community') return catalog.community;
  return catalog.sourceUnavailable;
  /* istanbul ignore next -- retained legacy source mapping for source compatibility. */
  // eslint-disable-next-line no-unreachable
  switch (sourceKind) {
    case 'official':
      return 'Official';
    case 'experimental-documented':
    case 'experimental-undocumented':
      return 'Experimental';
    case 'community':
      return 'Community';
    default:
      return 'Source unavailable';
  }
}

function defaultSourceKind(
  descriptor: ProviderCapabilityDescriptor,
): ProviderPresentationState['sourceKind'] {
  const stability = descriptor.automaticUsageCapabilities[0]?.sourceStability;
  switch (stability) {
    case 'official':
      return 'official';
    case 'experimental-documented':
      return 'experimental-documented';
    case 'experimental-undocumented':
      return 'experimental-undocumented';
    case 'community':
      return 'community';
    default:
      return 'none';
  }
}

function uniqueUsageWindows(snapshot: ProviderSnapshot): ProviderSnapshot['usageWindows'] {
  const seen = new Set<string>();
  return snapshot.usageWindows.filter((window) => {
    const key = String(window.id || window.label || 'window');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function copilotProgressWindow(
  snapshot: ProviderSnapshot,
): ProviderSnapshot['usageWindows'][number] | undefined {
  const allowance = finiteMetadataNumber(snapshot.credits?.allowance);
  const used = finiteMetadataNumber(snapshot.credits?.used);
  if (allowance === undefined || allowance <= 0) return undefined;
  const sourceWindow = uniqueUsageWindows(snapshot).find((window) =>
    isFiniteNumber(window.usedPercent),
  );
  if (sourceWindow) return sourceWindow;
  if (used === undefined) return undefined;
  return {
    id: 'monthly-ai-credits',
    label: 'Monthly AI credits',
    usedPercent: (used / allowance) * 100,
    remainingPercent: 100 - (used / allowance) * 100,
    resetsAt: null,
    windowDurationMinutes: null,
  };
}

function copilotMetricTiles(snapshot: ProviderSnapshot): string {
  const meta = snapshot.metadata ?? {};
  const metrics: Array<readonly [string, number | undefined]> = [
    [
      'AI credits',
      finiteMetadataNumber(snapshot.credits?.used) ??
        finiteMetadataNumber(meta.aiCreditsUsed) ??
        finiteMetadataNumber(meta.premiumInteractionsCreditsUsed),
    ],
    ['Premium interactions', finiteMetadataNumber(meta.premiumInteractionsCreditsUsed)],
    ['Chat quota', finiteMetadataNumber(meta.chatCreditsUsed)],
    ['Completions quota', finiteMetadataNumber(meta.completionsCreditsUsed)],
  ];
  return metrics
    .filter(([, value]) => value !== undefined)
    .map(
      ([label, value]) =>
        `<div class="metric-tile"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatSafeNumber(value))}</dd></div>`,
    )
    .join('');
}

function displayWindowLabel(
  providerId: string,
  window: ProviderSnapshot['usageWindows'][number],
  catalog: UiTextCatalog = getUiTextCatalog(dashboardRenderSettings.language ?? 'auto'),
): string {
  if (providerId === 'claude')
    return `${catalog.accountLimit} — ${localizedRateLimitWindowLabel(window.id, window.label, window.windowDurationMinutes, catalog)}`;
  if (rateLimitWindowKind(window.id, window.label, window.windowDurationMinutes) !== 'unknown')
    return localizedRateLimitWindowLabel(
      window.id,
      window.label,
      window.windowDurationMinutes,
      catalog,
    );
  return String(window.id || '')
    .trim()
    .toLowerCase() === 'primary'
    ? catalog.primaryWindow
    : catalog.usageWindowGeneric;
}

export function clampPercentage(value: number): number {
  return clampRemainingPercentage(value);
}

export function renderUsageProgress(
  providerName: string,
  window: ProviderSnapshot['usageWindows'][number],
): string {
  return renderDashboardProgressWindow(providerName, 'provider', window);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteMetadataNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function validTimestamp(value: unknown): number | undefined {
  return isFiniteNumber(value) && value > 0 && new Date(value).getTime() === value
    ? value
    : undefined;
}

function validMetadataTimestamp(value: unknown): number | undefined {
  return validTimestamp(value);
}

function formatDate(
  value: number | undefined,
  role: 'past-event' | 'future-target' | 'deadline' | 'snapshot-age' = 'snapshot-age',
): string {
  return formatConfiguredTime(
    value,
    Date.now(),
    dashboardRenderSettings.timeFormat ?? 'both',
    getUiTextCatalog(dashboardRenderSettings.language ?? 'auto'),
    role,
  );
}

function safeText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return typeof value === 'number' && !Number.isFinite(value) ? undefined : String(value);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function safeMetadataValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  return String(value);
}

function cliLineText(snapshot: ProviderSnapshot, catalog: UiTextCatalog): string {
  const accessMode = snapshot.metadata?.accessMode;
  if (accessMode === 'standalone-cli' || accessMode === 'hybrid')
    return snapshot.cliVersion ?? catalog.detected;
  if (accessMode === 'vscode-extension') return catalog.cliNotInstalledOptional;
  return catalog.notProvided;
}

function accessModeDisplay(snapshot: ProviderSnapshot, catalog: UiTextCatalog): string {
  const accessMode = String(snapshot.metadata?.accessMode ?? '');
  if (accessMode === 'vscode-extension') return catalog.vscodeExtensionMode;
  if (accessMode === 'standalone-cli') return catalog.cli;
  if (accessMode === 'hybrid') return `${catalog.vscodeExtensionMode} + ${catalog.cli}`;
  if (accessMode === 'unavailable') return catalog.notDetected;
  return catalog.notProvided;
}

function formatSafeNumber(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'Not provided' : value.toLocaleString();
}
