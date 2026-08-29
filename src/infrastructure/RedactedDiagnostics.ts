import {
  normalizeProviderId,
  type ProviderPresentationState,
} from '../providers/ProviderCapabilityContract';
import type { ProviderSnapshot } from '../providers/types';
import { SafeLogRedactor } from './redact';
import type { SafeLogRecord } from './Logger';
import { getProviderLinkDiagnosticsSnapshot } from '../links/ProviderLinkService';

export interface RedactedProviderDiagnostic {
  providerId: string;
  selected: boolean;
  dashboardPlacement: ProviderPresentationState['dashboardPlacement'];
  statusBarVisibility: ProviderPresentationState['statusBarVisibility'];
  normalizedState: ProviderPresentationState['normalizedState'];
  attention: ProviderPresentationState['attention'];
  sourceKind: ProviderPresentationState['sourceKind'];
  installationState: ProviderPresentationState['installationState'];
  connectionState: ProviderPresentationState['connectionState'];
  dataAvailability: ProviderPresentationState['dataAvailability'];
  cliFound: boolean;
  cliVersion: string | null;
  extensionDetected: boolean;
  extensionVersion: string | null;
  consent: boolean | null;
  snapshotPresent: boolean;
  snapshotAgeMs: number | null;
  lastCheckedAt: number | null;
  lastKnownGoodAt: number | null;
  backoffUntil: number | null;
  backoffActive: boolean;
  safeErrorCategory: string | null;
  lifecyclePhase: string | null;
  correlationId: string | null;
  autoRepairEnabled: boolean | null;
  wrapperDetected: boolean | null;
  wrapperVersion: string | null;
  wrapperHashMatch: boolean | null;
}

export interface RedactedDashboardDiagnostic {
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
  configuredMode: 'auto' | 'rich-webview' | 'safe-native';
  lastRendererUsed: 'rich-webview' | 'safe-native' | null;
  safeDashboardRegistered: boolean;
  safeDashboardOpen: boolean;
  safeDashboardLastRenderedAt: number | null;
  safeDashboardRenderCount: number;
  lastRichDashboardReadyTimeout: number | null;
  lastFallbackAction: string | null;
}

export interface RedactedDiagnostics {
  schemaVersion: 1;
  generatedAt: string;
  extension: {
    version: string;
    vscodeVersion: string;
    platform: string;
    arch: string;
  };
  providers: RedactedProviderDiagnostic[];
  dashboard?: RedactedDashboardDiagnostic;
  providerLinks?: {
    registryVersion: string;
    definitionCount: number;
    validation: 'passed' | 'failed';
    invalidLinkIds: string[];
    lastOpenedLinkId: string | null;
    lastLinkOpenResult: 'success' | 'error' | null;
  };
}

export interface SafeSupportConfig {
  selectedProviders: string[];
  effectiveSettings?: Record<string, unknown>;
  refresh: {
    manualCooldownSeconds?: number;
    codexFallbackSeconds?: number;
    claudeOAuthSeconds?: number;
  };
}

export interface RedactedSupportBundle extends RedactedDiagnostics {
  configuration: {
    selectedProviders: string[];
    effectiveSettings?: Record<string, unknown>;
    safeRefreshSettings: Record<string, number | boolean | string>;
  };
  recentLogs: readonly SafeLogRecord[];
}

export interface RedactedDiagnosticsOptions {
  now?: number;
  extensionVersion?: string;
  vscodeVersion?: string;
  platform?: string;
  architecture?: string;
  correlationId?: string;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 120 ? value : null;
}

function metadata(snapshot: ProviderSnapshot, key: string): unknown {
  return snapshot.metadata?.[key];
}

export function buildRedactedProviderDiagnostic(
  snapshot: ProviderSnapshot,
  presentation: ProviderPresentationState,
  options: Pick<RedactedDiagnosticsOptions, 'now' | 'correlationId'> = {},
): RedactedProviderDiagnostic {
  const now = options.now ?? Date.now();
  const checkedAt = numberOrNull(snapshot.checkedAt ?? snapshot.observedAt);
  const lastKnownGoodAt = numberOrNull(
    snapshot.lastSuccessfulDataUpdate ??
      snapshot.lastSuccessfulUpdateAt ??
      metadata(snapshot, 'oauthLastKnownGoodAt'),
  );
  const snapshotPresent = snapshot.usageWindows.length > 0 || snapshot.credits !== undefined;
  const backoffUntil = numberOrNull(snapshot.retryAt ?? metadata(snapshot, 'backoffUntil'));
  return {
    providerId: presentation.providerId,
    selected: presentation.selected,
    dashboardPlacement: presentation.dashboardPlacement,
    statusBarVisibility: presentation.statusBarVisibility,
    normalizedState: presentation.normalizedState,
    attention: presentation.attention,
    sourceKind: presentation.sourceKind,
    installationState: presentation.installationState,
    connectionState: presentation.connectionState,
    dataAvailability: presentation.dataAvailability,
    cliFound:
      snapshot.metadata?.cliInstalled !== false && snapshot.availability !== 'cli-not-installed',
    cliVersion: stringOrNull(snapshot.cliVersion),
    extensionDetected:
      snapshot.metadata?.extensionDetected === true || snapshot.extensionVersion != null,
    extensionVersion: stringOrNull(
      snapshot.extensionVersion ?? metadata(snapshot, 'extensionVersion'),
    ),
    consent: booleanOrNull(metadata(snapshot, 'consent')),
    snapshotPresent,
    snapshotAgeMs: checkedAt === null ? null : Math.max(0, now - checkedAt),
    lastCheckedAt: checkedAt,
    lastKnownGoodAt,
    backoffUntil,
    backoffActive: backoffUntil !== null && backoffUntil > now,
    safeErrorCategory: snapshot.errorCategory ?? snapshot.safeErrorCategory ?? null,
    lifecyclePhase: stringOrNull(metadata(snapshot, 'lifecyclePhase')),
    correlationId: options.correlationId ?? stringOrNull(metadata(snapshot, 'correlationId')),
    autoRepairEnabled: booleanOrNull(metadata(snapshot, 'autoRepairEnabled')),
    wrapperDetected: booleanOrNull(metadata(snapshot, 'wrapperDetected')),
    wrapperVersion: stringOrNull(metadata(snapshot, 'wrapperVersion')),
    wrapperHashMatch: booleanOrNull(metadata(snapshot, 'wrapperHashMatch')),
  };
}

export function buildRedactedDiagnostics(
  snapshots: readonly ProviderSnapshot[],
  presentations: readonly ProviderPresentationState[],
  options: RedactedDiagnosticsOptions = {},
): RedactedDiagnostics {
  const providerLinkDiagnostics = getProviderLinkDiagnosticsSnapshot();
  const presentationById = new Map(
    presentations.map((presentation) => [
      normalizeProviderId(presentation.providerId),
      presentation,
    ]),
  );
  const providerDiagnostics = snapshots
    .map((snapshot) => presentationById.get(normalizeProviderId(snapshot.providerId)))
    .map((presentation, index) =>
      presentation
        ? buildRedactedProviderDiagnostic(snapshots[index], presentation, options)
        : undefined,
    )
    .filter((diagnostic): diagnostic is RedactedProviderDiagnostic => diagnostic !== undefined)
    .sort((left, right) => left.providerId.localeCompare(right.providerId));

  return {
    schemaVersion: 1,
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    extension: {
      version: options.extensionVersion ?? 'unknown',
      vscodeVersion: options.vscodeVersion ?? 'unknown',
      platform: options.platform ?? 'unknown',
      arch: options.architecture ?? 'unknown',
    },
    providers: providerDiagnostics,
    providerLinks: {
      ...providerLinkDiagnostics,
      invalidLinkIds: [...providerLinkDiagnostics.invalidLinkIds],
    },
  };
}

export function buildRedactedSupportBundle(
  diagnostics: RedactedDiagnostics,
  config: SafeSupportConfig,
  recentLogs: readonly SafeLogRecord[],
): RedactedSupportBundle {
  const redactor = new SafeLogRedactor();
  const logs = recentLogs.slice(-200).map((record) => {
    const safe = { ...record, message: redactor.redact(record.message) };
    return safe;
  });
  return {
    ...diagnostics,
    configuration: {
      selectedProviders: config.selectedProviders.filter((providerId) =>
        ['codex', 'claude', 'copilot', 'grok'].includes(providerId),
      ),
      ...(config.effectiveSettings ? { effectiveSettings: config.effectiveSettings } : {}),
      safeRefreshSettings: {
        ...(typeof config.refresh.manualCooldownSeconds === 'number'
          ? { manualCooldownSeconds: config.refresh.manualCooldownSeconds }
          : {}),
        ...(typeof config.refresh.codexFallbackSeconds === 'number'
          ? { codexFallbackSeconds: config.refresh.codexFallbackSeconds }
          : {}),
        ...(typeof config.refresh.claudeOAuthSeconds === 'number'
          ? { claudeOAuthSeconds: config.refresh.claudeOAuthSeconds }
          : {}),
      },
    },
    recentLogs: logs,
  };
}

export function serializeRedacted(value: unknown): string {
  try {
    const redactor = new SafeLogRedactor();
    return redactor.redact(JSON.stringify(value));
  } catch {
    return '{"schemaVersion":1,"error":"[redacted]"}';
  }
}

export interface AtomicWriter {
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink?(path: string): Promise<void>;
}

export async function writeRedactedSupportBundleAtomically(
  writer: AtomicWriter,
  targetPath: string,
  bundle: RedactedSupportBundle,
  temporaryPath: string,
): Promise<void> {
  const contents = `${serializeRedacted(bundle)}\n`;
  try {
    await writer.writeFile(temporaryPath, contents, 'utf8');
    await writer.rename(temporaryPath, targetPath);
  } catch (error) {
    try {
      await writer.unlink?.(temporaryPath);
    } catch {
      // The original write/rename error is the useful result for the caller.
    }
    throw error;
  }
}
