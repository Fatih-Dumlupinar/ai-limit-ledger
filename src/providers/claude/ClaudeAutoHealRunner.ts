import {
  classifyAutoHealth,
  type AutoHealAssessment,
  type AutoHealContext,
} from './ClaudeAutoHeal';
import { diagnoseClaudeIntegration, type DiagnosticsDeps } from './ClaudeDiagnostics';
import {
  enableClaudeIntegration,
  repairRefreshInterval,
  type ClaudeIntegrationDeps,
  type ConfirmUi,
} from './ClaudeIntegrationTransaction';
import {
  isEnabled,
  loadAutoHealAttempt,
  loadConsent,
  saveAutoHealAttempt,
  type AutoHealAttemptState,
} from './ClaudeRecoveryStore';
import type { EnableOutcome } from './types';

export interface AutoHealDeps extends DiagnosticsDeps {
  refreshIntervalSeconds: number;
  autoRepairEnabled: boolean;
  platformSupported: boolean;
  snapshotStaleAfterSeconds: number;
  concurrentChangeDetected: boolean;
  onIntegrationChanged: () => void;
  notify: (message: string) => void;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface AutoHealRunResult {
  ran: boolean;
  assessment: AutoHealAssessment;
  outcome?: EnableOutcome;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

let inFlight: Promise<AutoHealRunResult> | undefined;
let notifiedThisSession = false;

/** Test-only: resets module-level single-flight/notification state between test cases. */
export function resetAutoHealRunnerStateForTests(): void {
  inFlight = undefined;
  notifiedThisSession = false;
}

function silentConfirm(): ConfirmUi {
  return {
    showIntro: async () => true,
    showConsent: async () => 'auto',
    // Never actually reached: every state that reaches a chooseExistingStatusLineAction branch
    // (an unowned/foreign statusLine) is classified as `external-statusline`, which is never
    // autoRepairable. This is a defense-in-depth no-write default, not an expected path.
    chooseExistingStatusLineAction: async () => 'cancel',
    confirmRepair: async () => true,
    notify: () => undefined,
    warn: () => undefined,
  };
}

function toTransactionDeps(deps: AutoHealDeps): ClaudeIntegrationDeps {
  return {
    fs: deps.fs,
    clock: deps.clock,
    platform: deps.platform,
    confirm: silentConfirm(),
    runWrapper:
      deps.runWrapper ?? (async () => ({ exitCode: null, timedOut: true, stdout: '', stderr: '' })),
    secrets: deps.secrets,
    globalState: deps.globalState,
    settingsPath: deps.settingsPath,
    globalStorageDir: deps.globalStorageDir,
    snapshotPath: deps.snapshotPath,
    onIntegrationChanged: deps.onIntegrationChanged,
    refreshIntervalSeconds: deps.refreshIntervalSeconds,
  };
}

/**
 * The single entry point that turns a health assessment into action. Never prompts the user
 * (see `silentConfirm`) and reuses the exact same staged/validated/self-checked/rollback-capable
 * transaction (`enableClaudeIntegration`/`repairRefreshInterval`) that the manual commands use —
 * auto-heal adds gating and backoff around it, not a second write path.
 */
export async function runAutoHeal(
  deps: AutoHealDeps,
  options: { resetAttempts?: boolean } = {},
): Promise<AutoHealRunResult> {
  if (inFlight) return inFlight;
  const run = performRun(deps, options).finally(() => {
    inFlight = undefined;
  });
  inFlight = run;
  return run;
}

async function performRun(
  deps: AutoHealDeps,
  options: { resetAttempts?: boolean },
): Promise<AutoHealRunResult> {
  const report = await diagnoseClaudeIntegration(deps);
  const consent = loadConsent(deps.globalState);
  const ctx: AutoHealContext = {
    claudeEnabled: isEnabled(deps.globalState),
    consentPresent: Boolean(consent),
    autoRepairEnabled: deps.autoRepairEnabled,
    platformSupported: deps.platformSupported,
    configuredRefreshIntervalSeconds: deps.refreshIntervalSeconds,
    snapshotStaleAfterSeconds: deps.snapshotStaleAfterSeconds,
    concurrentChangeDetected: deps.concurrentChangeDetected,
  };
  const assessment = classifyAutoHealth(report, ctx);
  const now = deps.clock().getTime();

  const previous = loadAutoHealAttempt(deps.globalState);
  let attempt: AutoHealAttemptState =
    options.resetAttempts || previous?.reason !== assessment.state
      ? {
          reason: assessment.state,
          attemptCount: 0,
          lastAttemptAt: 0,
          backoffUntil: 0,
          lastHealthCheckAt: now,
          lastSuccessAt: previous?.lastSuccessAt ?? null,
          lastRepairReason: previous?.lastRepairReason ?? null,
        }
      : { ...previous, lastHealthCheckAt: now };
  await saveAutoHealAttempt(deps.globalState, attempt);

  if (!assessment.autoRepairable) {
    return { ran: false, assessment };
  }
  if (now < attempt.backoffUntil) {
    return { ran: false, assessment };
  }
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempt.attemptCount >= maxAttempts) {
    return { ran: false, assessment };
  }

  const txDeps = toTransactionDeps(deps);
  let outcome: EnableOutcome;
  try {
    outcome =
      assessment.state === 'refresh-interval-mismatch'
        ? await repairRefreshInterval(txDeps)
        : await enableClaudeIntegration(txDeps);
  } catch (error) {
    outcome = {
      kind: 'error',
      message: error instanceof Error ? error.message : 'Auto-heal failed unexpectedly.',
    };
  }

  if (outcome.kind === 'enabled') {
    await saveAutoHealAttempt(deps.globalState, {
      reason: assessment.state,
      attemptCount: 0,
      lastAttemptAt: now,
      backoffUntil: 0,
      lastHealthCheckAt: now,
      lastSuccessAt: now,
      lastRepairReason: assessment.state,
    });
    if (!notifiedThisSession) {
      notifiedThisSession = true;
      deps.notify('AI Limit Ledger automatically repaired its Claude Code integration.');
    }
    return { ran: true, assessment, outcome };
  }

  const nextCount = attempt.attemptCount + 1;
  const baseMs = deps.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const backoffMs = Math.min(maxMs, baseMs * 2 ** nextCount);
  await saveAutoHealAttempt(deps.globalState, {
    reason: assessment.state,
    attemptCount: nextCount,
    lastAttemptAt: now,
    backoffUntil: now + backoffMs,
    lastHealthCheckAt: now,
    lastSuccessAt: attempt.lastSuccessAt,
    lastRepairReason: attempt.lastRepairReason,
  });
  return { ran: true, assessment, outcome };
}
