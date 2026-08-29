/** Schema for AI Limit Ledger's Claude Code status-line integration. Internal to the Claude provider. */

export type IntegrationMode = 'standalone' | 'chained';

export type EnableOutcome =
  | { kind: 'enabled'; mode: IntegrationMode }
  | { kind: 'cancelled' }
  | { kind: 'unchanged' }
  | { kind: 'error'; message: string };

export type DisableOutcome =
  | { kind: 'disabled' }
  | { kind: 'not-managed' }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

/** Non-sensitive bookkeeping only: no username, email, session id, transcript path, workspace path, OAuth token, or raw Claude JSON. */
export interface OwnershipMetadata {
  schemaVersion: number;
  mode: IntegrationMode;
  wrapperPath: string | null;
  wrapperVersion: number;
  originalStatusLineHash: string | null;
  enabledAt: string;
  ownerMarker: string;
}

/** The full original statusLine object, kept only in SecretStorage. */
export type RecoveryData = { statusLine: unknown } | { statusLine: undefined };

export interface WrapperConfig {
  snapshotPath: string;
  innerCommand: string;
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
  wrapperVersion: number;
}

/**
 * Concrete, machine-readable reasons the integration needs repair. Every reason maps to a
 * specific disk-state check — never derived from cached/in-memory ownership metadata alone.
 */
export type RepairReason =
  | 'statusline-missing'
  | 'wrapper-missing'
  | 'wrapper-outdated'
  | 'configuration-removed'
  | 'post-commit-verification-failed'
  | 'external-change';

/**
 * Overall health, always recomputed from current disk state at diagnose time. Never `ready`
 * when any `RepairReason` applies — recovery metadata or a previously-recorded "owned"
 * classification is never sufficient on its own to report `ready`.
 */
export type IntegrationHealth = 'ready' | 'repair-required' | 'disabled';

export interface DiagnosticsReport {
  claudeCliFound: boolean;
  integrationMode: 'disabled' | IntegrationMode;
  wrapperPresent: boolean;
  wrapperVersion: number | null;
  wrapperHashMatches: boolean | null;
  settingsOwnershipOk: boolean | null;
  /** Whether any scope in the observable precedence chain currently defines a statusLine at all. */
  effectiveStatusLinePresent: boolean;
  integrationHealth: IntegrationHealth;
  repairReasons: RepairReason[];
  recoveryMetadataPresent: boolean;
  snapshotPresent: boolean;
  snapshotSchemaVersion: number | null;
  snapshotAgeSeconds: number | null;
  lastSafeBridgeError: string | null;
  restorePossible: boolean;
  chainingSupportedOnPlatform: boolean;
  /** %USERPROFILE%-masked; never the full path with a real username. */
  resolvedConfigDir: string;
  winningStatusLineScope: 'project-local' | 'project-shared' | 'user' | 'none';
  shadowedByHigherPrecedence: boolean;
  wrapperSelfCheck: 'passed' | 'failed' | 'not-run';
  fiveHourFieldsPresent: boolean;
  sevenDayFieldsPresent: boolean;
  /** The statusLine's own `refreshInterval` (seconds) as currently written to settings.json, if any. */
  effectiveRefreshInterval: number | null;
  /** The snapshot's own embedded write time (wrapper-stamped `observedAt`, ISO-8601), distinct from when this diagnose ran. */
  sourceUpdatedAt: string | null;
  fiveHourRawPercentage: number | null;
  sevenDayRawPercentage: number | null;
  contextRawPercentage: number | null;
  lastWrapperErrorCategory:
    | 'none'
    | 'settings-write-failed'
    | 'wrapper-write-failed'
    | 'self-check-failed'
    | 'verification-failed'
    | 'external-change'
    | 'other';
  recommendedNextAction: string;
  hostKind: 'standalone-cli' | 'vscode-sidebar' | 'both' | 'unknown';
  /** Milliseconds since the integration was last (re-)enabled; null when unknown. */
  msSinceEnabled: number | null;
  /**
   * True when the effective config, ownership, wrapper presence, and self-check all check out,
   * yet no real snapshot exists after the wait timeout — i.e. this Claude Code host surface is
   * not invoking the configured status-line command. When true, reconfiguring the wrapper again
   * will not help; see recommendedNextAction.
   */
  upstreamStatusLineNotInvoked: boolean;
}

export const OWNER_MARKER = 'ai-limit-ledger';
export const CURRENT_SCHEMA_VERSION = 2;
export const CURRENT_WRAPPER_VERSION = 2;
export const LEGACY_MARKER_STRING = 'ai-limit-ledger-status-line-v1';
