import * as vscode from 'vscode';
import { mementoLeaseStore, tryAcquireLease, type MementoLike } from '../RefreshLease';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderHealth,
  ProviderSnapshot,
} from '../types';
import { GrokAcpError, GrokMethodNotSupportedError } from './GrokAcpClient';
import { grokBackoffMs } from './GrokBackoff';
import { detectGrokExtension } from './GrokExtensionDetection';
import { resolveGrokCli } from './GrokCliResolver';
import type { GrokCliInfo, GrokExtensionInfo, GrokBillingTransport } from './types';
import { GROK_BILLING_METHOD } from './types';
import { buildGrokUsageInsights } from '../UsageInsights';
import { readGrokAuthToken, type GrokAuthFile } from './experimental/GrokAuthFileReader';
import {
  fetchGrokProxyBilling,
  type FetchLike as GrokProxyFetchLike,
} from './experimental/GrokCliProxyTransport';

export const DEFAULT_GROK_REFRESH_SECONDS = 300;
export const MIN_GROK_REFRESH_SECONDS = 300;
export const MAX_GROK_REFRESH_SECONDS = 3600;
const GROK_LEASE_KEY = 'aiLimitLedger.grok.billingRefreshLease';

export interface GrokProviderOptions {
  globalState?: MementoLike;
  windowId?: string;
  enabled?: () => boolean;
  executablePath?: () => string;
  workspaceRoot?: () => string | undefined;
  refreshSeconds?: () => number;
  detectCli?: () => Promise<GrokCliInfo>;
  detectExtension?: () => GrokExtensionInfo;
  createTransport?: (executablePath: string, cliVersion: string | null) => GrokBillingTransport;
  /** Whether the user has opted in to the experimental CLI-proxy billing fallback. */
  experimentalEnabled?: () => boolean;
  experimentalFetch?: GrokProxyFetchLike;
  authFile?: GrokAuthFile;
  homeDir?: () => string;
}

/**
 * Safe (never-sensitive) reason the last experimental fallback attempt did not produce data. Read
 * via `GrokProvider.experimentalFallbackStatus` for Diagnose Grok Integration. Never carries a URL,
 * UUID, scope key, user id, or any other value read out of the auth file or the proxy response —
 * only fixed, safe category names.
 */
export type GrokExperimentalFallbackStatus =
  | { reason: 'not-opted-in' }
  | { reason: 'no-fs-configured' }
  | { reason: 'auth-file-missing' }
  | { reason: 'invalid-auth-store-structure' }
  | { reason: 'no-compatible-session' }
  | { reason: 'unsupported-auth-mode' }
  | { reason: 'session-expired' }
  | { reason: 'proxy-authentication-required' }
  | { reason: 'billing-not-available' }
  | { reason: 'billing-endpoint-unavailable' }
  | { reason: 'proxy-rate-limited' }
  | { reason: 'billing-not-exposed' }
  | { reason: 'incompatible-response' }
  | { reason: 'proxy-failure'; category: string }
  | { reason: 'unexpected-error' }
  | { reason: 'free-plan' }
  | { reason: 'ok' };

export function clampGrokRefreshSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GROK_REFRESH_SECONDS;
  return Math.min(MAX_GROK_REFRESH_SECONDS, Math.max(MIN_GROK_REFRESH_SECONDS, value));
}

export class GrokProvider implements ProviderAdapter {
  readonly id = 'grok';
  readonly displayName = 'Grok';
  readonly capabilities: ProviderCapabilities = {
    rateLimits: false,
    usage: true,
    statusLine: false,
  };
  private readonly emitter = new vscode.EventEmitter<ProviderSnapshot>();
  readonly onDidChange = this.emitter.event;
  private snapshot?: ProviderSnapshot;
  private cli: GrokCliInfo = { installed: false, executablePath: null, version: null };
  private extension: GrokExtensionInfo = {
    installed: false,
    id: null,
    version: null,
    official: false,
  };
  private transport?: GrokBillingTransport;
  private running?: Promise<ProviderSnapshot | undefined>;
  private lastRefreshAt = 0;
  private retryAt = 0;
  private consecutiveFailures = 0;
  private unsupportedCliVersion: string | null = null;
  private lastExperimentalFallbackStatus: GrokExperimentalFallbackStatus = {
    reason: 'not-opted-in',
  };
  private stopped = false;

  constructor(private readonly options: GrokProviderOptions = {}) {}

  async detect(): Promise<boolean> {
    return this.cli.installed;
  }

  async start(): Promise<void> {
    this.publish(this.baseSnapshot('initializing'));
    try {
      await this.recheckInstallation(false);
    } catch {
      // Resolver/detection failures are setup state, not an activation rejection. The provider
      // must still leave a usable snapshot behind for the Dashboard.
      this.cli = { installed: false, executablePath: null, version: null, reason: 'not-found' };
      this.publish(this.baseSnapshot('cli-not-installed'));
    }
  }

  stop(): void {
    this.stopped = true;
    this.transport?.dispose();
    this.transport = undefined;
    this.emitter.dispose();
  }

  getSnapshot(): ProviderSnapshot | undefined {
    return this.snapshot;
  }

  getDiagnostics(): ProviderHealth {
    return {
      state: this.snapshot?.availability ?? 'unavailable',
      warning: this.snapshot?.warning,
      error: this.snapshot?.error,
      errorCategory: this.snapshot?.errorCategory,
      retryAt: this.retryAt || undefined,
    };
  }

  async enable(): Promise<ProviderSnapshot | undefined> {
    return this.refresh(true);
  }

  disable(): ProviderSnapshot | undefined {
    this.transport?.dispose();
    this.transport = undefined;
    const snapshot = this.baseSnapshot('disabled');
    this.publish(snapshot);
    return snapshot;
  }

  async recheckInstallation(refresh = true): Promise<ProviderSnapshot | undefined> {
    try {
      this.cli = await (
        this.options.detectCli ??
        (() =>
          resolveGrokCli({
            executablePath: this.options.executablePath?.() || undefined,
            workspaceRoot: this.options.workspaceRoot?.(),
          }))
      )();
    } catch {
      this.cli = { installed: false, executablePath: null, version: null, reason: 'not-found' };
    }
    try {
      this.extension =
        this.options.detectExtension?.() ?? detectGrokExtension(vscode.extensions?.all ?? []);
    } catch {
      this.extension = { installed: false, id: null, version: null, official: false };
    }
    if (!this.cli.installed) {
      this.publish(this.baseSnapshot('cli-not-installed'));
      return this.snapshot;
    }
    if (this.options.enabled?.() === false) {
      this.publish(this.baseSnapshot('disabled'));
      return this.snapshot;
    }
    if (this.unsupportedCliVersion && this.unsupportedCliVersion !== this.cli.version) {
      this.unsupportedCliVersion = null;
    }
    if (refresh) return this.refresh(true);
    const state = this.options.enabled?.() === false ? 'disabled' : 'authentication-required';
    this.publish(this.baseSnapshot(state));
    return this.snapshot;
  }

  async refresh(force = false): Promise<ProviderSnapshot | undefined> {
    if (this.stopped) return this.snapshot;
    if (!this.cli.installed) {
      const snapshot = this.baseSnapshot('cli-not-installed');
      this.publish(snapshot);
      return snapshot;
    }
    if (this.options.enabled?.() === false) {
      const snapshot = this.baseSnapshot('disabled');
      this.publish(snapshot);
      return snapshot;
    }
    // When ACP is known-unsupported on this CLI version and the experimental fallback is off,
    // there is nothing new to fetch — publish immediately without engaging the refresh interval
    // machinery below. When the fallback is enabled, fall through so `refreshOnce` can still run
    // it on the normal interval/backoff/lease schedule.
    if (
      this.unsupportedCliVersion === this.cli.version &&
      !(this.options.experimentalEnabled?.() && this.options.experimentalFetch)
    ) {
      const snapshot = this.baseSnapshot('method-not-supported');
      snapshot.warning = 'Grok billing capability is unavailable in this CLI version.';
      this.publish(snapshot);
      return snapshot;
    }
    if (this.running) return this.running;
    const now = Date.now();
    const refreshMs =
      clampGrokRefreshSeconds(
        (this.options.refreshSeconds ?? (() => DEFAULT_GROK_REFRESH_SECONDS))(),
      ) * 1000;
    // `force` only means manual freshness; it never bypasses a provider backoff.
    if (now < this.retryAt || (!force && now - this.lastRefreshAt < refreshMs))
      return this.snapshot;
    if (this.options.globalState) {
      const lease = mementoLeaseStore(this.options.globalState, GROK_LEASE_KEY);
      if (!tryAcquireLease(lease, GROK_LEASE_KEY, this.options.windowId ?? 'default', 8_000))
        return this.snapshot;
    }
    this.running = this.refreshOnce(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async refreshOnce(checkedAt: number): Promise<ProviderSnapshot | undefined> {
    this.lastRefreshAt = checkedAt;
    if (this.unsupportedCliVersion === this.cli.version) {
      // ACP is known-unsupported on this CLI version; go straight to the experimental fallback
      // (or the plain method-not-supported snapshot if it also fails) instead of retrying ACP.
      const snapshot = await this.experimentalFallbackOrUnsupported(checkedAt);
      this.publish(snapshot);
      return snapshot;
    }
    try {
      if (!this.transport) {
        const factory = this.options.createTransport;
        if (!factory || !this.cli.executablePath) {
          const snapshot = this.baseSnapshot('authentication-required', checkedAt);
          snapshot.warning =
            'Grok CLI is installed; sign in with Grok CLI before reading billing usage.';
          this.publish(snapshot);
          return snapshot;
        }
        this.transport = factory(this.cli.executablePath, this.cli.version);
      }
      const summary = await this.transport.getBilling();
      this.consecutiveFailures = 0;
      this.retryAt = 0;
      const snapshot: ProviderSnapshot = {
        ...this.baseSnapshot(
          summary.usageWindows.length ? 'ready-experimental' : 'connected-no-billing-method',
          checkedAt,
        ),
        connected: true,
        plan: summary.plan,
        usageWindows: summary.usageWindows
          .map((window) => ({
            id: window.id,
            label: window.label,
            usedPercent: window.usedPercent ?? 0,
            remainingPercent: window.remainingPercent ?? 0,
            resetsAt: window.resetsAt,
            windowDurationMinutes: null,
          }))
          .filter((window) => {
            // A missing percentage is not a zero percentage. The parser leaves the window out.
            return summary.usageWindows.some(
              (candidate) =>
                candidate.id === window.id &&
                candidate.usedPercent !== null &&
                candidate.remainingPercent !== null,
            );
          }),
        credits: summary.credits,
        observedAt: checkedAt,
        checkedAt,
        sourceUpdatedAt: checkedAt,
        lastSuccessfulDataUpdate: checkedAt,
        lastSuccessfulUpdateAt: checkedAt,
        stale: false,
        warning: summary.usageWindows.length
          ? undefined
          : 'Grok billing method returned no usage percentage.',
        metadata: {
          ...this.baseMetadata(),
          currentPeriod: summary.currentPeriod,
          ...(summary.productBreakdown
            ? { productBreakdown: JSON.stringify(summary.productBreakdown) }
            : {}),
          buildUsage: summary.buildUsage,
          additionalOnDemandEnabled: summary.onDemandEnabled,
          extraCreditBalance: summary.extraCreditBalance,
        },
        usageInsights: buildGrokUsageInsights({
          summary,
          checkedAt,
          experimental: false,
        }),
      };
      this.publish(snapshot);
      return snapshot;
    } catch (error) {
      if (
        error instanceof GrokMethodNotSupportedError ||
        (error instanceof GrokAcpError && error.code === -32601)
      ) {
        this.unsupportedCliVersion = this.cli.version;
        const snapshot = await this.experimentalFallbackOrUnsupported(checkedAt);
        this.publish(snapshot);
        return snapshot;
      }
      this.consecutiveFailures++;
      this.retryAt = Date.now() + grokBackoffMs(this.consecutiveFailures);
      const lastGood =
        this.snapshot?.lastSuccessfulUpdateAt ?? this.snapshot?.lastSuccessfulDataUpdate;
      if (this.snapshot && lastGood !== undefined) {
        const snapshot: ProviderSnapshot = {
          ...this.snapshot,
          availability:
            error instanceof GrokAcpError && error.code === 'timeout'
              ? 'rate-limited'
              : 'stale-experimental',
          checkedAt,
          stale: true,
          retryAt: this.retryAt,
          warning: 'Showing the last known good experimental Grok billing snapshot.',
        };
        this.publish(snapshot);
        return snapshot;
      }
      const authenticationRequired =
        error instanceof GrokAcpError && /auth|login|credential/i.test(error.message);
      const snapshot = this.baseSnapshot(
        authenticationRequired ? 'authentication-required' : 'unavailable',
        checkedAt,
      );
      snapshot.errorCategory =
        error instanceof GrokAcpError && error.code === 'timeout' ? 'timeout' : 'unknown';
      snapshot.safeErrorCategory = snapshot.errorCategory;
      snapshot.retryAt = this.retryAt;
      snapshot.warning = authenticationRequired
        ? 'Grok CLI authentication is required. Use Launch Grok Login in VS Code Terminal.'
        : 'Grok billing usage is currently unavailable.';
      this.publish(snapshot);
      return snapshot;
    }
  }

  /**
   * Best-effort only: never throws. Attempts the experimental CLI-proxy billing fallback when the
   * user has opted in; otherwise (or on any failure) returns the plain `method-not-supported`
   * snapshot, unchanged from before the fallback existed. Also records a safe (non-sensitive)
   * reason for the last outcome so "Diagnose Grok Integration" can explain a silent fallback
   * failure without ever surfacing the token or the auth file's contents.
   */
  private async experimentalFallbackOrUnsupported(checkedAt: number): Promise<ProviderSnapshot> {
    const plainUnsupported = (): ProviderSnapshot => {
      const snapshot = this.baseSnapshot('method-not-supported', checkedAt);
      snapshot.warning = 'Experimental Grok billing method is not available in this CLI version.';
      snapshot.metadata = {
        ...snapshot.metadata,
        experimentalFallbackStatus: this.experimentalFallbackStatusLabel(),
      };
      return snapshot;
    };
    if (!this.options.experimentalEnabled?.() || !this.options.experimentalFetch) {
      this.lastExperimentalFallbackStatus = { reason: 'not-opted-in' };
      return plainUnsupported();
    }
    try {
      const homeDir = this.options.homeDir?.() ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
      const authFile = this.options.authFile;
      if (!authFile) {
        this.lastExperimentalFallbackStatus = { reason: 'no-fs-configured' };
        return plainUnsupported();
      }
      const auth = await readGrokAuthToken(authFile, homeDir);
      if (auth.kind === 'missing') {
        this.lastExperimentalFallbackStatus = { reason: 'auth-file-missing' };
        return plainUnsupported();
      }
      if (auth.kind === 'invalid-structure') {
        this.lastExperimentalFallbackStatus = { reason: 'invalid-auth-store-structure' };
        return plainUnsupported();
      }
      if (auth.kind === 'no-compatible-session') {
        this.lastExperimentalFallbackStatus = { reason: 'no-compatible-session' };
        return plainUnsupported();
      }
      if (auth.kind === 'unsupported-auth-mode') {
        this.lastExperimentalFallbackStatus = { reason: 'unsupported-auth-mode' };
        return plainUnsupported();
      }
      if (auth.kind === 'session-expired') {
        this.lastExperimentalFallbackStatus = { reason: 'session-expired' };
        return plainUnsupported();
      }
      const result = await fetchGrokProxyBilling(
        auth.token,
        auth.userId,
        this.cli.version,
        this.options.experimentalFetch,
      );
      if (result.kind === 'authentication-required') {
        this.lastExperimentalFallbackStatus = { reason: 'proxy-authentication-required' };
        return plainUnsupported();
      }
      if (result.kind === 'billing-not-available') {
        this.lastExperimentalFallbackStatus = { reason: 'billing-not-available' };
        return plainUnsupported();
      }
      if (result.kind === 'billing-endpoint-unavailable') {
        this.lastExperimentalFallbackStatus = { reason: 'billing-endpoint-unavailable' };
        return plainUnsupported();
      }
      if (result.kind === 'rate-limited') {
        this.lastExperimentalFallbackStatus = { reason: 'proxy-rate-limited' };
        return plainUnsupported();
      }
      if (result.kind === 'billing-not-exposed') {
        this.lastExperimentalFallbackStatus = { reason: 'billing-not-exposed' };
        return plainUnsupported();
      }
      if (result.kind === 'incompatible-response') {
        this.lastExperimentalFallbackStatus = { reason: 'incompatible-response' };
        return plainUnsupported();
      }
      if (result.kind === 'failure') {
        this.lastExperimentalFallbackStatus = {
          reason: 'proxy-failure',
          category: result.category,
        };
        return plainUnsupported();
      }
      this.lastExperimentalFallbackStatus =
        result.kind === 'free-plan' ? { reason: 'free-plan' } : { reason: 'ok' };
      const summary = result.summary;
      return {
        ...this.baseSnapshot('ready-experimental', checkedAt),
        connected: true,
        plan: summary.plan,
        usageWindows: summary.usageWindows
          .filter((window) => window.usedPercent !== null && window.remainingPercent !== null)
          .map((window) => ({
            id: window.id,
            label: window.label,
            usedPercent: window.usedPercent ?? 0,
            remainingPercent: window.remainingPercent ?? 0,
            resetsAt: window.resetsAt,
            windowDurationMinutes: null,
          })),
        credits: summary.credits,
        observedAt: checkedAt,
        checkedAt,
        sourceUpdatedAt: checkedAt,
        lastSuccessfulDataUpdate: checkedAt,
        lastSuccessfulUpdateAt: checkedAt,
        stale: false,
        warning:
          result.kind === 'free-plan'
            ? 'Free plan — automatic billing details are not exposed by this experimental endpoint.'
            : summary.usageWindows.length
              ? undefined
              : 'Grok CLI-proxy billing service returned no usage percentage.',
        source: 'Experimental — Grok Build billing extension',
        provenance:
          'Experimental — Grok CLI billing service (cli-chat-proxy.grok.com); ACP x.ai/billing is unavailable in this CLI version.',
        metadata: {
          ...this.baseMetadata(),
          currentPeriod: summary.currentPeriod,
          ...(summary.productBreakdown
            ? { productBreakdown: JSON.stringify(summary.productBreakdown) }
            : {}),
          additionalOnDemandEnabled: summary.onDemandEnabled,
          extraCreditBalance: summary.extraCreditBalance,
          acpBillingCapability: 'unavailable-safe-fallback-active',
        },
        usageInsights: buildGrokUsageInsights({
          summary,
          checkedAt,
          experimental: true,
        }),
      };
    } catch {
      this.lastExperimentalFallbackStatus = { reason: 'unexpected-error' };
      return plainUnsupported();
    }
  }

  /** Safe (never-sensitive) explanation of why the experimental fallback last did — or didn't — produce data. */
  get experimentalFallbackStatus(): GrokExperimentalFallbackStatus {
    return this.lastExperimentalFallbackStatus;
  }

  /** Human-readable, safe (never-sensitive) label for `experimentalFallbackStatus`, for diagnostics/UI. */
  get experimentalFallbackStatusText(): string {
    return this.experimentalFallbackStatusLabel();
  }

  /**
   * Always a fixed, safe category name — never a URL, UUID, scope key, user id, or any other
   * value read out of the auth file or the proxy response.
   */
  private experimentalFallbackStatusLabel(): string {
    const status = this.lastExperimentalFallbackStatus;
    switch (status.reason) {
      case 'proxy-failure':
        return `proxy-failure (${status.category})`;
      default:
        return status.reason;
    }
  }

  get cliInfo(): GrokCliInfo {
    return this.cli;
  }

  get extensionInfo(): GrokExtensionInfo {
    return this.extension;
  }

  private baseSnapshot(
    availability: ProviderSnapshot['availability'],
    checkedAt = Date.now(),
  ): ProviderSnapshot {
    return {
      providerId: this.id,
      providerName: this.displayName,
      availability,
      connected:
        availability === 'ready-experimental' || availability === 'connected-no-billing-method',
      plan: null,
      cliVersion: this.cli.version,
      extensionVersion: this.extension.version,
      usageWindows: [],
      source: 'Official Grok Build billing capability (x.ai/billing)',
      provenance: 'Official Grok Build billing capability via ACP x.ai/billing.',
      observedAt: checkedAt,
      checkedAt,
      stale: false,
      capabilities: this.capabilities,
      metadata: this.baseMetadata(),
    };
  }

  private baseMetadata(): Record<string, string | boolean | number | null> {
    return {
      consent: this.options.experimentalEnabled?.() ?? false,
      cliInstalled: this.cli.installed,
      extensionInstalled: this.extension.installed,
      extensionId: this.extension.id,
      extensionOfficial: this.extension.official,
      extensionVersion: this.extension.version,
      billingMethod: GROK_BILLING_METHOD,
      nextRefreshAt:
        this.lastRefreshAt +
        clampGrokRefreshSeconds(
          (this.options.refreshSeconds ?? (() => DEFAULT_GROK_REFRESH_SECONDS))(),
        ) *
          1000,
      refreshIntervalSeconds: clampGrokRefreshSeconds(
        (this.options.refreshSeconds ?? (() => DEFAULT_GROK_REFRESH_SECONDS))(),
      ),
      retryAt: this.retryAt || null,
    };
  }

  private publish(snapshot: ProviderSnapshot): void {
    this.snapshot = snapshot;
    this.emitter.fire(snapshot);
  }
}
