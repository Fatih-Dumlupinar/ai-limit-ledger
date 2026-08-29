import type { IntegrationMode, OwnershipMetadata } from './types';

/** Matches the shape of vscode.SecretStorage without importing 'vscode'. */
export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Matches the shape of vscode.Memento without importing 'vscode'. */
export interface GlobalStateLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

const SECRET_KEY = 'aiLimitLedger.claude.recoveryStatusLine';
const OWNERSHIP_KEY = 'aiLimitLedger.claude.ownership';
const ENABLED_KEY = 'aiLimitLedger.claudeEnabled';
const EXPLICITLY_DISABLED_KEY = 'aiLimitLedger.claudeExplicitlyDisabled';
const LEGACY_PREVIOUS_KEY = 'aiLimitLedger.previousClaudeStatusLine';
const LAST_ERROR_KEY = 'aiLimitLedger.claude.lastError';
const AWAITING_RESTART_KEY = 'aiLimitLedger.claude.awaitingSessionRestart';
const CONSENT_KEY = 'aiLimitLedger.claude.autoRepairConsent';
const LAST_SEEN_EXTENSION_VERSION_KEY = 'aiLimitLedger.claude.lastSeenExtensionVersion';
const AUTO_HEAL_ATTEMPT_KEY = 'aiLimitLedger.claude.autoHealAttempt';
const OAUTH_USAGE_CONSENT_KEY = 'aiLimitLedger.claude.experimentalOAuthUsage.consent';
const OAUTH_USAGE_LAST_KNOWN_GOOD_KEY = 'aiLimitLedger.claude.experimentalOAuthUsage.lastKnownGood';

export const CONSENT_VERSION = 1;
export const OAUTH_USAGE_CONSENT_VERSION = 1;
export const OAUTH_USAGE_TRANSPORT_VERSION = 1;

/**
 * Non-sensitive record of the user's one-time opt-in to automatic repair. No token, credential,
 * transcript, or Claude-specific data — only bookkeeping about the consent decision itself.
 */
export interface ConsentMetadata {
  consentVersion: number;
  consentTimestamp: string;
  integrationMode: IntegrationMode;
  expectedWrapperVersion: number;
}

export async function saveConsent(
  globalState: GlobalStateLike,
  metadata: ConsentMetadata,
): Promise<void> {
  await globalState.update(CONSENT_KEY, metadata);
}

export function loadConsent(globalState: GlobalStateLike): ConsentMetadata | undefined {
  return globalState.get<ConsentMetadata | undefined>(CONSENT_KEY, undefined);
}

export function loadLastSeenExtensionVersion(globalState: GlobalStateLike): string | undefined {
  return globalState.get<string | undefined>(LAST_SEEN_EXTENSION_VERSION_KEY, undefined);
}

export async function saveLastSeenExtensionVersion(
  globalState: GlobalStateLike,
  version: string,
): Promise<void> {
  await globalState.update(LAST_SEEN_EXTENSION_VERSION_KEY, version);
}

/** Persisted single-flight/backoff/history bookkeeping for the auto-heal runner. */
export interface AutoHealAttemptState {
  reason: string;
  attemptCount: number;
  lastAttemptAt: number;
  backoffUntil: number;
  lastHealthCheckAt: number;
  lastSuccessAt: number | null;
  lastRepairReason: string | null;
}

export function loadAutoHealAttempt(
  globalState: GlobalStateLike,
): AutoHealAttemptState | undefined {
  return globalState.get<AutoHealAttemptState | undefined>(AUTO_HEAL_ATTEMPT_KEY, undefined);
}

export async function saveAutoHealAttempt(
  globalState: GlobalStateLike,
  state: AutoHealAttemptState,
): Promise<void> {
  await globalState.update(AUTO_HEAL_ATTEMPT_KEY, state);
}

interface StoredRecovery {
  present: boolean;
  statusLine?: unknown;
}

/** Stores the original statusLine value (sensitive: may embed paths/commands) so disable can restore it. */
export async function saveRecovery(secrets: SecretsLike, statusLine: unknown): Promise<void> {
  const record: StoredRecovery =
    statusLine === undefined ? { present: false } : { present: true, statusLine };
  await secrets.store(SECRET_KEY, JSON.stringify(record));
}

export async function loadRecovery(secrets: SecretsLike): Promise<StoredRecovery | undefined> {
  const raw = await secrets.get(SECRET_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StoredRecovery;
  } catch {
    return undefined;
  }
}

export async function clearRecovery(secrets: SecretsLike): Promise<void> {
  await secrets.delete(SECRET_KEY);
}

/** Non-sensitive ownership bookkeeping: no username, email, session id, transcript/workspace path, token, or raw JSON. */
export async function saveOwnership(
  globalState: GlobalStateLike,
  metadata: OwnershipMetadata,
): Promise<void> {
  await globalState.update(OWNERSHIP_KEY, metadata);
}

export function loadOwnership(globalState: GlobalStateLike): OwnershipMetadata | undefined {
  return globalState.get<OwnershipMetadata | undefined>(OWNERSHIP_KEY, undefined);
}

export async function clearOwnership(globalState: GlobalStateLike): Promise<void> {
  await globalState.update(OWNERSHIP_KEY, undefined);
}

export function isEnabled(globalState: GlobalStateLike): boolean {
  return globalState.get<boolean>(ENABLED_KEY, false);
}

export async function setEnabled(globalState: GlobalStateLike, value: boolean): Promise<void> {
  await globalState.update(ENABLED_KEY, value);
}

export function isExplicitlyDisabled(globalState: GlobalStateLike): boolean {
  return globalState.get<boolean>(EXPLICITLY_DISABLED_KEY, false);
}

export async function setExplicitlyDisabled(
  globalState: GlobalStateLike,
  value: boolean,
): Promise<void> {
  await globalState.update(EXPLICITLY_DISABLED_KEY, value || undefined);
}

/** 0.3.1 fallback: the old flow stashed the previous statusLine directly in global state. */
export function readLegacyPrevious(globalState: GlobalStateLike): unknown {
  return globalState.get<unknown>(LEGACY_PREVIOUS_KEY, undefined);
}

export async function clearLegacyPrevious(globalState: GlobalStateLike): Promise<void> {
  await globalState.update(LEGACY_PREVIOUS_KEY, undefined);
}

/** Stores only the redacted, user-safe error text from the last enable/disable/repair attempt — never a raw command or path. */
export async function saveLastError(
  globalState: GlobalStateLike,
  message: string | null,
): Promise<void> {
  await globalState.update(LAST_ERROR_KEY, message ?? undefined);
}

export function loadLastError(globalState: GlobalStateLike): string | null {
  return globalState.get<string | null>(LAST_ERROR_KEY, null);
}

/**
 * True once enable/repair has run and no real snapshot has yet proven the running Claude
 * session picked up the change — never assume a session reloaded just because settings were
 * written.
 */
export function isAwaitingSessionRestart(globalState: GlobalStateLike): boolean {
  return globalState.get<boolean>(AWAITING_RESTART_KEY, false);
}

export async function setAwaitingSessionRestart(
  globalState: GlobalStateLike,
  value: boolean,
): Promise<void> {
  await globalState.update(AWAITING_RESTART_KEY, value || undefined);
}

/**
 * Non-sensitive record of the user's one-time, separate opt-in to the experimental CLI-free
 * (OAuth) usage transport. Never the token, a token hash, an account id, or an email — only
 * bookkeeping about the consent decision itself, mirroring `ConsentMetadata` above.
 */
export interface OAuthUsageConsentMetadata {
  consentVersion: number;
  acceptedAt: string;
  transportVersion: number;
}

export async function saveOAuthUsageConsent(
  globalState: GlobalStateLike,
  metadata: OAuthUsageConsentMetadata,
): Promise<void> {
  await globalState.update(OAUTH_USAGE_CONSENT_KEY, metadata);
}

export function loadOAuthUsageConsent(
  globalState: GlobalStateLike,
): OAuthUsageConsentMetadata | undefined {
  return globalState.get<OAuthUsageConsentMetadata | undefined>(OAUTH_USAGE_CONSENT_KEY, undefined);
}

export async function clearOAuthUsageConsent(globalState: GlobalStateLike): Promise<void> {
  await globalState.update(OAUTH_USAGE_CONSENT_KEY, undefined);
}

/**
 * The last successfully observed 5h/7d percentages from the experimental OAuth transport —
 * percentages and timestamps only, never a token, never the raw response. Shown, marked stale,
 * during a 429 pause or a transient failure so the dashboard never has to fall back to nothing.
 */
export interface OAuthUsageLastKnownGood {
  fiveHourUsedPercent: number | null;
  fiveHourResetsAt: number | null;
  sevenDayUsedPercent: number | null;
  sevenDayResetsAt: number | null;
  capturedAt: number;
}

export async function saveOAuthUsageLastKnownGood(
  globalState: GlobalStateLike,
  snapshot: OAuthUsageLastKnownGood,
): Promise<void> {
  await globalState.update(OAUTH_USAGE_LAST_KNOWN_GOOD_KEY, snapshot);
}

export function loadOAuthUsageLastKnownGood(
  globalState: GlobalStateLike,
): OAuthUsageLastKnownGood | undefined {
  return globalState.get<OAuthUsageLastKnownGood | undefined>(
    OAUTH_USAGE_LAST_KNOWN_GOOD_KEY,
    undefined,
  );
}

export {
  ENABLED_KEY,
  EXPLICITLY_DISABLED_KEY,
  OWNERSHIP_KEY,
  SECRET_KEY,
  LEGACY_PREVIOUS_KEY,
  LAST_ERROR_KEY,
  AWAITING_RESTART_KEY,
  CONSENT_KEY,
  LAST_SEEN_EXTENSION_VERSION_KEY,
  AUTO_HEAL_ATTEMPT_KEY,
  OAUTH_USAGE_CONSENT_KEY,
  OAUTH_USAGE_LAST_KNOWN_GOOD_KEY,
};
