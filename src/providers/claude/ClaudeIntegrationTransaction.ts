import * as path from 'node:path';
import { MAX_INPUT_BYTES } from '../ClaudeStatusLine';
import {
  classifyOwnership,
  commandTargetsPath,
  hashContent,
  hashStatusLine,
  type OwnershipClassification,
} from './ClaudeOwnership';
import {
  clearLegacyPrevious,
  clearOwnership,
  clearRecovery,
  isEnabled,
  loadConsent,
  loadOwnership,
  loadRecovery,
  readLegacyPrevious,
  saveConsent,
  saveOwnership,
  saveRecovery,
  setAwaitingSessionRestart,
  setExplicitlyDisabled,
  setEnabled,
  CONSENT_VERSION,
  type ConsentMetadata,
  type GlobalStateLike,
  type SecretsLike,
} from './ClaudeRecoveryStore';
import {
  asJsonObject,
  atomicWriteFile,
  byteExactBackup,
  readSettings,
  writeStatusLineOnly,
  type FsLike,
  type Json,
} from './ClaudeSettingsFile';
import {
  generatePosixWrapperScript,
  generateStandalonePosixScript,
  generateStandaloneWindowsScript,
  generateWindowsWrapperScript,
} from './ClaudeWrapperGenerator';
import type { RunOptions, RunResult } from './ClaudeWrapperRunner';
import {
  CURRENT_SCHEMA_VERSION,
  CURRENT_WRAPPER_VERSION,
  OWNER_MARKER,
  type DisableOutcome,
  type EnableOutcome,
  type IntegrationMode,
  type OwnershipMetadata,
} from './types';

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const WRAPPER_TIMEOUT_MS = 5_000;
const SELF_CHECK_TIMEOUT_MS = 8_000;
/** How many times to retry committing a statusLine write after an unexpected concurrent change. */
const MAX_COMMIT_RETRIES = 2;

export interface ConfirmUi {
  /** The single, simplified upfront disclosure. Returns true to continue. */
  showIntro(): Promise<boolean>;
  /**
   * The one-time (and re-offered-on-Enable) automatic-repair consent choice. Never shown by the
   * auto-heal runner or by Repair — only by an explicit user-initiated Enable.
   */
  showConsent(previousChoice: 'auto' | 'manual' | undefined): Promise<'auto' | 'manual' | 'cancel'>;
  /** Shown only when an existing, third-party statusLine is found. Never a second explanatory modal. */
  chooseExistingStatusLineAction(
    preserveAvailable: boolean,
  ): Promise<'preserve' | 'replace' | 'cancel'>;
  confirmRepair(): Promise<boolean>;
  notify(message: string): void;
  warn(message: string): void;
}

export interface ClaudeIntegrationDeps {
  fs: FsLike;
  clock: () => Date;
  platform: NodeJS.Platform;
  confirm: ConfirmUi;
  runWrapper: (
    wrapperPath: string,
    stdin: string,
    platform: NodeJS.Platform,
    options?: RunOptions,
  ) => Promise<RunResult>;
  secrets: SecretsLike;
  globalState: GlobalStateLike;
  settingsPath: string;
  globalStorageDir: string;
  snapshotPath: string;
  onIntegrationChanged: () => void;
  /**
   * Seconds Claude Code should use for its own status-line refresh cadence, written into
   * `statusLine.refreshInterval` only for a wrapper AI Limit Ledger installs outright
   * (standalone mode). Defaults to 15 when omitted. Chained mode never sets or overrides this
   * field — the pre-existing statusLine's own `refreshInterval` (if any) is preserved untouched.
   */
  refreshIntervalSeconds?: number;
  /**
   * True only for an explicit, user-initiated "Enable Claude Code Integration" command. Repair
   * and the auto-heal runner both reuse this same transaction but never set this flag, so the
   * consent dialog is only ever shown from the one entry point the spec requires.
   */
  promptConsent?: boolean;
  /**
   * Persists the user's automatic-repair choice as the `aiLimitLedger.claude.autoRepair`
   * machine-scope setting. Only invoked when `promptConsent` is true and the user did not cancel.
   */
  setAutoRepairEnabled?: (enabled: boolean) => Promise<void>;
  /** Current `aiLimitLedger.claude.autoRepair` value, used only to pre-select the consent dialog. */
  getAutoRepairEnabled?: () => boolean;
}

const DEFAULT_REFRESH_INTERVAL_SECONDS = 15;

export function chainingCapableByPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

export function standaloneScriptPathFor(
  globalStorageDir: string,
  platform: NodeJS.Platform,
): string {
  return path.join(
    globalStorageDir,
    platform === 'win32' ? 'claude-bridge.ps1' : 'claude-bridge.js',
  );
}

export function chainedScriptPathFor(globalStorageDir: string, platform: NodeJS.Platform): string {
  return path.join(
    globalStorageDir,
    platform === 'win32' ? 'claude-bridge-chained.ps1' : 'claude-bridge-chained.js',
  );
}

function standaloneScriptPath(deps: ClaudeIntegrationDeps): string {
  return standaloneScriptPathFor(deps.globalStorageDir, deps.platform);
}

function chainedScriptPath(deps: ClaudeIntegrationDeps): string {
  return chainedScriptPathFor(deps.globalStorageDir, deps.platform);
}

function commandFor(scriptPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
    : `node "${scriptPath}"`;
}

async function unlinkQuietly(fs: FsLike, filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * The exact standalone wrapper content the current extension version would generate for this
 * platform/snapshot path. Used both to install a fresh wrapper and, by diagnostics, to detect
 * whether an on-disk wrapper is stale (generated by an older version) without executing it.
 */
export function standaloneWrapperExpectedContent(
  platform: NodeJS.Platform,
  snapshotPath: string,
): string {
  return platform === 'win32'
    ? generateStandaloneWindowsScript(snapshotPath, MAX_INPUT_BYTES)
    : generateStandalonePosixScript(snapshotPath, MAX_INPUT_BYTES);
}

export function standaloneWrapperExpectedHash(
  platform: NodeJS.Platform,
  snapshotPath: string,
): string {
  return hashContent(standaloneWrapperExpectedContent(platform, snapshotPath));
}

/** Cheap sanity check on generated wrapper text — catches a broken template before it ever runs. */
function validateWrapperStructure(script: string): boolean {
  return typeof script === 'string' && script.trim().length > 0 && script.includes('schemaVersion');
}

/**
 * Dynamically proves the wrapper generator actually works on this machine (PowerShell/Node
 * available, quoting valid) by running an equivalent script against a throwaway snapshot path —
 * never the real snapshot file, so a self-check can never clobber genuine usage data. Mirrors
 * the existing chained-wrapper self-check contract: success is "the process ran to completion
 * without timing out or crashing," the same bar `deps.runWrapper` is faked to for unit tests.
 */
async function selfCheckStandaloneWrapper(deps: ClaudeIntegrationDeps): Promise<boolean> {
  const suffix = Math.random().toString(36).slice(2);
  const checkPath = path.join(
    deps.globalStorageDir,
    `claude-bridge-selfcheck-${suffix}${deps.platform === 'win32' ? '.ps1' : '.js'}`,
  );
  const tempSnapshotPath = `${checkPath}.snapshot.json`;
  const script = standaloneWrapperExpectedContent(deps.platform, tempSnapshotPath);
  try {
    await atomicWriteFile(
      deps.fs,
      checkPath,
      script,
      deps.platform === 'win32' ? undefined : 0o700,
    );
    const result = await deps.runWrapper(
      checkPath,
      JSON.stringify({ version: '0.0.0-selfcheck', model: {}, rate_limits: {} }),
      deps.platform,
      { timeoutMs: SELF_CHECK_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES },
    );
    return !result.timedOut && result.exitCode !== null;
  } catch {
    return false;
  } finally {
    await unlinkQuietly(deps.fs, checkPath);
    await unlinkQuietly(deps.fs, tempSnapshotPath);
  }
}

/**
 * Stages the current-version standalone wrapper, structurally validates it, proves it via a
 * fixture-path self-check, then atomically installs it — never deleting a previously-working
 * wrapper until the replacement has passed validation. Returns the previous content (if any) so
 * the caller can roll the wrapper back if the settings commit that follows fails.
 */
async function installStandaloneWrapper(
  deps: ClaudeIntegrationDeps,
  scriptPath: string,
): Promise<{ ok: true; previousContent: string | null } | { ok: false; message: string }> {
  let previousContent: string | null = null;
  try {
    previousContent = await deps.fs.readFile(scriptPath, 'utf8');
  } catch {
    previousContent = null;
  }

  const script = standaloneWrapperExpectedContent(deps.platform, deps.snapshotPath);
  if (!validateWrapperStructure(script)) {
    return {
      ok: false,
      message:
        'The generated AI Limit Ledger bridge failed structural validation. No changes were made.',
    };
  }
  if (!(await selfCheckStandaloneWrapper(deps))) {
    return {
      ok: false,
      message: 'The AI Limit Ledger bridge failed its self-check. No changes were made.',
    };
  }

  const stagingPath = `${scriptPath}.staging`;
  try {
    await atomicWriteFile(
      deps.fs,
      stagingPath,
      script,
      deps.platform === 'win32' ? undefined : 0o700,
    );
    await deps.fs.rename(stagingPath, scriptPath);
  } catch {
    await unlinkQuietly(deps.fs, stagingPath);
    return {
      ok: false,
      message: 'Could not install the AI Limit Ledger bridge. No changes were made.',
    };
  }
  return { ok: true, previousContent };
}

async function rollBackWrapper(
  deps: ClaudeIntegrationDeps,
  scriptPath: string,
  previousContent: string | null,
): Promise<void> {
  if (previousContent !== null) {
    try {
      await atomicWriteFile(
        deps.fs,
        scriptPath,
        previousContent,
        deps.platform === 'win32' ? undefined : 0o700,
      );
    } catch {
      /* best-effort rollback; the previous file may already be gone */
    }
  } else {
    await unlinkQuietly(deps.fs, scriptPath);
  }
}

interface CommitOutcome {
  ok: boolean;
  reason?: 'external-change' | 'error';
  message?: string;
}

/**
 * Writes the statusLine field and verifies — by reading the file back — that the write actually
 * committed as intended. Unrelated top-level settings are always preserved (`writeStatusLineOnly`
 * re-reads the file immediately before writing). Only the statusLine field itself is guarded
 * against a concurrent external writer: if it was replaced with something other than our intended
 * value or its last-known-prior value, this aborts as `external-change` and never overwrites the
 * other process's value — it will not fight indefinitely with an external settings manager.
 */
async function commitStatusLine(
  deps: ClaudeIntegrationDeps,
  priorStatusLine: unknown,
  newStatusLine: unknown,
): Promise<CommitOutcome> {
  let expectedPrior = priorStatusLine;
  for (let attempt = 0; attempt <= MAX_COMMIT_RETRIES; attempt += 1) {
    try {
      await writeStatusLineOnly(deps.fs, deps.settingsPath, newStatusLine);
    } catch {
      return { ok: false, reason: 'error', message: 'Could not update Claude Code settings.' };
    }
    const verify = await readSettings(deps.fs, deps.settingsPath);
    const committed = verify.parsed.statusLine;
    if (JSON.stringify(committed) === JSON.stringify(newStatusLine)) {
      return { ok: true };
    }
    if (JSON.stringify(committed) === JSON.stringify(expectedPrior)) {
      // Our write did not appear to take (a transient filesystem hiccup) — safe to retry.
      continue;
    }
    // Something else wrote a different statusLine between our write and our verification read.
    expectedPrior = committed;
    return {
      ok: false,
      reason: 'external-change',
      message:
        'Another process changed the Claude Code statusLine while AI Limit Ledger was applying its change. That value was preserved and nothing was overwritten.',
    };
  }
  return {
    ok: false,
    reason: 'error',
    message: 'Could not verify the Claude Code statusLine after multiple attempts.',
  };
}

async function ownershipRecord(
  deps: ClaudeIntegrationDeps,
  mode: IntegrationMode,
  wrapperPath: string | null,
  originalStatusLineHash: string | null,
): Promise<OwnershipMetadata> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    mode,
    wrapperPath,
    wrapperVersion: CURRENT_WRAPPER_VERSION,
    originalStatusLineHash,
    enabledAt: deps.clock().toISOString(),
    ownerMarker: OWNER_MARKER,
  };
}

async function activateStandalone(
  deps: ClaudeIntegrationDeps,
  originalStatusLineHash: string | null,
  priorStatusLine: unknown,
): Promise<EnableOutcome> {
  const scriptPath = standaloneScriptPath(deps);

  const install = await installStandaloneWrapper(deps, scriptPath);
  if (!install.ok) return { kind: 'error', message: install.message };

  // No `_aiLimitLedger` marker: Claude Code's statusLine schema has no passthrough and
  // silently strips unrecognized properties on any settings rewrite. Ownership is
  // recognized structurally (see ClaudeOwnership.classifyOwnership), not via this field.
  const statusLine: Json = {
    type: 'command',
    command: commandFor(scriptPath, deps.platform),
    refreshInterval: deps.refreshIntervalSeconds ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
  };
  const commit = await commitStatusLine(deps, priorStatusLine, statusLine);
  if (!commit.ok) {
    await rollBackWrapper(deps, scriptPath, install.previousContent);
    return {
      kind: 'error',
      message:
        commit.message ?? 'Could not set up the AI Limit Ledger bridge. No changes were made.',
    };
  }

  await saveOwnership(
    deps.globalState,
    await ownershipRecord(deps, 'standalone', scriptPath, originalStatusLineHash),
  );
  await setEnabled(deps.globalState, true);
  await setExplicitlyDisabled(deps.globalState, false);
  // A currently-running Claude Code session has not reloaded this change — never assume it has.
  await setAwaitingSessionRestart(deps.globalState, true);
  deps.onIntegrationChanged();
  return { kind: 'enabled', mode: 'standalone' };
}

async function ensureOwnedIntegrationHealthy(
  deps: ClaudeIntegrationDeps,
  classification: OwnershipClassification,
): Promise<EnableOutcome> {
  const ownership = loadOwnership(deps.globalState);
  const mode = ownership?.mode ?? classification.mode ?? 'standalone';
  const wrapperPath =
    ownership?.wrapperPath ?? classification.matchedPath ?? standaloneScriptPath(deps);

  // Existence alone is not "healthy": a wrapper generated by an older extension version is
  // stale even though it is present, so standalone mode also verifies its content hash against
  // what the current generator would produce. Chained mode's inner command is dynamic and
  // recovered from secret storage, so it is checked for presence only here — full staleness
  // detection for chained wrappers is out of scope for this repair path.
  let wrapperOk: boolean;
  if (mode === 'standalone') {
    try {
      const content = await deps.fs.readFile(wrapperPath, 'utf8');
      wrapperOk =
        hashContent(content) === standaloneWrapperExpectedHash(deps.platform, deps.snapshotPath);
    } catch {
      wrapperOk = false;
    }
  } else {
    try {
      await deps.fs.readFile(wrapperPath, 'utf8');
      wrapperOk = true;
    } catch {
      wrapperOk = false;
    }
  }

  if (wrapperOk) {
    // Marker may have been silently stripped by Claude Code's settings schema even though the
    // wrapper is intact and healthy — (re)persist ownership metadata so future checks don't
    // need to fall back to structural inference.
    await saveOwnership(
      deps.globalState,
      await ownershipRecord(deps, mode, wrapperPath, ownership?.originalStatusLineHash ?? null),
    );
    await setEnabled(deps.globalState, true);
    await setExplicitlyDisabled(deps.globalState, false);
    await setAwaitingSessionRestart(deps.globalState, true);
    deps.onIntegrationChanged();
    return { kind: 'enabled', mode };
  }
  const repair = await deps.confirm.confirmRepair();
  if (!repair) return { kind: 'cancelled' };
  const settingsNow = await readSettings(deps.fs, deps.settingsPath);
  if (mode === 'chained') {
    const recovery = await loadRecovery(deps.secrets);
    if (!recovery?.present) {
      return {
        kind: 'error',
        message:
          'The chained wrapper is missing and the original status line could not be recovered. Disable and re-enable to reset.',
      };
    }
    return preserveAndIntegrate(deps, settingsNow.raw, recovery.statusLine);
  }
  return activateStandalone(
    deps,
    ownership?.originalStatusLineHash ?? null,
    settingsNow.parsed.statusLine,
  );
}

async function replaceExisting(deps: ClaudeIntegrationDeps): Promise<EnableOutcome> {
  // No whole-file raw-equality precheck here: an unrelated field changing between the initial
  // read (used only to decide the UI prompt) and now is expected and must not abort the flow —
  // `writeStatusLineOnly` re-reads immediately before writing, so unrelated fields are preserved
  // regardless. Only the statusLine field itself is guarded, by `commitStatusLine` below.
  const settings = await readSettings(deps.fs, deps.settingsPath);
  const original = settings.parsed.statusLine;
  await byteExactBackup(deps.fs, deps.settingsPath, settings.raw, deps.clock);
  await saveRecovery(deps.secrets, original);
  return activateStandalone(deps, hashStatusLine(original), original);
}

async function preserveAndIntegrate(
  deps: ClaudeIntegrationDeps,
  currentRaw: string,
  original: unknown,
): Promise<EnableOutcome> {
  const originalObject = asJsonObject(original);
  const innerCommand = originalObject?.command;
  if (
    originalObject?.type !== 'command' ||
    typeof innerCommand !== 'string' ||
    !innerCommand.trim()
  ) {
    return {
      kind: 'error',
      message:
        'The existing statusLine is not a runnable command entry, so it cannot be chained. Use "Replace after backup" instead.',
    };
  }
  if (!chainingCapableByPlatform(deps.platform)) {
    return { kind: 'error', message: 'Preserve and integrate is not available on this platform.' };
  }

  const finalPath = chainedScriptPath(deps);
  const stagingPath = `${finalPath}.staging`;
  const script =
    deps.platform === 'win32'
      ? generateWindowsWrapperScript({
          snapshotPath: deps.snapshotPath,
          innerCommand,
          maxInputBytes: MAX_INPUT_BYTES,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          timeoutMs: WRAPPER_TIMEOUT_MS,
          wrapperVersion: CURRENT_WRAPPER_VERSION,
        })
      : generatePosixWrapperScript({
          snapshotPath: deps.snapshotPath,
          innerCommand,
          maxInputBytes: MAX_INPUT_BYTES,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          timeoutMs: WRAPPER_TIMEOUT_MS,
          wrapperVersion: CURRENT_WRAPPER_VERSION,
        });

  const rollback = async (message: string): Promise<EnableOutcome> => {
    await unlinkQuietly(deps.fs, stagingPath);
    await unlinkQuietly(deps.fs, finalPath);
    return { kind: 'error', message };
  };

  try {
    await atomicWriteFile(
      deps.fs,
      stagingPath,
      script,
      deps.platform === 'win32' ? undefined : 0o700,
    );
  } catch {
    return rollback('Could not write the chained wrapper script. No settings were changed.');
  }

  let selfCheck: RunResult;
  try {
    selfCheck = await deps.runWrapper(
      stagingPath,
      JSON.stringify({ version: '0.0.0-selfcheck', model: {}, rate_limits: {} }),
      deps.platform,
      { timeoutMs: SELF_CHECK_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES },
    );
  } catch {
    return rollback('The chained wrapper failed its self-check. No settings were changed.');
  }
  if (selfCheck.timedOut || selfCheck.exitCode === null) {
    return rollback('The chained wrapper failed its self-check. No settings were changed.');
  }

  try {
    await deps.fs.rename(stagingPath, finalPath);
  } catch {
    return rollback('Could not activate the chained wrapper. No settings were changed.');
  }

  const newStatusLine: Json = {
    ...originalObject,
    command: commandFor(finalPath, deps.platform),
  };

  try {
    await byteExactBackup(deps.fs, deps.settingsPath, currentRaw, deps.clock);
    await saveRecovery(deps.secrets, original);
    await writeStatusLineOnly(deps.fs, deps.settingsPath, newStatusLine);
    const verify = await readSettings(deps.fs, deps.settingsPath);
    const verifyObject = asJsonObject(verify.parsed.statusLine);
    if (!commandTargetsPath(verifyObject?.command, finalPath))
      throw new Error('verification failed');
  } catch {
    try {
      await writeStatusLineOnly(deps.fs, deps.settingsPath, original);
    } catch {
      /* best-effort restore; the timestamped backup remains as a fallback */
    }
    await clearRecovery(deps.secrets);
    return rollback(
      'Could not safely switch Claude Code to the chained wrapper; the previous statusLine was restored.',
    );
  }

  await saveOwnership(
    deps.globalState,
    await ownershipRecord(deps, 'chained', finalPath, hashStatusLine(original)),
  );
  await setEnabled(deps.globalState, true);
  await setExplicitlyDisabled(deps.globalState, false);
  await setAwaitingSessionRestart(deps.globalState, true);
  deps.onIntegrationChanged();
  return { kind: 'enabled', mode: 'chained' };
}

async function recordConsent(deps: ClaudeIntegrationDeps, mode: IntegrationMode): Promise<void> {
  const record: ConsentMetadata = {
    consentVersion: CONSENT_VERSION,
    consentTimestamp: deps.clock().toISOString(),
    integrationMode: mode,
    expectedWrapperVersion: CURRENT_WRAPPER_VERSION,
  };
  await saveConsent(deps.globalState, record);
}

export async function enableClaudeIntegration(deps: ClaudeIntegrationDeps): Promise<EnableOutcome> {
  const proceed = await deps.confirm.showIntro();
  if (!proceed) return { kind: 'cancelled' };

  let autoRepairChoice: 'auto' | 'manual' | undefined;
  if (deps.promptConsent) {
    const previousConsent = loadConsent(deps.globalState);
    const previousChoice: 'auto' | 'manual' | undefined = previousConsent
      ? (deps.getAutoRepairEnabled?.() ?? true)
        ? 'auto'
        : 'manual'
      : undefined;
    const choice = await deps.confirm.showConsent(previousChoice);
    if (choice === 'cancel') return { kind: 'cancelled' };
    autoRepairChoice = choice;
  }

  const finishConsent = async (mode: IntegrationMode): Promise<void> => {
    if (!deps.promptConsent) return;
    await recordConsent(deps, mode);
    if (autoRepairChoice) await deps.setAutoRepairEnabled?.(autoRepairChoice === 'auto');
  };

  let settings;
  try {
    settings = await readSettings(deps.fs, deps.settingsPath);
  } catch {
    return { kind: 'error', message: 'Claude Code settings could not be read safely.' };
  }

  const existing = settings.parsed.statusLine;
  if (existing === undefined) {
    const outcome = await activateStandalone(deps, null, undefined);
    if (outcome.kind === 'enabled') await finishConsent(outcome.mode);
    return outcome;
  }

  const ownership = loadOwnership(deps.globalState);
  const classification = classifyOwnership(
    existing,
    ownership?.wrapperPath,
    chainedScriptPath(deps),
    standaloneScriptPath(deps),
  );
  if (classification.owned) {
    const outcome = await ensureOwnedIntegrationHealthy(deps, classification);
    if (outcome.kind === 'enabled') await finishConsent(outcome.mode);
    return outcome;
  }

  const choice = await deps.confirm.chooseExistingStatusLineAction(
    chainingCapableByPlatform(deps.platform),
  );
  if (choice === 'cancel') return { kind: 'cancelled' };
  const outcome =
    choice === 'replace'
      ? await replaceExisting(deps)
      : await preserveAndIntegrate(deps, settings.raw, existing);
  if (outcome.kind === 'enabled') await finishConsent(outcome.mode);
  return outcome;
}

/**
 * Auto-heal-only repair: the wrapper and ownership are already healthy, but the statusLine's own
 * `refreshInterval` field has drifted from the configured value. Rewrites only that field —
 * every other statusLine property (including a chained mode's inner `command`) is preserved
 * verbatim, and the same verify-and-retry commit path used by every other write here guards
 * against a concurrent external change.
 */
export async function repairRefreshInterval(deps: ClaudeIntegrationDeps): Promise<EnableOutcome> {
  let settings;
  try {
    settings = await readSettings(deps.fs, deps.settingsPath);
  } catch {
    return { kind: 'error', message: 'Claude Code settings could not be read safely.' };
  }
  const current = settings.parsed.statusLine;
  const ownership = loadOwnership(deps.globalState);
  const classification = classifyOwnership(
    current,
    ownership?.wrapperPath,
    chainedScriptPath(deps),
    standaloneScriptPath(deps),
  );
  const referencePath = ownership?.wrapperPath ?? classification.matchedPath;
  const currentObject = asJsonObject(current);
  if (
    !classification.owned ||
    !referencePath ||
    !commandTargetsPath(currentObject?.command, referencePath)
  ) {
    return {
      kind: 'error',
      message:
        'The Claude Code statusLine changed since it was last checked; refreshInterval was not modified.',
    };
  }
  const nextStatusLine: Json = {
    ...currentObject,
    refreshInterval: deps.refreshIntervalSeconds ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
  };
  const commit = await commitStatusLine(deps, current, nextStatusLine);
  if (!commit.ok) {
    return { kind: 'error', message: commit.message ?? 'Could not update refreshInterval.' };
  }
  return { kind: 'enabled', mode: ownership?.mode ?? classification.mode ?? 'standalone' };
}

export async function disableClaudeIntegration(
  deps: ClaudeIntegrationDeps,
): Promise<DisableOutcome> {
  let settings;
  try {
    settings = await readSettings(deps.fs, deps.settingsPath);
  } catch {
    return { kind: 'error', message: 'Claude Code settings could not be read safely.' };
  }

  const current = settings.parsed.statusLine;
  const ownership = loadOwnership(deps.globalState);
  const classification = classifyOwnership(
    current,
    ownership?.wrapperPath,
    chainedScriptPath(deps),
    standaloneScriptPath(deps),
  );
  // "Managed" is decided primarily by our own enabled flag (set only by our own code, and
  // never touched by Claude Code) — not by whether the current command still matches, since an
  // external change to the command is exactly the conflict case we need to detect below, not a
  // reason to treat the statusLine as never having been ours.
  const believedManaged = isEnabled(deps.globalState) || classification.owned;
  if (!believedManaged) return { kind: 'not-managed' };

  const referencePath = ownership?.wrapperPath ?? classification.matchedPath;
  if (!referencePath || !commandTargetsPath(asJsonObject(current)?.command, referencePath)) {
    return {
      kind: 'conflict',
      message:
        'The Claude Code statusLine has changed since AI Limit Ledger set it up. Nothing was overwritten — use manual recovery if you still want to restore the previous value.',
    };
  }

  const recovery = await loadRecovery(deps.secrets);
  const restoreValue = recovery?.present
    ? recovery.statusLine
    : recovery === undefined
      ? readLegacyPrevious(deps.globalState)
      : undefined;

  try {
    await byteExactBackup(deps.fs, deps.settingsPath, settings.raw, deps.clock);
    await writeStatusLineOnly(deps.fs, deps.settingsPath, restoreValue);
  } catch {
    return { kind: 'error', message: 'Could not update Claude Code settings.' };
  }

  if (ownership?.wrapperPath) {
    await unlinkQuietly(deps.fs, ownership.wrapperPath);
    await unlinkQuietly(deps.fs, `${ownership.wrapperPath}.staging`);
  }
  await clearOwnership(deps.globalState);
  await clearRecovery(deps.secrets);
  await clearLegacyPrevious(deps.globalState);
  await setEnabled(deps.globalState, false);
  await setExplicitlyDisabled(deps.globalState, true);
  await setAwaitingSessionRestart(deps.globalState, false);
  deps.onIntegrationChanged();
  return { kind: 'disabled' };
}
