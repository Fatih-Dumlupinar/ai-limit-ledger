import type { ProviderAvailability, ProviderId, ProviderSnapshot, ProviderSource } from './types';
import type { LocalizationKey, TranslationParams } from '../localization/LocalizationKeys';

export const CANONICAL_PROVIDER_IDS = ['codex', 'claude', 'copilot', 'grok'] as const;

export type DataSourceStability =
  'official' | 'experimental-documented' | 'experimental-undocumented' | 'community';

export type ProviderInstallationState =
  'installed' | 'partially-installed' | 'not-installed' | 'unknown';

export type ProviderConnectionState =
  'connected' | 'authentication-required' | 'disconnected' | 'not-applicable' | 'unknown';

export type ProviderDataAvailability =
  | 'numeric-current'
  | 'numeric-stale'
  | 'numeric-last-known-good'
  | 'no-numeric-usage'
  | 'not-yet-available'
  | 'unavailable';

export type ProviderSourceKind =
  'official' | 'experimental-documented' | 'experimental-undocumented' | 'community' | 'none';

export type NormalizedProviderState =
  | 'ready'
  | 'stale'
  | 'rate-limited'
  | 'authentication-required'
  | 'cli-not-installed'
  | 'integration-disabled'
  | 'not-selected'
  | 'no-numeric-usage'
  | 'setup-required'
  | 'experimental'
  | 'startup-error'
  | 'error';

export type ProviderCliRole = 'required' | 'optional' | 'not-used';

export interface UsageCapabilityDescriptor {
  id: string;
  sourceStability: DataSourceStability;
  requiresCli: boolean;
  requiresVsCodeExtension: boolean;
  requiresExplicitConsent: boolean;
  canProvideNumericUsage: boolean;
}

export interface ProviderCapabilityDescriptor {
  providerId: ProviderId;
  displayName: string;
  automaticUsageCapabilities: readonly UsageCapabilityDescriptor[];
  cliRole: ProviderCliRole;
  supportsNumericUsage: boolean;
  supportsManualUsagePage: boolean;
}

/**
 * Static product facts. Runtime installation, authentication and data availability deliberately
 * do not live here; they are evaluated by `resolveProviderPresentation` below.
 */
export const PROVIDER_CAPABILITY_DESCRIPTORS: readonly ProviderCapabilityDescriptor[] = [
  {
    providerId: 'codex',
    displayName: 'Codex',
    automaticUsageCapabilities: [
      {
        id: 'codex-app-server-rate-limits',
        sourceStability: 'official',
        requiresCli: true,
        requiresVsCodeExtension: false,
        requiresExplicitConsent: false,
        canProvideNumericUsage: true,
      },
    ],
    cliRole: 'required',
    supportsNumericUsage: true,
    supportsManualUsagePage: true,
  },
  {
    providerId: 'claude',
    displayName: 'Claude Code',
    automaticUsageCapabilities: [
      {
        id: 'claude-status-line',
        sourceStability: 'official',
        requiresCli: true,
        requiresVsCodeExtension: false,
        requiresExplicitConsent: false,
        canProvideNumericUsage: true,
      },
      {
        id: 'claude-oauth-usage',
        sourceStability: 'experimental-undocumented',
        requiresCli: false,
        requiresVsCodeExtension: false,
        requiresExplicitConsent: true,
        canProvideNumericUsage: true,
      },
    ],
    cliRole: 'optional',
    supportsNumericUsage: true,
    supportsManualUsagePage: true,
  },
  {
    providerId: 'copilot',
    displayName: 'GitHub Copilot',
    automaticUsageCapabilities: [
      {
        id: 'copilot-billing-api',
        sourceStability: 'official',
        requiresCli: false,
        requiresVsCodeExtension: false,
        requiresExplicitConsent: false,
        canProvideNumericUsage: true,
      },
      {
        id: 'copilot-entitlement-api',
        sourceStability: 'experimental-undocumented',
        requiresCli: false,
        requiresVsCodeExtension: false,
        requiresExplicitConsent: true,
        canProvideNumericUsage: true,
      },
    ],
    cliRole: 'optional',
    supportsNumericUsage: true,
    supportsManualUsagePage: true,
  },
  {
    providerId: 'grok',
    displayName: 'Grok',
    automaticUsageCapabilities: [
      {
        id: 'grok-acp-billing',
        sourceStability: 'official',
        requiresCli: true,
        requiresVsCodeExtension: false,
        requiresExplicitConsent: false,
        canProvideNumericUsage: true,
      },
      {
        id: 'grok-cli-proxy-billing',
        sourceStability: 'experimental-undocumented',
        requiresCli: true,
        requiresVsCodeExtension: false,
        requiresExplicitConsent: true,
        canProvideNumericUsage: true,
      },
    ],
    cliRole: 'required',
    supportsNumericUsage: true,
    supportsManualUsagePage: true,
  },
] as const;

const ID_ALIASES: Readonly<Record<string, string>> = {
  codex: 'codex',
  'codex-cli': 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  githubCopilot: 'copilot',
  grok: 'grok',
  'grok-build': 'grok',
};

export function normalizeProviderId(providerId: string): string {
  return ID_ALIASES[providerId] ?? ID_ALIASES[providerId.toLowerCase()] ?? providerId;
}

export function getProviderCapabilityDescriptor(
  providerId: string,
): ProviderCapabilityDescriptor | undefined {
  const canonicalId = normalizeProviderId(providerId);
  return PROVIDER_CAPABILITY_DESCRIPTORS.find(
    (descriptor) => descriptor.providerId === canonicalId,
  );
}

export type ProviderLifecyclePhase =
  'not-selected' | 'initializing' | 'started' | 'failed' | 'stopped';

export interface ProviderPresentationInput {
  snapshot: ProviderSnapshot;
  selected?: boolean;
  lifecyclePhase?: ProviderLifecyclePhase;
  wasPreviouslyActive?: boolean;
  now?: number;
  initializationTimeoutMs?: number;
}

export interface LocalizedPresentation {
  statusKey: LocalizationKey;
  statusParams?: TranslationParams;
  explanationKey?: LocalizationKey;
  explanationParams?: TranslationParams;
}

export interface ProviderPresentationOptions {
  selectedProviderIds?: readonly string[];
  lifecycleById?: ReadonlyMap<string, ProviderLifecyclePhase>;
  previouslyActiveProviderIds?: ReadonlySet<string>;
  now?: number;
  initializationTimeoutMs?: number;
}

export interface ProviderPresentationState {
  providerId: string;
  normalizedState: NormalizedProviderState;
  dashboardPlacement: 'active' | 'available' | 'hidden';
  statusBarVisibility: 'visible' | 'hidden';
  attention: 'none' | 'warning' | 'error';
  sourceKind: ProviderSourceKind;
  reasonCode: string;
  installationState: ProviderInstallationState;
  connectionState: ProviderConnectionState;
  dataAvailability: ProviderDataAvailability;
  localized: LocalizedPresentation;
  /** Convenience accessors keep consumers from depending on raw provider messages. */
  statusKey: LocalizationKey;
  statusParams?: TranslationParams;
  explanationKey?: LocalizationKey;
  explanationParams?: TranslationParams;
  selected: boolean;
  descriptor?: ProviderCapabilityDescriptor;
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;

export function resolveProviderPresentations(
  snapshots: readonly ProviderSnapshot[],
  options: ProviderPresentationOptions = {},
): ProviderPresentationState[] {
  const selectedIds = options.selectedProviderIds
    ? new Set(options.selectedProviderIds.map(normalizeProviderId))
    : undefined;
  return snapshots.map((snapshot) => {
    const selected =
      snapshot.availability !== 'not-selected' &&
      (selectedIds?.has(normalizeProviderId(snapshot.providerId)) ??
        snapshot.metadata?.selected !== false);
    return resolveProviderPresentation({
      snapshot,
      selected,
      lifecyclePhase: options.lifecycleById?.get(normalizeProviderId(snapshot.providerId)),
      wasPreviouslyActive: options.previouslyActiveProviderIds?.has(
        normalizeProviderId(snapshot.providerId),
      ),
      now: options.now,
      initializationTimeoutMs: options.initializationTimeoutMs,
    });
  });
}

export function resolveProviderPresentation(
  input: ProviderPresentationInput,
): ProviderPresentationState {
  const snapshot = input.snapshot;
  const providerId = normalizeProviderId(snapshot.providerId);
  const descriptor = getProviderCapabilityDescriptor(providerId);
  const lifecyclePhase =
    input.lifecyclePhase ?? lifecyclePhaseFromMetadata(snapshot.metadata?.lifecyclePhase);
  const selected =
    input.selected ??
    (snapshot.availability !== 'not-selected' &&
      lifecyclePhase !== 'not-selected' &&
      lifecyclePhase !== 'stopped' &&
      snapshot.metadata?.selected !== false);
  const now = input.now ?? Date.now();
  const timeoutMs = input.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
  const timedOut =
    (snapshot.availability === 'initializing' || snapshot.availability === 'loading') &&
    snapshot.checkedAt !== undefined &&
    now - snapshot.checkedAt >= timeoutMs;
  const knownAvailability = asProviderAvailability(snapshot.availability);
  const normalizedState =
    timedOut ||
    (lifecyclePhase === 'failed' &&
      (snapshot.availability === 'initializing' ||
        snapshot.availability === 'loading' ||
        !knownAvailability))
      ? 'startup-error'
      : knownAvailability
        ? normalizeAvailability(knownAvailability, snapshot)
        : 'error';
  const hasNumericUsage = numericUsageIsPresent(snapshot, providerId);
  const sourceKind = sourceKindForSnapshot(snapshot.source, snapshot.metadata);
  const installationState = installationStateFor(snapshot, providerId);
  const connectionState = connectionStateFor(snapshot, selected);
  const dataAvailability = dataAvailabilityFor(
    snapshot,
    normalizedState,
    hasNumericUsage,
    selected,
  );
  const previouslyActive =
    input.wasPreviouslyActive === true ||
    snapshot.connected ||
    hasNumericUsage ||
    hasSuccessfulTimestamp(snapshot) ||
    hasActiveIntegrationState(knownAvailability);
  const active =
    selected &&
    (hasNumericUsage ||
      activeWithoutNumericData(snapshot, normalizedState, knownAvailability) ||
      (previouslyActive && activeProblemState(normalizedState, knownAvailability)));
  const statusBarVisibility =
    selected &&
    (hasNumericUsage ||
      statusBarProblemState(normalizedState, knownAvailability, previouslyActive) ||
      (providerId === 'copilot' && typeof snapshot.credits?.used === 'number'))
      ? 'visible'
      : 'hidden';

  let reasonCode = reasonFor(
    snapshot,
    normalizedState,
    dataAvailability,
    selected,
    timedOut,
    previouslyActive,
  );
  let dashboardPlacement: ProviderPresentationState['dashboardPlacement'] = active
    ? 'active'
    : selected
      ? 'available'
      : 'available';
  if (!descriptor) {
    dashboardPlacement = 'hidden';
    reasonCode = 'unknown-provider';
  }

  const localized = localizedPresentationFor(
    normalizedState,
    dataAvailability,
    snapshot.availability,
  );
  return {
    providerId,
    normalizedState,
    dashboardPlacement,
    statusBarVisibility,
    attention: attentionFor(
      snapshot,
      normalizedState,
      statusBarVisibility === 'visible',
      previouslyActive,
    ),
    sourceKind,
    reasonCode,
    installationState,
    connectionState,
    dataAvailability,
    localized,
    statusKey: localized.statusKey,
    ...(localized.statusParams ? { statusParams: localized.statusParams } : {}),
    ...(localized.explanationKey ? { explanationKey: localized.explanationKey } : {}),
    ...(localized.explanationParams ? { explanationParams: localized.explanationParams } : {}),
    selected,
    descriptor,
  };
}

function localizedPresentationFor(
  normalizedState: NormalizedProviderState,
  dataAvailability: ProviderDataAvailability,
  availability: ProviderAvailability,
): LocalizedPresentation {
  const statusKey: LocalizationKey =
    normalizedState === 'experimental'
      ? 'ready'
      : normalizedState === 'setup-required'
        ? 'setupRequired'
        : normalizedState === 'authentication-required'
          ? 'authenticationRequired'
          : normalizedState === 'cli-not-installed'
            ? 'cliNotInstalled'
            : normalizedState === 'integration-disabled'
              ? 'disabled'
              : normalizedState === 'not-selected'
                ? 'notSelected'
                : normalizedState === 'no-numeric-usage'
                  ? 'noNumericUsage'
                  : normalizedState === 'startup-error'
                    ? 'startupError'
                    : normalizedState === 'rate-limited'
                      ? 'rateLimited'
                      : normalizedState === 'stale'
                        ? 'stale'
                        : normalizedState === 'error'
                          ? 'error'
                          : 'ready';
  const explanationKey: LocalizationKey | undefined =
    availability === 'waiting-for-first-response'
      ? 'waitingForFirstResponse'
      : availability === 'unsupported-surface'
        ? 'claudeUnsupportedSurface'
        : dataAvailability === 'numeric-last-known-good' || dataAvailability === 'numeric-stale'
          ? 'showingLastKnownUsage'
          : dataAvailability === 'no-numeric-usage'
            ? 'numericUsageUnavailable'
            : dataAvailability === 'unavailable'
              ? 'unavailable'
              : availability === 'manual-only'
                ? 'claudeExtensionConnected'
                : undefined;
  return explanationKey ? { statusKey, explanationKey } : { statusKey };
}

export function sourceKindForSnapshot(
  source: ProviderSource | string,
  metadata: ProviderSnapshot['metadata'] = {},
): ProviderSourceKind {
  const accountSource = metadata.accountLimitsSource;
  if (typeof accountSource === 'string' && accountSource.includes('experimental')) {
    return 'experimental-undocumented';
  }
  if (!source || source === 'Not connected') return 'none';
  if (source.startsWith('Experimental')) {
    return source.includes('undocumented')
      ? 'experimental-undocumented'
      : 'experimental-documented';
  }
  if (source.startsWith('Official')) return 'official';
  return 'community';
}

function lifecyclePhaseFromMetadata(value: unknown): ProviderLifecyclePhase | undefined {
  switch (value) {
    case 'not-selected':
    case 'initializing':
    case 'started':
    case 'failed':
    case 'stopped':
      return value;
    default:
      return undefined;
  }
}

function normalizeAvailability(
  availability: ProviderAvailability,
  snapshot: ProviderSnapshot,
): NormalizedProviderState {
  switch (availability) {
    case 'ready':
    case 'ready-calculated':
      return numericUsageIsPresent(snapshot, normalizeProviderId(snapshot.providerId))
        ? 'ready'
        : 'no-numeric-usage';
    case 'ready-experimental':
      return 'experimental';
    case 'stale':
    case 'stale-experimental':
      return 'stale';
    case 'rate-limited':
    case 'rate-limited-experimental':
      return 'rate-limited';
    case 'authentication-required':
      return 'authentication-required';
    case 'cli-not-installed':
      return 'cli-not-installed';
    case 'integration-disabled':
    case 'disabled':
      return 'integration-disabled';
    case 'not-selected':
      return 'not-selected';
    case 'organization-managed':
    case 'connected-no-billing-method':
      return 'no-numeric-usage';
    case 'integration-required':
    case 'manual-only':
    case 'consent-required':
    case 'plan-configuration-required':
    case 'cli-detected':
    case 'extension-detected':
    case 'method-not-supported':
    case 'initializing':
    case 'loading':
    case 'waiting-for-first-response':
      return 'setup-required';
    case 'startup-error':
      return 'startup-error';
    case 'unavailable':
      return snapshot.errorCategory === 'executable-not-found' ? 'cli-not-installed' : 'error';
    case 'restart-required':
    case 'configuration-shadowed':
    case 'repair-required':
    case 'incompatible-cli':
    case 'external-change':
    case 'upstream-statusline-not-invoked':
    case 'unsupported-surface':
    case 'warning':
    case 'critical':
    case 'error':
      return 'error';
    default:
      return assertNever(availability);
  }
}

function dataAvailabilityFor(
  snapshot: ProviderSnapshot,
  normalizedState: NormalizedProviderState,
  hasNumericUsage: boolean,
  selected: boolean,
): ProviderDataAvailability {
  if (!selected) return 'not-yet-available';
  if (hasNumericUsage) {
    if (snapshot.stale || normalizedState === 'stale' || normalizedState === 'rate-limited') {
      return hasSuccessfulTimestamp(snapshot) ? 'numeric-last-known-good' : 'numeric-stale';
    }
    return 'numeric-current';
  }
  if (
    normalizedState === 'error' ||
    normalizedState === 'startup-error' ||
    normalizedState === 'cli-not-installed'
  ) {
    return 'unavailable';
  }
  if (normalizedState === 'no-numeric-usage') return 'no-numeric-usage';
  return 'not-yet-available';
}

function installationStateFor(
  snapshot: ProviderSnapshot,
  providerId: string,
): ProviderInstallationState {
  const cliInstalled = snapshot.metadata?.cliInstalled;
  if (
    snapshot.availability === 'cli-not-installed' ||
    cliInstalled === false ||
    snapshot.errorCategory === 'executable-not-found'
  ) {
    const hasCliFreeCapability = providerId === 'claude' || providerId === 'copilot';
    return hasCliFreeCapability && numericUsageIsPresent(snapshot, providerId)
      ? 'partially-installed'
      : 'not-installed';
  }
  if (cliInstalled === true || snapshot.cliVersion !== null) return 'installed';
  if (numericUsageIsPresent(snapshot, providerId)) return 'partially-installed';
  return 'unknown';
}

function connectionStateFor(
  snapshot: ProviderSnapshot,
  selected: boolean,
): ProviderConnectionState {
  if (!selected || snapshot.availability === 'not-selected') return 'not-applicable';
  if (snapshot.connected) return 'connected';
  if (snapshot.availability === 'authentication-required') return 'authentication-required';
  if (
    snapshot.availability === 'integration-disabled' ||
    snapshot.availability === 'disabled' ||
    snapshot.availability === 'manual-only'
  ) {
    return 'not-applicable';
  }
  if (
    snapshot.availability === 'integration-required' ||
    snapshot.availability === 'consent-required' ||
    snapshot.availability === 'cli-not-installed'
  ) {
    return 'disconnected';
  }
  return 'unknown';
}

function numericUsageIsPresent(snapshot: ProviderSnapshot, providerId: string): boolean {
  if (snapshot.usageWindows.length > 0) return true;
  // Copilot's entitlement endpoint can truthfully report a credit count without an allowance.
  // This includes zero; absence is represented by null/undefined, never by a fabricated zero.
  return providerId === 'copilot' && typeof snapshot.credits?.used === 'number';
}

function hasSuccessfulTimestamp(snapshot: ProviderSnapshot): boolean {
  return (
    typeof snapshot.lastSuccessfulDataUpdate === 'number' ||
    typeof snapshot.lastSuccessfulUpdateAt === 'number' ||
    typeof snapshot.metadata?.oauthLastKnownGoodAt === 'number'
  );
}

function activeWithoutNumericData(
  snapshot: ProviderSnapshot,
  normalizedState: NormalizedProviderState,
  availability: ProviderAvailability | undefined,
): boolean {
  if (!snapshot.connected) return false;
  if (availability === 'manual-only' || availability === 'integration-disabled') return false;
  return (
    normalizedState === 'no-numeric-usage' ||
    normalizedState === 'experimental' ||
    availability === 'organization-managed' ||
    availability === 'connected-no-billing-method'
  );
}

function activeProblemState(
  normalizedState: NormalizedProviderState,
  availability: ProviderAvailability | undefined,
): boolean {
  return (
    normalizedState === 'stale' ||
    normalizedState === 'rate-limited' ||
    normalizedState === 'authentication-required' ||
    normalizedState === 'error' ||
    normalizedState === 'startup-error' ||
    availability === 'external-change' ||
    availability === 'repair-required'
  );
}

function statusBarProblemState(
  normalizedState: NormalizedProviderState,
  availability: ProviderAvailability | undefined,
  previouslyActive: boolean,
): boolean {
  if (!previouslyActive) return false;
  if (normalizedState === 'rate-limited' || normalizedState === 'stale') return true;
  return (
    normalizedState === 'authentication-required' ||
    normalizedState === 'error' ||
    normalizedState === 'startup-error' ||
    availability === 'external-change' ||
    availability === 'repair-required'
  );
}

function attentionFor(
  snapshot: ProviderSnapshot,
  normalizedState: NormalizedProviderState,
  visible: boolean,
  previouslyActive: boolean,
): ProviderPresentationState['attention'] {
  if (!visible) return 'none';
  if (
    normalizedState === 'rate-limited' ||
    normalizedState === 'stale' ||
    snapshot.errorCategory === 'rate-limited' ||
    snapshot.errorCategory === 'network-unavailable' ||
    snapshot.errorCategory === 'upstream-unavailable' ||
    snapshot.errorCategory === 'timeout' ||
    snapshot.errorCategory === 'throttled'
  ) {
    return 'warning';
  }
  if (normalizedState === 'authentication-required') return previouslyActive ? 'error' : 'none';
  if (normalizedState === 'error' || normalizedState === 'startup-error') return 'error';
  if (
    snapshot.errorCategory === 'authentication-required' ||
    snapshot.errorCategory === 'authorization-failed' ||
    snapshot.errorCategory === 'security-validation-failed' ||
    snapshot.errorCategory === 'configuration-error' ||
    snapshot.errorCategory === 'process-start-failed'
  ) {
    return previouslyActive ? 'error' : 'none';
  }
  return 'none';
}

function reasonFor(
  snapshot: ProviderSnapshot,
  normalizedState: NormalizedProviderState,
  dataAvailability: ProviderDataAvailability,
  selected: boolean,
  timedOut: boolean,
  previouslyActive: boolean,
): string {
  if (!selected) return 'not-selected';
  if (timedOut) return 'initialization-timeout';
  if (normalizedState === 'cli-not-installed') return 'cli-not-installed';
  if (normalizedState === 'integration-disabled') return 'integration-disabled';
  if (normalizedState === 'authentication-required' && !previouslyActive) {
    return 'authentication-required';
  }
  if (dataAvailability === 'numeric-last-known-good') return 'last-known-good';
  if (dataAvailability === 'numeric-stale') return 'stale-data';
  if (dataAvailability === 'numeric-current') {
    return normalizedState === 'experimental' ? 'experimental-numeric-current' : 'numeric-current';
  }
  if (normalizedState === 'no-numeric-usage') return 'no-numeric-usage';
  if (normalizedState === 'startup-error') return 'startup-error';
  if (normalizedState === 'error') return 'provider-error';
  if (normalizedState === 'setup-required') return 'setup-required';
  if (snapshot.availability === 'initializing') return 'initializing';
  return normalizedState;
}

function hasActiveIntegrationState(availability: ProviderAvailability | undefined): boolean {
  return (
    availability === 'external-change' ||
    availability === 'repair-required' ||
    availability === 'configuration-shadowed' ||
    availability === 'incompatible-cli' ||
    availability === 'upstream-statusline-not-invoked' ||
    availability === 'unsupported-surface'
  );
}

function asProviderAvailability(value: unknown): ProviderAvailability | undefined {
  switch (value) {
    case 'initializing':
    case 'startup-error':
    case 'not-selected':
    case 'loading':
    case 'ready':
    case 'unavailable':
    case 'integration-required':
    case 'integration-disabled':
    case 'restart-required':
    case 'configuration-shadowed':
    case 'repair-required':
    case 'waiting-for-first-response':
    case 'manual-only':
    case 'upstream-statusline-not-invoked':
    case 'unsupported-surface':
    case 'stale':
    case 'incompatible-cli':
    case 'external-change':
    case 'warning':
    case 'critical':
    case 'rate-limited':
    case 'error':
    case 'ready-experimental':
    case 'stale-experimental':
    case 'rate-limited-experimental':
    case 'authentication-required':
    case 'consent-required':
    case 'ready-calculated':
    case 'plan-configuration-required':
    case 'organization-managed':
    case 'cli-detected':
    case 'extension-detected':
    case 'cli-not-installed':
    case 'connected-no-billing-method':
    case 'method-not-supported':
    case 'disabled':
      return value;
    default:
      return undefined;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled provider availability: ${String(value)}`);
}
