import type { ClaudeAccessMode } from './ClaudeAccessMode';
import type { ClaudeHostKind } from './ClaudeHostDetection';
import type { ClaudeUsageCapability } from './ClaudeUsageCapability';
import type { ProviderAvailability } from '../types';

/** How long right after enable/repair we still show restart-required before softening. */
export const RESTART_GRACE_MS = 90_000;
/** How long a CLI-capable host waits for a first snapshot before escalating to a diagnostic state. */
export const WAITING_TIMEOUT_MS = 15 * 60_000;
/**
 * Extension-only mode gets a much shorter grace period. There is no CLI to fall back on, and
 * many VS Code-extension hosts never invoke the documented status-line command at all — waiting
 * 15 minutes would just leave the user staring at "waiting" for something that isn't coming.
 */
export const EXTENSION_ONLY_GRACE_MS = 2 * 60_000;

export interface ClaudeStateInputs {
  cliFound: boolean;
  /** null when compatibility cannot be determined — never treated as incompatible. */
  cliVersionCompatible: boolean | null;
  /** Whether the user has opted into automatic status-line tracking. */
  enabled: boolean;
  /** True only after an explicit successful Disable command. */
  explicitlyDisabled?: boolean;
  /** Whether the effective statusLine (after precedence) structurally targets our wrapper. */
  ownedEffective: boolean;
  /** True when any observable scope currently defines a statusLine at all (present, whether ours or not). */
  effectiveStatusLinePresent: boolean;
  /** True when a higher-precedence project statusLine shadows what we configured at user scope. */
  shadowedByProject: boolean;
  /** False when the effective statusLine targets our wrapper but the wrapper file is missing, or is present but stale (its content no longer matches the current generator). */
  wrapperExists: boolean;
  /** True once a real, schema-valid snapshot with at least one usage window has been observed. */
  hasValidSnapshot: boolean;
  /** True when the most recent valid snapshot is older than the staleness threshold. */
  snapshotStale: boolean;
  /** True when enable/repair just ran and no real snapshot has proven the session reloaded yet. */
  awaitingSessionRestart: boolean;
  /** Milliseconds since the integration was last (re-)enabled; null when unknown. */
  msSinceEnabled: number | null;
  hostKind: ClaudeHostKind;
  accessMode: ClaudeAccessMode;
}

export interface ClaudeState {
  availability: ProviderAvailability;
  capability: ClaudeUsageCapability;
}

/**
 * Precedence chain for the Claude provider's user-facing state. The key 0.3.5 correction: a
 * user who has never opted into (or whose host never fulfills) automatic status-line tracking
 * is not "broken" or "waiting" — they land in `manual-only`, a supported, non-error mode. Only
 * CLI-capable hosts (`standalone-cli`/`hybrid`) still use the longer wait + diagnostic-state
 * escalation from 0.3.4; extension-only hosts get a short grace period and then settle into
 * `manual-only` instead of waiting indefinitely or looking unsupported.
 */
export function computeClaudeState(inputs: ClaudeStateInputs): ClaudeState {
  if (inputs.accessMode === 'unavailable') {
    return { availability: 'unavailable', capability: 'not-available' };
  }
  if (inputs.cliVersionCompatible === false) {
    return { availability: 'incompatible-cli', capability: 'not-available' };
  }
  if (inputs.hasValidSnapshot) {
    return inputs.snapshotStale
      ? { availability: 'stale', capability: 'automatic-checking' }
      : { availability: 'ready', capability: 'automatic-live' };
  }
  if (!inputs.enabled) {
    if (inputs.explicitlyDisabled)
      return { availability: 'integration-disabled', capability: 'manual-only' };
    // Automatic tracking was never turned on. The extension/CLI is still fully connected and
    // usable — this is a default, supported mode, not a setup requirement.
    return { availability: 'manual-only', capability: 'manual-only' };
  }
  // Shadowing/external-change/missing-or-stale-wrapper are genuine, fixable configuration
  // problems — distinct from a host that simply never invokes the status line — so they still
  // surface directly rather than being folded into manual-only.
  if (inputs.shadowedByProject) {
    return { availability: 'configuration-shadowed', capability: 'manual-only' };
  }
  if (!inputs.ownedEffective) {
    // A foreign statusLine still present (another tool took over) is a genuine external change;
    // no effective statusLine at all (dropped entirely, e.g. by an external settings rewrite) is
    // a repair, not a takeover — Enable/Repair reinstalls it outright rather than prompting the
    // "existing statusLine" choice.
    return inputs.effectiveStatusLinePresent
      ? { availability: 'external-change', capability: 'manual-only' }
      : { availability: 'repair-required', capability: 'manual-only' };
  }
  if (!inputs.wrapperExists) {
    return { availability: 'repair-required', capability: 'manual-only' };
  }

  const elapsed = inputs.msSinceEnabled;
  const graceMs =
    inputs.accessMode === 'vscode-extension' ? EXTENSION_ONLY_GRACE_MS : RESTART_GRACE_MS;
  if (elapsed === null) {
    return inputs.awaitingSessionRestart
      ? { availability: 'restart-required', capability: 'automatic-checking' }
      : { availability: 'manual-only', capability: 'manual-only' };
  }
  if (elapsed < graceMs) {
    return { availability: 'restart-required', capability: 'automatic-checking' };
  }
  if (inputs.accessMode === 'vscode-extension') {
    // Grace period elapsed with no snapshot: this host is not invoking the status line. Fall
    // back cleanly to manual-only rather than waiting further or presenting this as broken.
    return { availability: 'manual-only', capability: 'manual-only' };
  }
  if (elapsed < WAITING_TIMEOUT_MS) {
    return { availability: 'waiting-for-first-response', capability: 'automatic-checking' };
  }
  // CLI-capable host, full timeout elapsed, everything we control checks out — this is an
  // upstream (Anthropic-side) behavior on this host, not something re-enabling can fix.
  return { availability: 'upstream-statusline-not-invoked', capability: 'manual-only' };
}
