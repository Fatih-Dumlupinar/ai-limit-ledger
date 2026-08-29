import * as vscode from 'vscode';
import {
  CodexAppServerClient,
  type CodexClientDiagnostics,
} from '../appServer/CodexAppServerClient';
import type { RateLimitsResult } from '../appServer/types';
import { parseRateLimits, parseUsage } from '../limits/RateLimitParser';
import {
  diagnosticForError,
  formatDiagnostic,
  safeCategoryOf,
  SafeDiagnosticError,
  type DiagnosticLogger,
  type ProviderDiagnostic,
  type SafeErrorCategory,
} from '../infrastructure/ProviderDiagnostics';
import { RefreshGovernor, ThrottledError } from './RefreshGovernor';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderHealth,
  ProviderSnapshot,
} from './types';
import { buildCodexUsageInsights, mergeUsageInsights } from './UsageInsights';

export const DEFAULT_FALLBACK_INTERVAL_MS = 60_000;
export const MIN_FALLBACK_INTERVAL_MS = 30_000;
export const MAX_FALLBACK_INTERVAL_MS = 900_000;

export interface CodexIntegrationDiagnostics {
  selected: boolean;
  enabled: boolean;
  resolvedExecutablePath: string | null;
  executableExists: boolean;
  cliVersion: string | null;
  processState: CodexClientDiagnostics['processState'] | 'not-configured';
  processStartedAt: number | null;
  processExitCode: number | null;
  initialized: boolean;
  protocolVersion: string | null;
  requestStatus: CodexClientDiagnostics['requestStatus'] | null;
  lastSuccessfulSnapshotTime: number | null;
  lastSafeErrorCategory: SafeErrorCategory | null;
  stale: boolean;
  nextRetryAt: number | null;
  recommendedAction: string;
  rateLimitsSubscriptionActive: boolean;
  lastNotificationTime: number | null;
  fallbackIntervalMs: number;
  singleFlightActive: boolean;
  consecutiveFailures: number;
  parsedWindowCount: number;
}

type Settled<T> = PromiseSettledResult<T>;

/** Loose structural validation of an `account/rateLimits/updated` push payload before trusting it. */
function isRateLimitsResultLike(value: unknown): value is RateLimitsResult {
  if (typeof value !== 'object' || value === null) return false;
  return 'rateLimits' in value || 'rateLimitsByLimitId' in value;
}

export function clampFallbackIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_FALLBACK_INTERVAL_MS;
  return Math.min(MAX_FALLBACK_INTERVAL_MS, Math.max(MIN_FALLBACK_INTERVAL_MS, ms));
}

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly capabilities: ProviderCapabilities = {
    rateLimits: true,
    usage: true,
    statusLine: false,
  };
  private snapshot?: ProviderSnapshot;
  private readonly emitter = new vscode.EventEmitter<ProviderSnapshot>();
  readonly onDidChange = this.emitter.event;
  private fallbackIntervalMs: number;
  private readonly governor: RefreshGovernor;
  private fallbackTimer?: ReturnType<typeof setInterval>;
  private lastNotificationAt: number | null = null;
  private lastDiagnostic?: ProviderDiagnostic;
  private lastDiagnostics: ProviderDiagnostic[] = [];
  private readonly rateLimitsSubscriptionActive: boolean;
  constructor(
    private readonly client: CodexAppServerClient | undefined,
    private readonly logger?: DiagnosticLogger,
    fallbackIntervalMs: number = DEFAULT_FALLBACK_INTERVAL_MS,
  ) {
    this.fallbackIntervalMs = clampFallbackIntervalMs(fallbackIntervalMs);
    this.governor = new RefreshGovernor(this.fallbackIntervalMs);
    this.rateLimitsSubscriptionActive = Boolean(client);
    client?.on('notification', (method, params) => this.handleNotification(method, params));
  }
  async detect(): Promise<boolean> {
    return Boolean(this.client);
  }
  async start(): Promise<void> {
    if (!this.client) {
      this.publish(this.unavailable('executable-not-found'));
      return;
    }
    try {
      await this.client.start();
      this.restartFallbackTimer();
    } catch (error) {
      const diagnostic = this.makeDiagnostic('start', error, 'initialize-failed');
      this.publish(this.failureSnapshot(diagnostic, Date.now()));
      throw error;
    }
  }
  stop(): void {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
    this.client?.stop();
    this.emitter.dispose();
  }
  /** Applied live from a settings change — no Extension Host reload required. */
  setFallbackIntervalMs(ms: number): void {
    this.fallbackIntervalMs = clampFallbackIntervalMs(ms);
    this.governor.setMinimumIntervalMs(this.fallbackIntervalMs);
    if (this.fallbackTimer) this.restartFallbackTimer();
  }
  private restartFallbackTimer(): void {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = setInterval(() => void this.refresh(), this.fallbackIntervalMs);
    // Never keeps the extension host process alive on its own.
    this.fallbackTimer.unref?.();
  }
  /**
   * The documented `account/rateLimits/updated` push: validated, applied directly to the
   * snapshot without an extra `account/rateLimits/read` round trip, and used to reset (not
   * stack) the fallback timer so the next unconditional poll is a full interval away again.
   */
  private handleNotification(method: string, params: unknown): void {
    if (method !== 'account/rateLimits/updated') return;
    this.lastNotificationAt = Date.now();
    if (isRateLimitsResultLike(params)) {
      this.applyRateLimitsPush(params);
    } else {
      // An unrecognized/invalid payload shape falls back to a governed re-read rather than
      // trusting unvalidated data — single-flight still applies.
      void this.refresh(true);
    }
    if (this.fallbackTimer) this.restartFallbackTimer();
  }
  /** Updates the snapshot directly from a validated push payload — no RPC call. */
  private applyRateLimitsPush(result: RateLimitsResult): void {
    if (!this.snapshot || !this.snapshot.connected) {
      // No healthy baseline to merge into yet; a full refresh establishes one (also picks up
      // account/usage data this push does not carry).
      void this.refresh(true);
      return;
    }
    const parsed = parseRateLimits(result, this.snapshot.plan, undefined, this.snapshot.cliVersion);
    const now = Date.now();
    const snapshot: ProviderSnapshot = {
      ...this.snapshot,
      availability: 'ready',
      connected: true,
      plan: parsed.planType ?? this.snapshot.plan,
      usageWindows: parsed.limits.map((limit, i) => ({
        id: `codex-${i}`,
        label: limit.label,
        usedPercent: limit.usedPercent,
        remainingPercent: limit.remainingPercent,
        resetsAt: limit.resetsAt,
        windowDurationMinutes: limit.durationMins,
      })),
      observedAt: now,
      checkedAt: now,
      lastSuccessfulDataUpdate: now,
      lastProviderEventAt: now,
      stale: false,
      warning: undefined,
      error: undefined,
      errorCategory: undefined,
      metadata: {
        ...this.snapshot.metadata,
        resetCredits:
          parsed.resetCredits ?? (this.snapshot.metadata?.resetCredits as number) ?? null,
        reachedType: parsed.reachedType ?? null,
        limitsAvailable: true,
        fallbackIntervalSeconds: this.fallbackIntervalMs / 1000,
      },
      usageInsights: mergeUsageInsights(
        this.snapshot.usageInsights,
        buildCodexUsageInsights({
          planType: parsed.planType ?? this.snapshot.plan,
          limitSnapshot: parsed,
          usage: {
            lifetimeTokens: null,
            peakDailyTokens: null,
            longestRunningTurnSec: null,
            currentStreakDays: null,
            longestStreakDays: null,
            dailyUsageBuckets: [],
          },
          resetCredits: parsed.resetCredits,
          resetCreditExpiresAt: parsed.resetCreditExpiresAt,
          checkedAt: now,
          stale: false,
        }),
      ),
    };
    this.publish(snapshot);
  }
  getSnapshot(): ProviderSnapshot | undefined {
    return this.snapshot;
  }
  getDiagnostics(): ProviderHealth {
    return {
      state: this.snapshot?.availability ?? 'unavailable',
      error: this.snapshot?.error,
      errorCategory: this.snapshot?.errorCategory,
      retryAt: this.snapshot?.retryAt,
      diagnostics: this.lastDiagnostics.length ? [...this.lastDiagnostics] : undefined,
    };
  }
  async refresh(force = false): Promise<ProviderSnapshot | undefined> {
    const checkedAt = Date.now();
    if (!this.client) {
      const snapshot = this.unavailable('executable-not-found', checkedAt);
      this.publish(snapshot);
      return snapshot;
    }
    try {
      return await this.governor.run(async () => {
        await this.client!.start();
        const [account, limits, usage, version] = await Promise.allSettled([
          this.client!.readAccount(),
          this.client!.readRateLimits(),
          this.client!.readUsage(),
          this.client!.version(),
        ]);
        const diagnostics = this.collectReadDiagnostics(account, limits, usage, checkedAt);
        this.lastDiagnostics = diagnostics;
        diagnostics.forEach((diagnostic) => this.recordDiagnostic(diagnostic));

        const accountValue = this.fulfilled(account);
        const limitsValue = this.fulfilled(limits);
        const usageValue = this.fulfilled(usage);
        const validDataResponses = [accountValue, limitsValue, usageValue].filter(
          (value) => value !== undefined,
        ).length;
        if (validDataResponses === 0) throw new Error('All Codex data reads failed.');

        const cliVersion = this.fulfilled(version) ?? null;
        const parsed = limitsValue
          ? parseRateLimits(limitsValue, accountValue?.account?.planType, usageValue, cliVersion)
          : undefined;
        const parsedUsage = usageValue ? parseUsage(usageValue) : parseUsage(undefined);
        const failedMethods = diagnostics.map((diagnostic) => diagnostic.method).filter(Boolean);
        const accountFailed = account.status === 'rejected';
        const warning = accountFailed
          ? 'Codex account information is unavailable; displayed data may be partial.'
          : diagnostics.length > 0
            ? `Some Codex data is unavailable (${failedMethods.join(', ')}).`
            : undefined;
        const observedAt = Date.now();
        const snapshot: ProviderSnapshot = {
          providerId: this.id,
          providerName: this.displayName,
          availability: accountFailed ? 'unavailable' : 'ready',
          connected: true,
          plan: parsed?.planType ?? accountValue?.account?.planType ?? null,
          cliVersion: parsed?.cliVersion ?? cliVersion,
          usageWindows:
            parsed?.limits.map((limit, i) => ({
              id: `codex-${i}`,
              label: limit.label,
              usedPercent: limit.usedPercent,
              remainingPercent: limit.remainingPercent,
              resetsAt: limit.resetsAt,
              windowDurationMinutes: limit.durationMins,
            })) ?? [],
          source: 'Official Codex App Server',
          observedAt,
          checkedAt,
          lastSuccessfulDataUpdate: observedAt,
          sourceUpdatedAt: observedAt,
          lastProviderEventAt: this.lastNotificationAt,
          nextFallbackRefreshAt: this.fallbackTimer ? checkedAt + this.fallbackIntervalMs : null,
          stale: false,
          warning,
          errorCategory: accountFailed
            ? diagnostics.find((diagnostic) => diagnostic.method === 'account/read')?.category
            : undefined,
          diagnostics: diagnostics.length ? diagnostics : undefined,
          capabilities: this.capabilities,
          tokens: {
            lifetimeTokens: parsedUsage.lifetimeTokens,
            peakDailyTokens: parsedUsage.peakDailyTokens,
            longestRunningTurnSec: parsedUsage.longestRunningTurnSec,
            currentStreakDays: parsedUsage.currentStreakDays,
            longestStreakDays: parsedUsage.longestStreakDays,
          },
          metadata: {
            resetCredits: parsed?.resetCredits ?? null,
            reachedType: parsed?.reachedType ?? null,
            limitsAvailable: Boolean(limitsValue),
            usageAvailable: Boolean(usageValue),
            fallbackIntervalSeconds: this.fallbackIntervalMs / 1000,
          },
          usageInsights: buildCodexUsageInsights({
            planType: parsed?.planType ?? accountValue?.account?.planType,
            limitSnapshot: parsed,
            usage: parsedUsage,
            resetCredits: parsed?.resetCredits,
            resetCreditExpiresAt: parsed?.resetCreditExpiresAt,
            checkedAt: observedAt,
          }),
        };
        this.lastDiagnostic = diagnostics.at(-1);
        if (diagnostics.length === 0) this.lastDiagnostics = [];
        this.publish(snapshot);
        return snapshot;
      }, force);
    } catch (error) {
      if (error instanceof ThrottledError) {
        // A routine throttle (too soon since the last call), not a failure — the existing
        // snapshot is still accurate and must not be flipped to `stale`/re-published.
        return this.snapshot;
      }
      const diagnostic = this.makeDiagnostic('refresh', error, this.inferRefreshCategory(error));
      this.publish(this.failureSnapshot(diagnostic, checkedAt));
      return this.snapshot;
    }
  }
  async getCodexDiagnostics(selected = true): Promise<CodexIntegrationDiagnostics> {
    const clientDiagnostics = this.client?.getDiagnostics();
    const cliVersion = this.client ? await this.client.version() : null;
    const hasHealthySnapshot = this.snapshot?.availability === 'ready' && !this.snapshot.stale;
    const lastCategory = hasHealthySnapshot
      ? null
      : (this.snapshot?.errorCategory ??
        this.lastDiagnostic?.category ??
        clientDiagnostics?.lastDiagnostic?.category ??
        null);
    const executablePath = clientDiagnostics?.executablePath ?? null;
    const executableExists = clientDiagnostics?.executableExists ?? false;
    return {
      selected,
      enabled: selected && Boolean(this.client),
      resolvedExecutablePath: executablePath,
      executableExists,
      cliVersion: cliVersion ?? clientDiagnostics?.cliVersion ?? null,
      processState: clientDiagnostics?.processState ?? 'not-configured',
      processStartedAt: clientDiagnostics?.processStartedAt ?? null,
      processExitCode: clientDiagnostics?.processExitCode ?? null,
      initialized: clientDiagnostics?.initialized ?? false,
      protocolVersion: clientDiagnostics?.protocolVersion ?? null,
      requestStatus: clientDiagnostics?.requestStatus ?? null,
      lastSuccessfulSnapshotTime: this.snapshot?.lastSuccessfulDataUpdate ?? null,
      lastSafeErrorCategory: lastCategory,
      stale: this.snapshot?.stale ?? false,
      nextRetryAt: this.snapshot?.retryAt ?? (this.governor.nextRetryAt || null),
      recommendedAction: this.recommendedAction(executableExists, clientDiagnostics),
      rateLimitsSubscriptionActive: this.rateLimitsSubscriptionActive,
      lastNotificationTime: this.lastNotificationAt,
      fallbackIntervalMs: this.fallbackIntervalMs,
      singleFlightActive: this.governor.isRunning,
      consecutiveFailures: this.governor.consecutiveFailures,
      parsedWindowCount: this.snapshot?.usageWindows.length ?? 0,
    };
  }
  private collectReadDiagnostics(
    account: Settled<Awaited<ReturnType<CodexAppServerClient['readAccount']>>>,
    limits: Settled<Awaited<ReturnType<CodexAppServerClient['readRateLimits']>>>,
    usage: Settled<Awaited<ReturnType<CodexAppServerClient['readUsage']>>>,
    checkedAt: number,
  ): ProviderDiagnostic[] {
    const failures: Array<[Settled<unknown>, string, SafeErrorCategory]> = [
      [account, 'account/read', 'account-read-failed'],
      [limits, 'account/rateLimits/read', 'rate-limits-read-failed'],
      [usage, 'account/usage/read', 'usage-read-failed'],
    ];
    return failures
      .filter(([result]) => result.status === 'rejected')
      .map(([result, method, fallback]) => {
        const reason = (result as PromiseRejectedResult).reason;
        const diagnostic = diagnosticForError('codex', 'refresh', reason, {
          method,
          category: fallback,
          checkedAt,
          retryAvailable: true,
        });
        return {
          ...diagnostic,
          // These three method-specific diagnostics are part of the existing provider contract;
          // common transport classification must not erase which read failed. Explicit safe
          // provider errors remain authoritative (for example, not-authenticated).
          category: reason instanceof SafeDiagnosticError ? diagnostic.category : fallback,
        };
      });
  }
  private fulfilled<T>(result: Settled<T>): T | undefined {
    return result.status === 'fulfilled' ? result.value : undefined;
  }
  private inferRefreshCategory(error: unknown): SafeErrorCategory {
    const category = safeCategoryOf(error);
    return category === 'unknown' ? 'unknown' : category;
  }
  private makeDiagnostic(
    stage: string,
    error: unknown,
    fallback: SafeErrorCategory,
  ): ProviderDiagnostic {
    return diagnosticForError('codex', stage, error, {
      category: fallback,
      checkedAt: Date.now(),
      retryAvailable: true,
    });
  }
  private recordDiagnostic(diagnostic: ProviderDiagnostic): void {
    this.lastDiagnostic = diagnostic;
    this.logger?.error(`Codex diagnostic ${formatDiagnostic(diagnostic)}`);
  }
  private publish(snapshot: ProviderSnapshot): void {
    this.snapshot = snapshot;
    this.emitter.fire(snapshot);
  }
  private failureSnapshot(diagnostic: ProviderDiagnostic, checkedAt: number): ProviderSnapshot {
    this.recordDiagnostic(diagnostic);
    if (this.snapshot?.lastSuccessfulDataUpdate !== undefined) {
      return {
        ...this.snapshot,
        availability: 'stale',
        connected: true,
        checkedAt,
        stale: true,
        error: diagnostic.category,
        errorCategory: diagnostic.category,
        retryAt: this.governor.nextRetryAt || undefined,
        diagnostics: [...this.lastDiagnostics, diagnostic],
      };
    }
    return this.unavailable(diagnostic.category, checkedAt, diagnostic);
  }
  private unavailable(
    category: SafeErrorCategory,
    checkedAt = Date.now(),
    diagnostic?: ProviderDiagnostic,
  ): ProviderSnapshot {
    return {
      providerId: this.id,
      providerName: this.displayName,
      availability: 'unavailable',
      connected: false,
      plan: null,
      cliVersion: null,
      usageWindows: [],
      source: 'Official Codex App Server',
      observedAt: checkedAt,
      checkedAt,
      stale: false,
      error: category,
      errorCategory: category,
      warning:
        category === 'executable-not-found'
          ? 'Codex CLI was not found.'
          : 'Codex App Server is unavailable; retrying may recover the connection.',
      diagnostics: diagnostic ? [...this.lastDiagnostics, diagnostic] : undefined,
      capabilities: this.capabilities,
    };
  }
  private recommendedAction(
    executableExists: boolean,
    diagnostics: CodexClientDiagnostics | undefined,
  ): string {
    if (!executableExists) return 'Configure a valid Codex executable path.';
    if (!diagnostics?.initialized) return 'Refresh or restart the Codex App Server.';
    if (this.snapshot?.stale) return 'Refresh Codex when the retry time is reached.';
    return 'No action needed.';
  }
}
