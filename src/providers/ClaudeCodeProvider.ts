import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseClaudeStatusLine } from './ClaudeStatusLine';
import type { ClaudeAccessMode } from './claude/ClaudeAccessMode';
import type { ClaudeHostKind } from './claude/ClaudeHostDetection';
import { computeClaudeState } from './claude/ClaudeStateMachine';
import type { ClaudeUsageCapability } from './claude/ClaudeUsageCapability';
import type {
  ProviderAdapter,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderHealth,
  ProviderSnapshot,
} from './types';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const CONNECTED_STATES = new Set<ProviderAvailability>(['manual-only', 'ready', 'stale']);

/**
 * Real-environment facts the provider cannot determine on its own (project-scope settings,
 * ownership classification, wrapper existence, host detection). Supplied by extension.ts, which
 * has vscode workspace/fs access; omit for the old 3-state behavior (used by existing simple
 * tests).
 */
export interface ClaudeProviderClassification {
  ownedEffective: boolean;
  /** True when any observable scope currently defines a statusLine at all (present, whether ours or not). */
  effectiveStatusLinePresent: boolean;
  shadowedByProject: boolean;
  wrapperExists: boolean;
  cliVersionCompatible: boolean | null;
  awaitingSessionRestart: boolean;
  /** Milliseconds since the integration was last (re-)enabled; null when unknown. */
  msSinceEnabled: number | null;
  hostKind: ClaudeHostKind;
  accessMode: ClaudeAccessMode;
  /** True only after an explicit successful Disable command. */
  explicitlyDisabled?: boolean;
  /** The `anthropic.claude-code` extension's own version, if installed. */
  extensionVersion: string | null;
  /** Auto-heal dashboard/diagnostics surfacing — all optional, purely informational. */
  autoHealHealth?: string | null;
  autoRepairEnabled?: boolean;
  autoHealLastCheckAt?: number | null;
  autoHealLastRepairAt?: number | null;
  autoHealLastRepairReason?: string | null;
  wrapperVersion?: number | null;
  expectedWrapperVersion?: number | null;
}

export class ClaudeCodeProvider implements ProviderAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly capabilities: ProviderCapabilities = { rateLimits: true, usage: true, statusLine: true };
  private snapshot?: ProviderSnapshot;
  private readonly emitter = new vscode.EventEmitter<ProviderSnapshot>();
  readonly onDidChange = this.emitter.event;
  constructor(
    private readonly bridgeFile: string,
    private readonly enabled: () => boolean,
    private readonly cliAvailable: () => boolean = findClaudeCli,
    private readonly classify?: () => Promise<ClaudeProviderClassification>,
    private readonly onSnapshotConfirmed?: () => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}
  async detect(): Promise<boolean> {
    return this.cliAvailable();
  }
  async start(): Promise<void> {
    if (!(await this.detect())) {
      this.snapshot = this.base('unavailable');
      this.emitter.fire(this.snapshot);
      return;
    }
    await this.refresh();
  }
  stop(): void {
    this.emitter.dispose();
  }
  getSnapshot(): ProviderSnapshot | undefined {
    return this.snapshot;
  }
  getDiagnostics(): ProviderHealth {
    return {
      state: this.snapshot?.availability ?? 'integration-required',
      warning: this.snapshot?.warning,
    };
  }
  async refresh(): Promise<ProviderSnapshot | undefined> {
    if (!this.cliAvailable()) {
      this.snapshot = this.base('unavailable');
      this.emitter.fire(this.snapshot);
      return this.snapshot;
    }

    const checkedAt = this.now();
    const trackingEnabled = this.enabled();

    let parsed: ProviderSnapshot | undefined;
    if (trackingEnabled) {
      try {
        const text = await fs.readFile(this.bridgeFile, 'utf8');
        parsed = parseClaudeStatusLine(text);
      } catch {
        parsed = undefined;
      }
    }
    const hasValidSnapshot = Boolean(parsed && parsed.usageWindows.length > 0);

    if (!this.classify) {
      // No phase-3 wiring supplied — preserve the original, simpler 3-state behavior.
      if (!trackingEnabled) {
        this.snapshot = { ...this.base('integration-required'), checkedAt };
      } else {
        this.snapshot = parsed
          ? {
              ...parsed,
              checkedAt,
              lastSuccessfulDataUpdate: parsed.observedAt,
              lastSuccessfulUpdateAt: parsed.observedAt,
            }
          : { ...this.base('waiting-for-first-response'), checkedAt };
      }
      this.emitter.fire(this.snapshot);
      return this.snapshot;
    }

    const classification = await this.classify();
    if (hasValidSnapshot && parsed) {
      const stale = checkedAt - parsed.observedAt > STALE_AFTER_MS;
      this.snapshot = {
        ...parsed,
        availability: stale ? 'stale' : 'ready',
        stale,
        checkedAt,
        lastSuccessfulDataUpdate: parsed.observedAt,
        lastSuccessfulUpdateAt: parsed.observedAt,
        metadata: {
          ...parsed.metadata,
          hostKind: classification.hostKind,
          accessMode: classification.accessMode,
          usageCapability: stale ? 'automatic-checking' : 'automatic-live',
          ...autoHealMetadata(classification),
        },
      };
      await this.onSnapshotConfirmed?.();
      this.emitter.fire(this.snapshot);
      return this.snapshot;
    }

    const { availability, capability } = computeClaudeState({
      cliFound: true,
      cliVersionCompatible: classification.cliVersionCompatible,
      enabled: trackingEnabled,
      explicitlyDisabled: classification.explicitlyDisabled,
      ownedEffective: classification.ownedEffective,
      effectiveStatusLinePresent: classification.effectiveStatusLinePresent,
      shadowedByProject: classification.shadowedByProject,
      wrapperExists: classification.wrapperExists,
      hasValidSnapshot: false,
      snapshotStale: false,
      awaitingSessionRestart: classification.awaitingSessionRestart,
      msSinceEnabled: classification.msSinceEnabled,
      hostKind: classification.hostKind,
      accessMode: classification.accessMode,
    });
    this.snapshot = {
      ...this.base(availability, classification.hostKind, capability, classification),
      checkedAt,
    };
    this.emitter.fire(this.snapshot);
    return this.snapshot;
  }
  private base(
    state: ProviderAvailability,
    hostKind?: ClaudeHostKind,
    capability?: ClaudeUsageCapability,
    classification?: ClaudeProviderClassification,
  ): ProviderSnapshot {
    const now = this.now();
    return {
      providerId: this.id,
      providerName: this.displayName,
      availability: state,
      connected: CONNECTED_STATES.has(state),
      plan: null,
      cliVersion: null,
      metadata: {
        ...(hostKind ? { hostKind } : {}),
        ...(classification?.accessMode ? { accessMode: classification.accessMode } : {}),
        ...(capability ? { usageCapability: capability } : {}),
        ...(classification?.extensionVersion
          ? { extensionVersion: classification.extensionVersion }
          : {}),
        ...(classification ? autoHealMetadata(classification) : {}),
      },
      usageWindows: [],
      source: 'Official Claude Code status-line',
      observedAt: now,
      checkedAt: now,
      stale: false,
      warning: warningFor(state, hostKind),
      capabilities: this.capabilities,
    };
  }
}

/** Flattens the optional auto-heal fields onto `ProviderSnapshot.metadata`'s flat string/number/boolean/null shape. */
function autoHealMetadata(
  classification: ClaudeProviderClassification,
): Record<string, string | boolean | number | null> {
  const out: Record<string, string | boolean | number | null> = {};
  if (classification.autoHealHealth !== undefined)
    out.autoHealHealth = classification.autoHealHealth;
  if (classification.autoRepairEnabled !== undefined)
    out.autoRepairEnabled = classification.autoRepairEnabled;
  if (classification.autoHealLastCheckAt !== undefined)
    out.autoHealLastCheckAt = classification.autoHealLastCheckAt;
  if (classification.autoHealLastRepairAt !== undefined)
    out.autoHealLastRepairAt = classification.autoHealLastRepairAt;
  if (classification.autoHealLastRepairReason !== undefined)
    out.autoHealLastRepairReason = classification.autoHealLastRepairReason;
  if (classification.wrapperVersion !== undefined)
    out.wrapperVersion = classification.wrapperVersion;
  if (classification.expectedWrapperVersion !== undefined)
    out.expectedWrapperVersion = classification.expectedWrapperVersion;
  return out;
}

const UPSTREAM_NOT_INVOKED_NO_CLI_MESSAGE =
  'The Claude Code VS Code host did not invoke the configured status-line command. Usage and reset data cannot be collected through the documented contract on this surface.';

function warningFor(state: ProviderAvailability, hostKind?: ClaudeHostKind): string | undefined {
  switch (state) {
    case 'unavailable':
      return 'Claude Code was not detected. Install the CLI or the official VS Code extension.';
    case 'incompatible-cli':
      return 'The installed Claude Code version is too old for the usage status-line contract.';
    case 'integration-required':
      return 'Claude Code integration is disabled.';
    case 'integration-disabled':
      return 'Claude Code automatic tracking was explicitly disabled.';
    case 'manual-only':
      return 'Automatic usage tracking is not available on this host. Use /usage in Claude Code to check usage manually.';
    case 'external-change':
      return 'The Claude Code statusLine no longer points to AI Limit Ledger. Run Diagnose for details.';
    case 'configuration-shadowed':
      return 'A project-level Claude Code setting is overriding the AI Limit Ledger status line for this workspace.';
    case 'repair-required':
      return 'Claude CLI is installed, but the statusLine connection is missing. Run "AI Limit Ledger: Repair Claude Code Integration".';
    case 'restart-required':
      return 'Restart Claude CLI session — checking whether the running session picked up the new status line…';
    case 'waiting-for-first-response':
      return 'Waiting for the first completed Claude CLI response containing rate-limit data.';
    case 'upstream-statusline-not-invoked':
      return hostKind === 'vscode-sidebar'
        ? UPSTREAM_NOT_INVOKED_NO_CLI_MESSAGE
        : 'The configured status-line command was not invoked after a real Claude Code response. This is an upstream Claude Code behavior on this host, not something AI Limit Ledger can fix by reconfiguring the wrapper.';
    case 'unsupported-surface':
      return 'AI Limit Ledger could not identify how Claude Code is running here, so usage data cannot be confirmed on this surface.';
    default:
      return undefined;
  }
}
export const claudeBridgePath = (context: vscode.ExtensionContext): string =>
  path.join(context.globalStorageUri.fsPath, 'claude-status.json');

/** Allowlisted-only activity signal file written by the experimental Stop/StopFailure/SessionStart hook bridge. */
export const claudeHookActivityPath = (context: vscode.ExtensionContext): string =>
  path.join(context.globalStorageUri.fsPath, 'claude-hook-activity.jsonl');

export function findClaudeCli(): boolean {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((directory) => names.some((name) => fsSync.existsSync(path.join(directory, name))));
}
