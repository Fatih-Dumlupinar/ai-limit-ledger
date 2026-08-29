import * as path from 'node:path';
import { resolveEffectiveStatusLine } from './ClaudeConfigPrecedence';
import type { ClaudeHostKind } from './ClaudeHostDetection';
import { classifyOwnership, commandTargetsPath, hashContent } from './ClaudeOwnership';
import {
  isEnabled,
  loadLastError,
  loadOwnership,
  loadRecovery,
  readLegacyPrevious,
  type GlobalStateLike,
  type SecretsLike,
} from './ClaudeRecoveryStore';
import { asJsonObject, readSettings, type FsLike } from './ClaudeSettingsFile';
import {
  chainedScriptPathFor,
  chainingCapableByPlatform,
  standaloneScriptPathFor,
  standaloneWrapperExpectedHash,
} from './ClaudeIntegrationTransaction';
import { WAITING_TIMEOUT_MS } from './ClaudeStateMachine';
import type { RunOptions, RunResult } from './ClaudeWrapperRunner';
import type { DiagnosticsReport, RepairReason } from './types';

export interface DiagnosticsDeps {
  fs: FsLike;
  clock: () => Date;
  platform: NodeJS.Platform;
  cliAvailable: () => boolean;
  secrets: SecretsLike;
  globalState: GlobalStateLike;
  settingsPath: string;
  snapshotPath: string;
  globalStorageDir: string;
  /** Project-scope statusLine values for the current workspace, if any — omit if not resolvable. */
  projectSharedStatusLine?: unknown;
  projectLocalStatusLine?: unknown;
  /** Optional: re-runs the installed wrapper against a fixture to confirm it still works. */
  runWrapper?: (
    wrapperPath: string,
    stdin: string,
    platform: NodeJS.Platform,
    options?: RunOptions,
  ) => Promise<RunResult>;
  hostKind: ClaudeHostKind;
}

function classifyLastError(message: string | null): DiagnosticsReport['lastWrapperErrorCategory'] {
  if (!message) return 'none';
  if (message.includes('Another process changed the Claude Code statusLine'))
    return 'external-change';
  if (message.includes('self-check')) return 'self-check-failed';
  if (
    message.includes('verification failed') ||
    message.includes('safely switch') ||
    message.includes('verify the Claude Code statusLine after multiple attempts')
  )
    return 'verification-failed';
  if (message.includes('chained wrapper script') || message.includes('activate the chained'))
    return 'wrapper-write-failed';
  if (message.includes('AI Limit Ledger bridge') || message.includes('Claude Code settings'))
    return 'settings-write-failed';
  return 'other';
}

function recommendNextAction(report: {
  claudeCliFound: boolean;
  integrationMode: string;
  shadowedByHigherPrecedence: boolean;
  wrapperPresent: boolean;
  wrapperSelfCheck: 'passed' | 'failed' | 'not-run';
  snapshotPresent: boolean;
  upstreamStatusLineNotInvoked: boolean;
  hostKind: DiagnosticsReport['hostKind'];
  integrationHealth: DiagnosticsReport['integrationHealth'];
  repairReasons: RepairReason[];
}): string {
  if (!report.claudeCliFound)
    return 'Install the Claude Code CLI or the official VS Code extension, then diagnose again.';
  if (report.integrationMode === 'disabled' && report.repairReasons.length === 0)
    return 'Run "AI Limit Ledger: Enable Claude Code Integration".';
  if (report.integrationHealth === 'repair-required')
    return (
      'Run "AI Limit Ledger: Enable Claude Code Integration" again to repair the integration (' +
      report.repairReasons.join(', ') +
      ').'
    );
  if (report.shadowedByHigherPrecedence)
    return 'A project-level Claude Code setting overrides the user-level one AI Limit Ledger configured — update or remove it for this workspace, or accept that usage data will not appear here.';
  if (report.wrapperSelfCheck === 'failed')
    return 'The wrapper failed its self-check. Re-run Enable to repair it, or Disable and re-enable.';
  if (report.upstreamStatusLineNotInvoked)
    return report.hostKind === 'vscode-sidebar'
      ? 'The wrapper and configuration are confirmed healthy — do not reconfigure it again. The Claude Code VS Code host is not invoking the configured status-line command on this surface. Try the standalone Claude Code CLI in a terminal instead, if available.'
      : 'The wrapper and configuration are confirmed healthy — do not reconfigure it again. This Claude Code host has not invoked the status-line command after a real response; this is an upstream behavior to report to Anthropic, not something to fix by re-enabling.';
  if (!report.snapshotPresent)
    return 'Close and reopen your Claude Code session, then complete one response.';
  return 'No action needed.';
}

export async function diagnoseClaudeIntegration(deps: DiagnosticsDeps): Promise<DiagnosticsReport> {
  const claudeCliFound = deps.cliAvailable();

  let settings: { parsed: Record<string, unknown> };
  try {
    settings = await readSettings(deps.fs, deps.settingsPath);
  } catch {
    settings = { parsed: {} };
  }

  const ownership = loadOwnership(deps.globalState);
  const classification = classifyOwnership(
    settings.parsed.statusLine,
    ownership?.wrapperPath,
    chainedScriptPathFor(deps.globalStorageDir, deps.platform),
    standaloneScriptPathFor(deps.globalStorageDir, deps.platform),
  );
  const enabled = isEnabled(deps.globalState);
  const integrationMode: DiagnosticsReport['integrationMode'] =
    enabled && classification.owned
      ? (ownership?.mode ?? classification.mode ?? 'standalone')
      : 'disabled';

  let wrapperPresent = false;
  let wrapperContent: string | null = null;
  if (ownership?.wrapperPath) {
    try {
      wrapperContent = await deps.fs.readFile(ownership.wrapperPath, 'utf8');
      wrapperPresent = true;
    } catch {
      wrapperPresent = false;
    }
  }

  // Real disk-state check, never inferred from cached ownership metadata: for standalone mode,
  // compare the wrapper's actual content hash against what the current generator would produce
  // for this platform/snapshot path. `null` (not applicable) only when there is no wrapper to
  // compare, or mode is chained (dynamic inner command — staleness not modeled here).
  const wrapperMode = ownership?.mode ?? classification.mode;
  const wrapperHashMatches: boolean | null =
    !wrapperPresent || wrapperContent === null
      ? ownership?.wrapperPath
        ? false
        : null
      : wrapperMode === 'chained'
        ? true
        : hashContent(wrapperContent) ===
          standaloneWrapperExpectedHash(deps.platform, deps.snapshotPath);

  const settingsOwnershipOk = !classification.owned
    ? null
    : ownership
      ? commandTargetsPath(asJsonObject(settings.parsed.statusLine)?.command, ownership.wrapperPath)
      : true;

  const recovery = await loadRecovery(deps.secrets);
  const legacyPrevious = readLegacyPrevious(deps.globalState);
  const recoveryMetadataPresent = Boolean(recovery?.present) || legacyPrevious !== undefined;

  let snapshotPresent = false;
  let snapshotSchemaVersion: number | null = null;
  let snapshotAgeSeconds: number | null = null;
  try {
    const raw = await deps.fs.readFile(deps.snapshotPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      snapshotPresent = true;
      snapshotSchemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : null;
      const observedAt = typeof obj.observedAt === 'string' ? Date.parse(obj.observedAt) : NaN;
      snapshotAgeSeconds = Number.isNaN(observedAt)
        ? null
        : Math.max(0, Math.round((deps.clock().getTime() - observedAt) / 1000));
    }
  } catch {
    snapshotPresent = false;
  }

  const restorePossible =
    classification.owned &&
    (recoveryMetadataPresent || (ownership?.originalStatusLineHash ?? null) === null);

  const { winningScope } = resolveEffectiveStatusLine(
    settings.parsed.statusLine,
    deps.projectSharedStatusLine,
    deps.projectLocalStatusLine,
  );
  const shadowedByHigherPrecedence =
    winningScope !== 'user' && winningScope !== 'none' && classification.owned;

  let wrapperSelfCheck: DiagnosticsReport['wrapperSelfCheck'] = 'not-run';
  if (deps.runWrapper && ownership?.wrapperPath && wrapperPresent) {
    try {
      const result = await deps.runWrapper(
        ownership.wrapperPath,
        JSON.stringify({ version: '0.0.0-diagnose', model: {}, rate_limits: {} }),
        deps.platform,
        { timeoutMs: 8000 },
      );
      wrapperSelfCheck = result.exitCode !== null && !result.timedOut ? 'passed' : 'failed';
    } catch {
      wrapperSelfCheck = 'failed';
    }
  }

  let fiveHourFieldsPresent = false;
  let sevenDayFieldsPresent = false;
  let sourceUpdatedAt: string | null = null;
  let fiveHourRawPercentage: number | null = null;
  let sevenDayRawPercentage: number | null = null;
  let contextRawPercentage: number | null = null;
  try {
    const raw = await deps.fs.readFile(deps.snapshotPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      observedAt?: unknown;
      rate_limits?: {
        five_hour?: { used_percentage?: unknown } | null;
        seven_day?: { used_percentage?: unknown } | null;
      };
      context_window?: { used_percentage?: unknown } | null;
    };
    fiveHourFieldsPresent = Boolean(parsed.rate_limits?.five_hour);
    sevenDayFieldsPresent = Boolean(parsed.rate_limits?.seven_day);
    sourceUpdatedAt = typeof parsed.observedAt === 'string' ? parsed.observedAt : null;
    const fiveHourUsed = parsed.rate_limits?.five_hour?.used_percentage;
    fiveHourRawPercentage = typeof fiveHourUsed === 'number' ? fiveHourUsed : null;
    const sevenDayUsed = parsed.rate_limits?.seven_day?.used_percentage;
    sevenDayRawPercentage = typeof sevenDayUsed === 'number' ? sevenDayUsed : null;
    const contextUsed = parsed.context_window?.used_percentage;
    contextRawPercentage = typeof contextUsed === 'number' ? contextUsed : null;
  } catch {
    /* no snapshot to inspect */
  }

  const effectiveRefreshInterval = (() => {
    const value = asJsonObject(settings.parsed.statusLine)?.refreshInterval;
    return typeof value === 'number' ? value : null;
  })();

  const lastSafeBridgeError = loadLastError(deps.globalState);
  const enabledAtMs = ownership?.enabledAt ? Date.parse(ownership.enabledAt) : NaN;
  const msSinceEnabled = Number.isNaN(enabledAtMs)
    ? null
    : Math.max(0, deps.clock().getTime() - enabledAtMs);

  // Mirrors the live provider's own bounded-wait rule: only claim "upstream did not invoke it"
  // once everything we control is confirmed healthy and the wait timeout has actually elapsed —
  // never as a guess, and never as a reason to keep rewriting the wrapper.
  const upstreamStatusLineNotInvoked =
    classification.owned &&
    !shadowedByHigherPrecedence &&
    wrapperPresent &&
    wrapperSelfCheck === 'passed' &&
    !snapshotPresent &&
    msSinceEnabled !== null &&
    msSinceEnabled >= WAITING_TIMEOUT_MS;

  const effectiveStatusLinePresent = winningScope !== 'none';
  const lastWrapperErrorCategory = classifyLastError(lastSafeBridgeError);

  // Every reason here is derived from a check performed above against real disk state (settings
  // file, wrapper file, its content hash) or the most recent transaction outcome — never from
  // stored ownership/recovery metadata alone. `ready` is never reported while any reason holds.
  const repairReasons: RepairReason[] = [];
  if (enabled) {
    if (!effectiveStatusLinePresent) {
      repairReasons.push('statusline-missing');
    } else if (!classification.owned) {
      repairReasons.push('configuration-removed');
    }
    if (classification.owned || ownership?.wrapperPath) {
      if (!wrapperPresent) repairReasons.push('wrapper-missing');
      else if (wrapperHashMatches === false) repairReasons.push('wrapper-outdated');
    }
    if (lastWrapperErrorCategory === 'external-change') repairReasons.push('external-change');
    if (lastWrapperErrorCategory === 'verification-failed')
      repairReasons.push('post-commit-verification-failed');
  }

  const integrationHealth: DiagnosticsReport['integrationHealth'] = !enabled
    ? 'disabled'
    : repairReasons.length > 0
      ? 'repair-required'
      : 'ready';

  const report = {
    claudeCliFound,
    integrationMode,
    wrapperPresent,
    wrapperVersion: ownership?.wrapperVersion ?? null,
    wrapperHashMatches,
    settingsOwnershipOk,
    effectiveStatusLinePresent,
    integrationHealth,
    repairReasons,
    recoveryMetadataPresent,
    snapshotPresent,
    snapshotSchemaVersion,
    snapshotAgeSeconds,
    lastSafeBridgeError,
    restorePossible,
    chainingSupportedOnPlatform: chainingCapableByPlatform(deps.platform),
    resolvedConfigDir: path.dirname(deps.settingsPath),
    winningStatusLineScope: winningScope,
    shadowedByHigherPrecedence,
    wrapperSelfCheck,
    fiveHourFieldsPresent,
    sevenDayFieldsPresent,
    effectiveRefreshInterval,
    sourceUpdatedAt,
    fiveHourRawPercentage,
    sevenDayRawPercentage,
    contextRawPercentage,
    lastWrapperErrorCategory,
    hostKind: deps.hostKind,
    msSinceEnabled,
    upstreamStatusLineNotInvoked,
  };
  return {
    ...report,
    recommendedNextAction: recommendNextAction(report),
  };
}

/** Renders the report as plain, redacted text — no command content, no full user path, no raw JSON. */
export function formatDiagnosticsReport(report: DiagnosticsReport, homeDir: string): string {
  const mask = (value: string | null): string =>
    value === null ? 'not available' : value.split(homeDir).join('%USERPROFILE%');
  const lines = [
    `Claude CLI: ${report.claudeCliFound ? 'found' : 'not found'}`,
    `Resolved config directory: ${mask(report.resolvedConfigDir)}`,
    `Winning statusLine scope: ${report.winningStatusLineScope}`,
    `Effective statusLine: ${report.effectiveStatusLinePresent ? 'present' : 'absent'}`,
    `Shadowed by higher-precedence config: ${report.shadowedByHigherPrecedence ? 'yes' : 'no'}`,
    `Integration mode: ${report.integrationMode}`,
    `Wrapper file: ${report.wrapperPresent ? 'present' : 'missing'}`,
    `Wrapper version: ${report.wrapperHashMatches === false ? 'outdated' : (report.wrapperVersion ?? 'not available')}`,
    `Wrapper hash match: ${report.wrapperHashMatches === null ? 'not applicable' : report.wrapperHashMatches ? 'yes' : 'no'}`,
    `Wrapper self-check: ${report.wrapperSelfCheck}`,
    `Settings ownership: ${
      report.integrationHealth === 'repair-required' && !report.effectiveStatusLinePresent
        ? 'not currently configured'
        : report.settingsOwnershipOk === null
          ? 'not applicable'
          : report.settingsOwnershipOk
            ? 'ok'
            : 'mismatch'
    }`,
    `Recovery metadata: ${report.recoveryMetadataPresent ? 'present' : 'absent'}`,
    `Integration state: ${report.integrationHealth}`,
    `Repair reason: ${report.repairReasons.length ? report.repairReasons.join(', ') : 'none'}`,
    `Snapshot: ${report.snapshotPresent ? 'present' : 'absent'}`,
    `Snapshot schema version: ${report.snapshotSchemaVersion ?? 'not available'}`,
    `Snapshot age (seconds): ${report.snapshotAgeSeconds ?? 'not available'}`,
    `Five-hour rate-limit fields present: ${report.fiveHourFieldsPresent ? 'yes' : 'no'}`,
    `Seven-day rate-limit fields present: ${report.sevenDayFieldsPresent ? 'yes' : 'no'}`,
    `Effective refreshInterval (seconds): ${report.effectiveRefreshInterval ?? 'not set'}`,
    `Snapshot source-updated (wrapper-stamped): ${report.sourceUpdatedAt ?? 'not available'}`,
    `Five-hour raw percentage: ${report.fiveHourRawPercentage ?? 'not available'}`,
    `Seven-day raw percentage: ${report.sevenDayRawPercentage ?? 'not available'}`,
    `Context raw percentage: ${report.contextRawPercentage ?? 'not available'}`,
    `Last safe bridge error: ${mask(report.lastSafeBridgeError)}`,
    `Last wrapper error category: ${report.lastWrapperErrorCategory}`,
    `Host surface: ${report.hostKind}`,
    `Minutes since enabled: ${report.msSinceEnabled === null ? 'not available' : Math.round(report.msSinceEnabled / 60000)}`,
    `Upstream status-line not invoked: ${report.upstreamStatusLineNotInvoked ? 'yes' : 'no'}`,
    `Restore possible: ${report.restorePossible ? 'yes' : 'no'}`,
    `Chaining supported on this platform: ${report.chainingSupportedOnPlatform ? 'yes' : 'no'}`,
    `Recommended next action: ${report.recommendedNextAction}`,
  ];
  return lines.join('\n');
}
