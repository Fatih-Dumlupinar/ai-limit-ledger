import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandExecutionResult } from '../commands/CommandExecution';
import { openProviderLink, type UsageLinkOptions } from '../ui/UsageLinks';
import { localization } from '../localization/LocalizationService';
import {
  claudeBridgePath,
  claudeHookActivityPath,
  findClaudeCli,
  type ClaudeProviderClassification,
} from './ClaudeCodeProvider';
import { installActivityHooks, uninstallActivityHooks } from './claude/hooks/ClaudeHookInstaller';
import { computeClassification } from './claude/ClaudeClassifier';
import { deriveAccessMode, type ClaudeAccessMode } from './claude/ClaudeAccessMode';
import { diagnoseClaudeIntegration, formatDiagnosticsReport } from './claude/ClaudeDiagnostics';
import { detectHostKind, type ClaudeHostKind } from './claude/ClaudeHostDetection';
import type { DiagnosticsReport } from './claude/types';
import {
  chainedScriptPathFor,
  disableClaudeIntegration,
  enableClaudeIntegration,
  standaloneScriptPathFor,
  standaloneWrapperExpectedHash,
  type ClaudeIntegrationDeps,
  type ConfirmUi,
} from './claude/ClaudeIntegrationTransaction';
import { hashContent } from './claude/ClaudeOwnership';
import {
  isAwaitingSessionRestart,
  isExplicitlyDisabled,
  loadAutoHealAttempt,
  loadConsent,
  loadOAuthUsageConsent,
  loadOwnership,
  saveLastError,
  saveOAuthUsageConsent,
  setEnabled,
  setAwaitingSessionRestart,
  OAUTH_USAGE_CONSENT_VERSION,
  OAUTH_USAGE_TRANSPORT_VERSION,
} from './claude/ClaudeRecoveryStore';
import { CURRENT_WRAPPER_VERSION } from './claude/types';
import { readSettings, type FsLike } from './claude/ClaudeSettingsFile';
import { isVersionAtLeast, MIN_STATUSLINE_CONTRACT_VERSION } from './claude/ClaudeVersion';
import { spawnWrapperOnce } from './claude/ClaudeWrapperRunner';
import {
  runAutoHeal,
  type AutoHealDeps,
  type AutoHealRunResult,
} from './claude/ClaudeAutoHealRunner';
import type { EffectiveSettings } from '../configuration/EffectiveSettings';

const AUTO_REPAIR_SETTING = 'claude.autoRepair';
const SNAPSHOT_STALE_AFTER_SECONDS = 24 * 60 * 60;
let effectiveSettingsProvider: (() => EffectiveSettings) | undefined;
let settingsUpdater:
  ((key: 'claudeAutoRepair' | 'claudeOAuthEnabled', value: boolean) => Promise<void>) | undefined;

/** Connects legacy Claude transaction helpers to the central runtime settings snapshot. */
export function setClaudeSettingsProvider(
  provider: () => EffectiveSettings,
  update?: (key: 'claudeAutoRepair' | 'claudeOAuthEnabled', value: boolean) => Promise<void>,
): void {
  effectiveSettingsProvider = provider;
  settingsUpdater = update;
}

/** Reads the `aiLimitLedger.claude.autoRepair` machine-scope setting; defaults to opted-in. */
export function claudeAutoRepairEnabled(): boolean {
  if (effectiveSettingsProvider) return effectiveSettingsProvider().claudeAutoRepair;
  return vscode.workspace.getConfiguration('aiLimitLedger').get<boolean>(AUTO_REPAIR_SETTING, true);
}

async function setClaudeAutoRepairEnabled(enabled: boolean): Promise<void> {
  if (settingsUpdater) return settingsUpdater('claudeAutoRepair', enabled);
  await vscode.workspace
    .getConfiguration('aiLimitLedger')
    .update(AUTO_REPAIR_SETTING, enabled, vscode.ConfigurationTarget.Global);
}

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const DEFAULT_CLAUDE_REFRESH_INTERVAL_SECONDS = 15;
const MIN_CLAUDE_REFRESH_INTERVAL_SECONDS = 5;
const MAX_CLAUDE_REFRESH_INTERVAL_SECONDS = 300;

/** Reads and clamps `aiLimitLedger.refresh.claudeStatusLineSeconds`; never trusts an out-of-range user value. */
export function claudeRefreshIntervalSeconds(): number {
  if (effectiveSettingsProvider) return effectiveSettingsProvider().refresh.claudeStatusLineSeconds;
  const configured = vscode.workspace
    .getConfiguration('aiLimitLedger')
    .get<number>('refresh.claudeStatusLineSeconds', DEFAULT_CLAUDE_REFRESH_INTERVAL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_CLAUDE_REFRESH_INTERVAL_SECONDS;
  return Math.min(
    MAX_CLAUDE_REFRESH_INTERVAL_SECONDS,
    Math.max(MIN_CLAUDE_REFRESH_INTERVAL_SECONDS, configured),
  );
}

const settingsPath = (): string =>
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'settings.json');

function nodeFs(): FsLike {
  return {
    readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
    writeFile: async (filePath, data, options) => {
      await fs.writeFile(filePath, data, options);
    },
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    mkdir: async (dirPath, options) => {
      await fs.mkdir(dirPath, options);
    },
    unlink: (filePath) => fs.unlink(filePath),
  };
}

function vscodeConfirmUi(): ConfirmUi {
  return {
    async showIntro(): Promise<boolean> {
      const choice = await vscode.window.showInformationMessage(
        localization.t('claudeConsentIntro'),
        { modal: true },
        localization.t('continue'),
      );
      return choice === localization.t('continue');
    },
    async showConsent(previousChoice) {
      const AUTO = localization.t('claudeConsentAuto');
      const MANUAL = localization.t('claudeConsentManual');
      const CANCEL = localization.t('claudeConsentCancel');
      const items = [
        {
          label: previousChoice === 'auto' ? `${AUTO} (current)` : AUTO,
          detail: localization.t('claudeConsentAutoDetail'),
        },
        {
          label: previousChoice === 'manual' ? `${MANUAL} (current)` : MANUAL,
          detail: localization.t('claudeConsentManualDetail'),
        },
        { label: CANCEL, detail: localization.t('claudeConsentNoChanges') },
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: localization.t('claudeConsentTitle'),
        placeHolder: localization.t('claudeConsentAutoDetail'),
      });
      if (!selected || selected.label.startsWith(CANCEL)) return 'cancel';
      return selected.label.startsWith(AUTO) ? 'auto' : 'manual';
    },
    async chooseExistingStatusLineAction(preserveAvailable) {
      const items = [
        {
          label: preserveAvailable
            ? localization.t('claudePreserveRecommended')
            : localization.t('claudePreserveUnavailable'),
          detail: preserveAvailable
            ? localization.t('claudePreserveDetail')
            : localization.t('claudePreserveUnavailableDetail'),
        },
        {
          label: localization.t('claudeReplaceAfterBackup'),
          detail: localization.t('claudeReplaceDetail'),
        },
        {
          label: localization.t('claudeConsentCancel'),
          detail: localization.t('claudeConsentNoChanges'),
        },
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: localization.t('claudeExistingStatusLineTitle'),
        placeHolder: localization.t('claudeExistingStatusLinePlaceHolder'),
      });
      if (!selected || selected.label === localization.t('claudeConsentCancel')) return 'cancel';
      if (selected.label === localization.t('claudeReplaceAfterBackup')) return 'replace';
      return preserveAvailable ? 'preserve' : 'cancel';
    },
    async confirmRepair(): Promise<boolean> {
      const choice = await vscode.window.showWarningMessage(
        localization.t('claudeRepairConfirmation'),
        { modal: true },
        localization.t('repair'),
      );
      return choice === localization.t('repair');
    },
    notify(message: string): void {
      void vscode.window.showInformationMessage(message);
    },
    warn(message: string): void {
      void vscode.window.showWarningMessage(message);
    },
  };
}

function buildDeps(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void,
  promptConsent = false,
): ClaudeIntegrationDeps {
  return {
    fs: nodeFs(),
    clock: () => new Date(),
    platform: process.platform,
    confirm: vscodeConfirmUi(),
    runWrapper: spawnWrapperOnce,
    secrets: context.secrets,
    globalState: context.globalState,
    settingsPath: settingsPath(),
    globalStorageDir: context.globalStorageUri.fsPath,
    snapshotPath: claudeBridgePath(context),
    onIntegrationChanged,
    refreshIntervalSeconds: claudeRefreshIntervalSeconds(),
    promptConsent,
    setAutoRepairEnabled: setClaudeAutoRepairEnabled,
    getAutoRepairEnabled: claudeAutoRepairEnabled,
  };
}

export async function enableClaude(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void = () => undefined,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  const notify = options.notify ?? true;
  const outcome = await enableClaudeIntegration(buildDeps(context, onIntegrationChanged, true));
  if (outcome.kind === 'error') {
    await saveLastError(context.globalState, outcome.message);
    if (notify) void vscode.window.showErrorMessage(outcome.message);
    return {
      status: 'error',
      safeMessage: 'Claude integration could not be enabled.',
      safeErrorCategory: 'configuration-error',
      retryable: false,
    };
  }
  if (outcome.kind === 'enabled') {
    await setEnabled(context.globalState, true);
    await setAwaitingSessionRestart(context.globalState, true);
  }
  await saveLastError(context.globalState, null);
  if (outcome.kind === 'cancelled') {
    if (notify)
      void vscode.window.showInformationMessage('Setup was cancelled; no settings were changed.');
    return { status: 'cancelled', safeErrorCategory: 'cancelled', retryable: false };
  }
  if (notify)
    void vscode.window.showInformationMessage(
      'Integration enabled. Complete a Claude Code response to receive usage data.',
    );
  return { status: 'success', retryable: false };
}

/**
 * "Repair Claude Code Integration" — a distinct, discoverable entry point for the repair-required
 * state, but the same idempotent transaction as Enable: it re-verifies ownership, regenerates a
 * missing or stale wrapper, and reinstalls the statusLine if it was dropped, all without
 * disturbing an already-healthy integration.
 */
export async function repairClaude(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void = () => undefined,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  const notify = options.notify ?? true;
  const outcome = await enableClaudeIntegration(buildDeps(context, onIntegrationChanged));
  if (outcome.kind === 'error') {
    await saveLastError(context.globalState, outcome.message);
    if (notify) void vscode.window.showErrorMessage(outcome.message);
    return {
      status: 'error',
      safeMessage: 'Claude integration could not be repaired.',
      safeErrorCategory: 'configuration-error',
      retryable: false,
    };
  }
  if (outcome.kind === 'enabled') {
    await setEnabled(context.globalState, true);
    await setAwaitingSessionRestart(context.globalState, true);
  }
  await saveLastError(context.globalState, null);
  if (outcome.kind === 'cancelled') {
    if (notify)
      void vscode.window.showInformationMessage('Repair was cancelled; no settings were changed.');
    return { status: 'cancelled', safeErrorCategory: 'cancelled', retryable: false };
  }
  if (notify)
    void vscode.window.showInformationMessage(
      'Repair complete. Restart your Claude Code CLI session, then complete one response to receive usage data.',
    );
  return { status: 'success', retryable: false };
}

export async function disableClaude(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void = () => undefined,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  const notify = options.notify ?? true;
  const outcome = await disableClaudeIntegration(buildDeps(context, onIntegrationChanged));
  if (outcome.kind === 'error') {
    await saveLastError(context.globalState, outcome.message);
    if (notify) void vscode.window.showErrorMessage(outcome.message);
    return {
      status: 'error',
      safeMessage: 'Claude integration could not be disabled.',
      safeErrorCategory: 'configuration-error',
      retryable: false,
    };
  }
  await saveLastError(context.globalState, null);
  if (outcome.kind === 'not-managed') {
    if (notify)
      void vscode.window.showInformationMessage(
        'Claude Code statusLine is not managed by AI Limit Ledger. Nothing changed.',
      );
    return { status: 'success', retryable: false };
  }
  if (outcome.kind === 'conflict') {
    if (notify) void vscode.window.showWarningMessage(outcome.message);
    return {
      status: 'error',
      safeMessage: 'Claude integration could not be disabled because it changed externally.',
      safeErrorCategory: 'external-change',
      retryable: false,
    };
  }
  if (notify) void vscode.window.showInformationMessage('Claude Code integration disabled.');
  return { status: 'success', retryable: false };
}

/**
 * Detects Claude Code via the standalone CLI on PATH or the official `anthropic.claude-code`
 * VS Code extension — a real installed Claude session in this environment is more often driven
 * by the extension than a standalone `claude` binary on PATH.
 */
export function claudeIntegrationAvailable(): boolean {
  return findClaudeCli() || Boolean(vscode.extensions.getExtension(CLAUDE_EXTENSION_ID));
}

/** null when the extension isn't installed or its version can't be read — never "incompatible" on missing data. */
export function claudeVersionCompatible(): boolean | null {
  const version = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)?.packageJSON?.version as
    string | undefined;
  if (!version) return findClaudeCli() ? null : null;
  return isVersionAtLeast(version, MIN_STATUSLINE_CONTRACT_VERSION);
}

/** Which Claude Code surface is detectable — standalone CLI, the VS Code extension, both, or neither. */
export function detectClaudeHostKind(): ClaudeHostKind {
  return detectHostKind(
    findClaudeCli(),
    Boolean(vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)),
  );
}

export function detectClaudeAccessMode(): ClaudeAccessMode {
  return deriveAccessMode(detectClaudeHostKind());
}

/** The installed `anthropic.claude-code` extension's own version, or null if it isn't installed. */
export function getClaudeExtensionVersion(): string | null {
  const version = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)?.packageJSON?.version as
    string | undefined;
  return version ?? null;
}

async function readProjectStatusLine(relativeFile: string): Promise<unknown> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  try {
    const settings = await readSettings(nodeFs(), path.join(root, relativeFile));
    return settings.parsed.statusLine;
  } catch {
    return undefined;
  }
}

export function buildClaudeClassifier(
  context: vscode.ExtensionContext,
): () => Promise<ClaudeProviderClassification> {
  return async () => {
    const [userSettings, projectShared, projectLocal] = await Promise.all([
      readSettings(nodeFs(), settingsPath()).catch(
        () => ({ parsed: {} }) as { parsed: Record<string, unknown> },
      ),
      readProjectStatusLine(path.join('.claude', 'settings.json')),
      readProjectStatusLine(path.join('.claude', 'settings.local.json')),
    ]);
    const ownership = loadOwnership(context.globalState);
    const chainedPath = chainedScriptPathFor(context.globalStorageUri.fsPath, process.platform);
    const standalonePath = standaloneScriptPathFor(
      context.globalStorageUri.fsPath,
      process.platform,
    );
    // "Exists" here means healthy, not merely present: for standalone mode, a wrapper generated
    // by an older extension version is stale even though the file is still there, and must be
    // treated the same as missing so Enable/Repair regenerates it.
    let wrapperFileExists = false;
    const candidatePath = ownership?.wrapperPath ?? standalonePath;
    const mode = ownership?.mode ?? null;
    try {
      const content = await fs.readFile(candidatePath, 'utf8');
      wrapperFileExists =
        mode === 'chained'
          ? true
          : hashContent(content) ===
            standaloneWrapperExpectedHash(process.platform, claudeBridgePath(context));
    } catch {
      wrapperFileExists = false;
    }
    const classification = computeClassification({
      userStatusLine: userSettings.parsed.statusLine,
      projectSharedStatusLine: projectShared,
      projectLocalStatusLine: projectLocal,
      ownershipWrapperPath: ownership?.wrapperPath ?? null,
      chainedPath,
      standalonePath,
      wrapperFileExists,
      cliVersionCompatible: claudeVersionCompatible(),
      awaitingSessionRestart: isAwaitingSessionRestart(context.globalState),
      explicitlyDisabled: isExplicitlyDisabled(context.globalState),
      enabledAt: ownership?.enabledAt ?? null,
      now: Date.now(),
      hostKind: detectClaudeHostKind(),
      extensionVersion: getClaudeExtensionVersion(),
    });
    const autoHealAttempt = loadAutoHealAttempt(context.globalState);
    return {
      ...classification,
      autoHealHealth: autoHealAttempt?.reason ?? null,
      autoRepairEnabled: claudeAutoRepairEnabled(),
      autoHealLastCheckAt: autoHealAttempt?.lastHealthCheckAt ?? null,
      autoHealLastRepairAt: autoHealAttempt?.lastSuccessAt ?? null,
      autoHealLastRepairReason: autoHealAttempt?.lastRepairReason ?? null,
      wrapperVersion: ownership?.wrapperVersion ?? null,
      expectedWrapperVersion: CURRENT_WRAPPER_VERSION,
    };
  };
}

export function buildOnSnapshotConfirmed(context: vscode.ExtensionContext): () => Promise<void> {
  return () => setAwaitingSessionRestart(context.globalState, false);
}

export async function getClaudeDiagnosticsReport(
  context: vscode.ExtensionContext,
): Promise<DiagnosticsReport> {
  const [projectShared, projectLocal] = await Promise.all([
    readProjectStatusLine(path.join('.claude', 'settings.json')),
    readProjectStatusLine(path.join('.claude', 'settings.local.json')),
  ]);
  return diagnoseClaudeIntegration({
    fs: nodeFs(),
    clock: () => new Date(),
    platform: process.platform,
    cliAvailable: claudeIntegrationAvailable,
    secrets: context.secrets,
    globalState: context.globalState,
    settingsPath: settingsPath(),
    snapshotPath: claudeBridgePath(context),
    globalStorageDir: context.globalStorageUri.fsPath,
    projectSharedStatusLine: projectShared,
    projectLocalStatusLine: projectLocal,
    runWrapper: spawnWrapperOnce,
    hostKind: detectClaudeHostKind(),
  });
}

/** Redacted auto-heal bookkeeping appended to the plain-text diagnostics report. No file paths or sensitive values. */
function formatAutoHealDiagnostics(context: vscode.ExtensionContext): string {
  const consent = Boolean(loadConsent(context.globalState));
  const attempt = loadAutoHealAttempt(context.globalState);
  const lines = [
    `Auto-repair consent present: ${consent ? 'yes' : 'no'}`,
    `Auto-repair enabled: ${claudeAutoRepairEnabled() ? 'yes' : 'no'}`,
    `Auto-heal last health state: ${attempt?.reason ?? 'not available'}`,
    `Auto-heal last attempt: ${attempt?.lastAttemptAt ? new Date(attempt.lastAttemptAt).toISOString() : 'not available'}`,
    `Auto-heal last success: ${attempt?.lastSuccessAt ? new Date(attempt.lastSuccessAt).toISOString() : 'not available'}`,
    `Auto-heal attempt count (current reason): ${attempt?.attemptCount ?? 0}`,
    `Auto-heal backoff until: ${attempt?.backoffUntil ? new Date(attempt.backoffUntil).toISOString() : 'not applicable'}`,
  ];
  return lines.join('\n');
}

export async function diagnoseClaude(context: vscode.ExtensionContext): Promise<string> {
  const report = await getClaudeDiagnosticsReport(context);
  const base = formatDiagnosticsReport(report, process.env.USERPROFILE ?? process.env.HOME ?? '');
  return `${base}\n${formatAutoHealDiagnostics(context)}`;
}

async function buildAutoHealDeps(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void,
): Promise<AutoHealDeps> {
  const [projectShared, projectLocal] = await Promise.all([
    readProjectStatusLine(path.join('.claude', 'settings.json')),
    readProjectStatusLine(path.join('.claude', 'settings.local.json')),
  ]);
  return {
    fs: nodeFs(),
    clock: () => new Date(),
    platform: process.platform,
    cliAvailable: claudeIntegrationAvailable,
    secrets: context.secrets,
    globalState: context.globalState,
    settingsPath: settingsPath(),
    snapshotPath: claudeBridgePath(context),
    globalStorageDir: context.globalStorageUri.fsPath,
    projectSharedStatusLine: projectShared,
    projectLocalStatusLine: projectLocal,
    runWrapper: spawnWrapperOnce,
    hostKind: detectClaudeHostKind(),
    refreshIntervalSeconds: claudeRefreshIntervalSeconds(),
    autoRepairEnabled: claudeAutoRepairEnabled(),
    // Every auto-repairable state (wrapper-missing/outdated/corrupt, statusline-missing,
    // refresh-interval-mismatch) only ever needs the standalone wrapper path, never chaining, so
    // platform support is never the gate for those — this stays true for forward-compat only.
    platformSupported: true,
    snapshotStaleAfterSeconds: SNAPSHOT_STALE_AFTER_SECONDS,
    concurrentChangeDetected: false,
    onIntegrationChanged,
    notify: (message: string) => void vscode.window.showInformationMessage(message),
  };
}

/**
 * The single automatic entry point: classifies current health and, only when safe and consented,
 * repairs it using the same transaction the manual commands use. Never prompts. Safe to call from
 * activation, watcher callbacks, or a periodic timer — gated internally by single-flight,
 * per-reason cooldown/backoff, and a 3-attempt cap (see `ClaudeAutoHealRunner`).
 */
export async function autoHealClaude(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void = () => undefined,
  options: { resetAttempts?: boolean } = {},
): Promise<AutoHealRunResult> {
  const deps = await buildAutoHealDeps(context, onIntegrationChanged);
  return runAutoHeal(deps, options);
}

export async function enableClaudeAutoRepair(
  context: vscode.ExtensionContext,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  await setClaudeAutoRepairEnabled(true);
  if (options.notify ?? true)
    void vscode.window.showInformationMessage('Automatic repair for Claude Code enabled.');
  void autoHealClaude(context, undefined, { resetAttempts: true });
  return { status: 'success', retryable: false };
}

export async function disableClaudeAutoRepair(
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  await setClaudeAutoRepairEnabled(false);
  if (options.notify ?? true)
    void vscode.window.showInformationMessage(
      'Automatic repair for Claude Code disabled. Claude Code integration itself remains enabled.',
    );
  return { status: 'success', retryable: false };
}

export async function recheckClaudeIntegrationHealth(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void = () => undefined,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  const result = await autoHealClaude(context, onIntegrationChanged, { resetAttempts: true });
  if (result.outcome?.kind === 'enabled') return { status: 'success', retryable: true };
  if (options.notify ?? true)
    void vscode.window.showInformationMessage(
      `Claude Code integration health: ${result.assessment.state}. ${result.assessment.safeNextAction}`,
    );
  return { status: 'success', retryable: true };
}

/** Opens Anthropic's official Claude Code documentation in the system browser. Never installs anything. */
export async function openClaudeInstallGuide(
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  return openProviderLink('claude-install', options);
}

/**
 * Opens a VS Code integrated terminal and runs the already-installed `claude` CLI, exactly as a
 * user would type it themselves. Never downloads or executes a remote installer.
 */
export function launchClaudeInTerminal(options: { notify?: boolean } = {}): CommandExecutionResult {
  if (!findClaudeCli()) {
    if (options.notify ?? true)
      void vscode.window.showWarningMessage(
        'The Claude Code CLI was not found on PATH. Install it first, then try again.',
      );
    return {
      status: 'error',
      safeMessage: 'The Claude Code CLI was not found.',
      safeErrorCategory: 'executable-not-found',
      retryable: false,
    };
  }
  const terminal = vscode.window.createTerminal('Claude Code');
  terminal.show();
  terminal.sendText('claude');
  return { status: 'success', retryable: false };
}

export async function copyClaudeDiagnostics(
  context: vscode.ExtensionContext,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  try {
    const text = await diagnoseClaude(context);
    await vscode.env.clipboard.writeText(text);
    if (options.notify ?? true)
      void vscode.window.showInformationMessage(
        'Redacted Claude Code diagnostics copied to the clipboard.',
      );
    return { status: 'success', retryable: true };
  } catch {
    if (options.notify ?? true)
      void vscode.window.showErrorMessage('Could not copy redacted Claude diagnostics.');
    return { status: 'error', safeMessage: 'Could not copy diagnostics.', retryable: true };
  }
}

/**
 * Public commands contributed by `anthropic.claude-code` (read from its installed package.json)
 * that open its UI, tried in order of preference. `claude-vscode.sidebar.open` opens its
 * sidebar view directly; `claude-vscode.editor.openLast` is a documented fallback. Neither is an
 * undocumented internal module — both are declared in the extension's own `contributes.commands`.
 */
export const OPEN_CLAUDE_COMMAND_CANDIDATES = [
  'claude-vscode.sidebar.open',
  'claude-vscode.editor.openLast',
];

/** Pure selection logic, independently testable: the first candidate that is actually registered, or null. */
export function pickOpenClaudeCommand(registeredCommands: readonly string[]): string | null {
  return (
    OPEN_CLAUDE_COMMAND_CANDIDATES.find((candidate) => registeredCommands.includes(candidate)) ??
    null
  );
}

/** Opens the official Claude Code UI via its own contributed command; falls back to its Extensions details page if no such command is registered. */
export async function openClaudeCode(
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  const registered = await vscode.commands.getCommands(true);
  const command = pickOpenClaudeCommand(registered);
  if (command) {
    await vscode.commands.executeCommand(command);
    return { status: 'success', retryable: true };
  }
  if (options.notify ?? true)
    void vscode.window.showInformationMessage(
      'Could not find a public command to open Claude Code directly. Opening its Extensions page instead.',
    );
  await vscode.commands.executeCommand('extension.open', CLAUDE_EXTENSION_ID);
  return { status: 'success', retryable: true };
}

export const USAGE_COMMAND_TEXT = '/usage';

/** Copies the literal `/usage` slash command so the user can paste it into Claude Code themselves. Never reads the result. */
export async function copyClaudeUsageCommand(
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  try {
    await vscode.env.clipboard.writeText(USAGE_COMMAND_TEXT);
    if (options.notify ?? true)
      void vscode.window.showInformationMessage(
        'Copied /usage. Paste it into Claude Code to view current usage.',
      );
    return { status: 'success', retryable: true };
  } catch {
    if (options.notify ?? true) void vscode.window.showErrorMessage('Could not copy /usage.');
    return { status: 'error', safeMessage: 'Could not copy /usage.', retryable: true };
  }
}

/** Neutral documentation link — never labeled required/recommended/fix. */
export async function openCliEnhancedModeDocs(
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  return openProviderLink('claude-vscode-docs', options);
}

const EXPERIMENTAL_OAUTH_USAGE_SETTING = 'claude.experimentalOAuthUsage.enabled';
const EXPERIMENTAL_OAUTH_REFRESH_SECONDS_SETTING = 'claude.experimentalOAuthUsage.refreshSeconds';
const DEFAULT_EXPERIMENTAL_OAUTH_REFRESH_SECONDS = 120;
const MIN_EXPERIMENTAL_OAUTH_REFRESH_SECONDS = 120;
const MAX_EXPERIMENTAL_OAUTH_REFRESH_SECONDS = 3600;

/** Reads the `aiLimitLedger.claude.experimentalOAuthUsage.enabled` machine-scope setting; defaults to opted-out. */
export function claudeOAuthUsageEnabled(): boolean {
  if (effectiveSettingsProvider) return effectiveSettingsProvider().experimental.claudeOAuthEnabled;
  return vscode.workspace
    .getConfiguration('aiLimitLedger')
    .get<boolean>(EXPERIMENTAL_OAUTH_USAGE_SETTING, false);
}

async function setClaudeOAuthUsageEnabled(enabled: boolean): Promise<void> {
  if (settingsUpdater) return settingsUpdater('claudeOAuthEnabled', enabled);
  await vscode.workspace
    .getConfiguration('aiLimitLedger')
    .update(EXPERIMENTAL_OAUTH_USAGE_SETTING, enabled, vscode.ConfigurationTarget.Global);
}

/** Reads and clamps `aiLimitLedger.claude.experimentalOAuthUsage.refreshSeconds`; never trusts an out-of-range user value. */
export function claudeOAuthUsageRefreshSeconds(): number {
  if (effectiveSettingsProvider) return effectiveSettingsProvider().refresh.claudeOAuthSeconds;
  const configured = vscode.workspace
    .getConfiguration('aiLimitLedger')
    .get<number>(
      EXPERIMENTAL_OAUTH_REFRESH_SECONDS_SETTING,
      DEFAULT_EXPERIMENTAL_OAUTH_REFRESH_SECONDS,
    );
  if (!Number.isFinite(configured)) return DEFAULT_EXPERIMENTAL_OAUTH_REFRESH_SECONDS;
  return Math.min(
    MAX_EXPERIMENTAL_OAUTH_REFRESH_SECONDS,
    Math.max(MIN_EXPERIMENTAL_OAUTH_REFRESH_SECONDS, configured),
  );
}

export function claudeOAuthUsageConsentPresent(context: vscode.ExtensionContext): boolean {
  return Boolean(loadOAuthUsageConsent(context.globalState));
}

/**
 * Opens AI Limit Ledger's own bundled explanation of the experimental CLI-free usage transport —
 * a local file shipped inside the extension, never a guessed or external URL. "Learn More" in the
 * consent dialog uses this and only this; it never enables anything by itself.
 */
export async function openExperimentalClaudeUsageDocs(
  context: vscode.ExtensionContext,
): Promise<void> {
  const uri = vscode.Uri.joinPath(context.extensionUri, 'docs', 'EXPERIMENTAL_CLAUDE_USAGE.md');
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

async function showExperimentalOAuthConsentDialog(
  context: vscode.ExtensionContext,
): Promise<'enable' | 'cancel'> {
  const ENABLE = localization.t('experimentalConsentEnable');
  const LEARN_MORE = localization.t('claudeOAuthLearnMore');
  const choice = await vscode.window.showWarningMessage(
    localization.t('claudeOAuthConsent'),
    { modal: true },
    ENABLE,
    LEARN_MORE,
  );
  if (choice === LEARN_MORE) {
    await openExperimentalClaudeUsageDocs(context);
    return 'cancel';
  }
  return choice === ENABLE ? 'enable' : 'cancel';
}

/**
 * "Enable CLI-free Claude Usage" — a separate, explicit opt-in from the status-line integration's
 * own consent. Records non-sensitive consent metadata only (version/timestamp/transport version —
 * never a token, hash, or account identity), flips the machine-scope enabled setting, and installs
 * the activity-only Stop/StopFailure/SessionStart hook bridge. Never reads a credential itself —
 * that only ever happens inside `ClaudeOAuthUsageService`, and only once this setting is on.
 */
export async function enableClaudeOAuthUsage(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void = () => undefined,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  const notify = options.notify ?? true;
  const choice = await showExperimentalOAuthConsentDialog(context);
  if (choice !== 'enable') {
    if (notify) void vscode.window.showInformationMessage(localization.t('claudeOAuthNotEnabled'));
    return { status: 'cancelled', safeErrorCategory: 'cancelled', retryable: false };
  }
  await saveOAuthUsageConsent(context.globalState, {
    consentVersion: OAUTH_USAGE_CONSENT_VERSION,
    acceptedAt: new Date().toISOString(),
    transportVersion: OAUTH_USAGE_TRANSPORT_VERSION,
  });
  await setClaudeOAuthUsageEnabled(true);
  const hookResult = await installActivityHooks(
    nodeFs(),
    settingsPath(),
    context.globalStorageUri.fsPath,
    process.platform,
    claudeHookActivityPath(context),
  );
  if (!hookResult.ok) {
    if (notify)
      void vscode.window.showWarningMessage(
        hookResult.message ?? localization.t('claudeOAuthHookWarning'),
      );
  }
  onIntegrationChanged();
  if (notify) void vscode.window.showInformationMessage(localization.t('claudeOAuthEnabled'));
  return { status: 'success', retryable: false };
}

/** "Disable CLI-free Claude Usage" — turns the setting off and removes only AI Limit Ledger's own activity hook entries. */
export async function disableClaudeOAuthUsage(
  context: vscode.ExtensionContext,
  onIntegrationChanged: () => void = () => undefined,
  options: { notify?: boolean } = {},
): Promise<CommandExecutionResult> {
  const notify = options.notify ?? true;
  await setClaudeOAuthUsageEnabled(false);
  const result = await uninstallActivityHooks(
    nodeFs(),
    settingsPath(),
    context.globalStorageUri.fsPath,
    process.platform,
  );
  if (!result.ok) {
    if (notify)
      void vscode.window.showWarningMessage(
        result.message ?? localization.t('claudeOAuthHookRemoveWarning'),
      );
  }
  onIntegrationChanged();
  if (notify) void vscode.window.showInformationMessage(localization.t('claudeOAuthDisabled'));
  return { status: 'success', retryable: false };
}
