import type { DiagnosticsReport } from './types';

/**
 * Finer-grained health taxonomy for the Claude Code auto-heal feature. Distinct from
 * `IntegrationHealth`/`RepairReason` (used by the manual diagnose/repair flow) because auto-heal
 * must distinguish cases that are safe to fix without asking from cases that must always stop and
 * ask, even though both may look like "repair-required" to the manual flow.
 */
export type AutoHealState =
  | 'healthy'
  | 'wrapper-missing'
  | 'wrapper-outdated'
  | 'wrapper-corrupt'
  | 'statusline-missing'
  | 'refresh-interval-mismatch'
  | 'snapshot-stale'
  | 'external-statusline'
  | 'configuration-shadowed'
  | 'concurrent-change'
  | 'consent-missing'
  | 'integration-disabled'
  | 'recovery-unavailable'
  | 'unsupported-platform';

export interface AutoHealAssessment {
  state: AutoHealState;
  /** True only when this specific state may be repaired without prompting the user. */
  autoRepairable: boolean;
  /** True when nothing will be written automatically and the user must act (or nothing is wrong). */
  requiresUserAction: boolean;
  reason: string;
  safeNextAction: string;
}

export interface AutoHealContext {
  /**
   * The `aiLimitLedger.claudeEnabled` flag - distinct from `report.integrationMode`, which also
   * reports `'disabled'` for an unowned/missing statusLine even while this flag is true.
   */
  claudeEnabled: boolean;
  consentPresent: boolean;
  autoRepairEnabled: boolean;
  /** True unless a chained-mode repair is needed on a platform that does not support chaining. */
  platformSupported: boolean;
  /** Seconds AI Limit Ledger currently expects `statusLine.refreshInterval` to be set to. */
  configuredRefreshIntervalSeconds: number;
  /** Seconds after which a present snapshot is considered stale for display purposes only. */
  snapshotStaleAfterSeconds: number;
  /** True when a settings watcher observed a change that this process did not itself make. */
  concurrentChangeDetected: boolean;
}

/** States that are informational only - nothing is broken that the user needs to act on. */
const NO_ACTION_STATES: ReadonlySet<AutoHealState> = new Set([
  'healthy',
  'integration-disabled',
  'snapshot-stale',
]);

const AUTO_REPAIRABLE_STATES: ReadonlySet<AutoHealState> = new Set([
  'wrapper-missing',
  'wrapper-outdated',
  'wrapper-corrupt',
  'statusline-missing',
  'refresh-interval-mismatch',
]);

function assessment(
  state: AutoHealState,
  reason: string,
  safeNextAction: string,
  ctx: AutoHealContext,
): AutoHealAssessment {
  const eligible = AUTO_REPAIRABLE_STATES.has(state);
  const autoRepairable =
    eligible && ctx.consentPresent && ctx.autoRepairEnabled && ctx.claudeEnabled;
  return {
    state,
    autoRepairable,
    requiresUserAction: !NO_ACTION_STATES.has(state) && !autoRepairable,
    reason,
    safeNextAction,
  };
}

/**
 * Pure classification: every branch is decided purely from `report` (already computed from live
 * disk state by `diagnoseClaudeIntegration`) and `ctx` (auto-heal-specific facts the diagnose
 * report does not carry). No I/O here - always independently unit-testable.
 */
export function classifyAutoHealth(
  report: DiagnosticsReport,
  ctx: AutoHealContext,
): AutoHealAssessment {
  if (!ctx.platformSupported) {
    return assessment(
      'unsupported-platform',
      'Chaining is required to repair this integration, but it is not supported on this platform.',
      'Use manual "Repair Claude Code Integration" or "Replace after backup" instead.',
      ctx,
    );
  }
  if (!ctx.claudeEnabled) {
    return assessment(
      'integration-disabled',
      'Claude Code integration was explicitly disabled or never enabled.',
      'Run "AI Limit Ledger: Enable Claude Code Integration" to turn it on.',
      ctx,
    );
  }
  if (!ctx.consentPresent) {
    return assessment(
      'consent-missing',
      'No automatic-repair consent is on file for this installation.',
      'Run "AI Limit Ledger: Enable Claude Code Integration" once to grant consent.',
      ctx,
    );
  }
  if (report.repairReasons.includes('external-change') || ctx.concurrentChangeDetected) {
    return assessment(
      'concurrent-change',
      'Another process changed the Claude Code statusLine at the same time as this check.',
      'Recheck once the concurrent change has settled, or use manual repair.',
      ctx,
    );
  }
  if (report.shadowedByHigherPrecedence) {
    return assessment(
      'configuration-shadowed',
      'A higher-precedence project-level setting overrides the user-level statusLine AI Limit Ledger manages.',
      'Update or remove the project-level Claude Code setting for this workspace.',
      ctx,
    );
  }
  if (
    report.effectiveStatusLinePresent &&
    (report.repairReasons.includes('configuration-removed') || report.settingsOwnershipOk === false)
  ) {
    return assessment(
      'external-statusline',
      'The current statusLine points to a command AI Limit Ledger does not own.',
      'Use manual "Repair Claude Code Integration" to choose how to proceed.',
      ctx,
    );
  }
  // Chained mode's inner command can only be reconstructed from recovery metadata (its shape is
  // dynamic, unlike standalone's fixed wrapper) - a missing/outdated chained wrapper with no
  // recovery data on file cannot be safely regenerated automatically.
  if (
    report.integrationMode === 'chained' &&
    (report.repairReasons.includes('wrapper-missing') || report.wrapperHashMatches === false) &&
    !report.recoveryMetadataPresent
  ) {
    return assessment(
      'recovery-unavailable',
      'Recovery metadata is required to safely repair this integration, but none is present.',
      'Use manual "Repair Claude Code Integration"; it will ask before proceeding.',
      ctx,
    );
  }
  if (report.wrapperPresent && report.wrapperSelfCheck === 'failed') {
    return assessment(
      'wrapper-corrupt',
      'The installed wrapper failed its self-check.',
      'Auto-heal will stage and validate a fresh wrapper.',
      ctx,
    );
  }
  if (report.repairReasons.includes('wrapper-missing')) {
    return assessment(
      'wrapper-missing',
      'The AI Limit Ledger bridge wrapper file is missing.',
      'Auto-heal will reinstall the wrapper.',
      ctx,
    );
  }
  if (report.wrapperHashMatches === false) {
    return assessment(
      'wrapper-outdated',
      'The installed wrapper does not match what the current extension version would generate.',
      'Auto-heal will stage and install an up-to-date wrapper.',
      ctx,
    );
  }
  if (!report.effectiveStatusLinePresent) {
    return assessment(
      'statusline-missing',
      'AI Limit Ledger owns this integration, but the statusLine setting is gone.',
      'Auto-heal will reinstall the statusLine.',
      ctx,
    );
  }
  if (
    report.effectiveRefreshInterval !== null &&
    report.effectiveRefreshInterval !== ctx.configuredRefreshIntervalSeconds
  ) {
    return assessment(
      'refresh-interval-mismatch',
      `The statusLine refreshInterval (${report.effectiveRefreshInterval}s) does not match the configured value (${ctx.configuredRefreshIntervalSeconds}s).`,
      'Auto-heal will update only the refreshInterval field.',
      ctx,
    );
  }
  if (
    report.snapshotAgeSeconds !== null &&
    report.snapshotAgeSeconds > ctx.snapshotStaleAfterSeconds
  ) {
    return assessment(
      'snapshot-stale',
      'The most recent usage snapshot is older than expected.',
      'No action needed - a new snapshot will arrive on the next Claude Code response.',
      ctx,
    );
  }
  return assessment('healthy', 'The integration is healthy.', 'No action needed.', ctx);
}
