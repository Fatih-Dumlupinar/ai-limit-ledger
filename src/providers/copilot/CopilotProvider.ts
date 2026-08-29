import * as vscode from 'vscode';
import { mementoLeaseStore, tryAcquireLease, type MementoLike } from '../RefreshLease';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderHealth,
  ProviderSnapshot,
} from '../types';
import { calculateCopilotAllowance } from './CopilotAllowanceCalculator';
import { copilotBackoffMs } from './CopilotBackoff';
import { detectCopilotCli } from './CopilotCliDetection';
import { detectCopilotExtensions } from './CopilotExtensionDetection';
import { GitHubBillingHttpError } from './GitHubBillingClient';
import type { GitHubAuthenticationService } from './GitHubAuthenticationService';
import type {
  CopilotCliInfo,
  CopilotExtensionInfo,
  CopilotPlan,
  CopilotUsageSummary,
} from './types';
import type { GitHubBillingClient } from './GitHubBillingClient';
import {
  buildCopilotEntitlementInsights,
  buildCopilotOrganizationInsights,
  buildCopilotUsageInsights,
} from '../UsageInsights';
import {
  fetchCopilotEntitlement,
  type CopilotEntitlementSummary,
  type FetchLike as EntitlementFetchLike,
} from './experimental/CopilotEntitlementTransport';

export const DEFAULT_COPILOT_REFRESH_SECONDS = 300;
export const MIN_COPILOT_REFRESH_SECONDS = 300;
export const MAX_COPILOT_REFRESH_SECONDS = 3600;
const COPILOT_LEASE_KEY = 'aiLimitLedger.copilot.billingRefreshLease';

export interface CopilotProviderOptions {
  authentication: GitHubAuthenticationService;
  billing: GitHubBillingClient;
  globalState?: MementoLike;
  windowId?: string;
  enabled?: () => boolean;
  plan?: () => CopilotPlan;
  customMonthlyCredits?: () => number | undefined;
  refreshSeconds?: () => number;
  detectCli?: () => Promise<CopilotCliInfo>;
  detectExtensions?: () => CopilotExtensionInfo;
  /** Machine-scoped explicit CLI path override; passed through to `detectCopilotCli`. */
  executablePath?: () => string;
  /** Whether the user has opted in to the experimental `copilot_internal/user` entitlement fallback. */
  experimentalEnabled?: () => boolean;
  experimentalFetch?: EntitlementFetchLike;
  experimentalHost?: () => string;
}

export function clampCopilotRefreshSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COPILOT_REFRESH_SECONDS;
  return Math.min(MAX_COPILOT_REFRESH_SECONDS, Math.max(MIN_COPILOT_REFRESH_SECONDS, value));
}

export class CopilotProvider implements ProviderAdapter {
  readonly id = 'copilot';
  readonly displayName = 'GitHub Copilot';
  readonly capabilities: ProviderCapabilities = {
    rateLimits: false,
    usage: true,
    statusLine: false,
  };
  private readonly emitter = new vscode.EventEmitter<ProviderSnapshot>();
  readonly onDidChange = this.emitter.event;
  private snapshot?: ProviderSnapshot;
  private cli: CopilotCliInfo = { installed: false, executablePath: null, version: null };
  private extension: CopilotExtensionInfo = { installed: false, version: null, ids: [] };
  private running?: Promise<ProviderSnapshot | undefined>;
  private lastRefreshAt = 0;
  private retryAt = 0;
  private consecutive429s = 0;
  private stopped = false;

  constructor(private readonly options: CopilotProviderOptions) {}

  async detect(): Promise<boolean> {
    return this.cli.installed || this.extension.installed;
  }

  async start(): Promise<void> {
    // Publish synchronously before any host/extension detection so the coordinator and Dashboard
    // always have a deterministic first state, even if detection rejects in the host.
    this.publish(this.baseSnapshot('initializing'));
    await this.detectCliAndExtension();
    this.publish(
      this.baseSnapshot(
        this.options.enabled?.() !== false ? 'authentication-required' : 'disabled',
      ),
    );
  }

  private async detectCliAndExtension(): Promise<void> {
    try {
      this.cli = await (
        this.options.detectCli ??
        (() => detectCopilotCli({ explicitPath: this.options.executablePath?.() || undefined }))
      )();
    } catch {
      this.cli = { installed: false, executablePath: null, version: null };
    }
    try {
      this.extension =
        this.options.detectExtensions?.() ?? detectCopilotExtensions(vscode.extensions?.all ?? []);
    } catch {
      this.extension = { installed: false, version: null, ids: [] };
    }
  }

  /** Re-runs CLI resolution without a window reload or provider/network refresh. */
  async recheckCli(): Promise<ProviderSnapshot | undefined> {
    await this.detectCliAndExtension();
    const availability =
      this.snapshot?.availability ??
      (this.options.enabled?.() === false ? 'disabled' : 'authentication-required');
    const refreshedMetadata = {
      ...(this.snapshot?.metadata ?? {}),
      ...this.baseMetadata(),
    };
    const snapshot = this.snapshot
      ? {
          ...this.snapshot,
          cliVersion: this.cli.version,
          extensionVersion: this.extension.version,
          metadata: refreshedMetadata,
        }
      : { ...this.baseSnapshot(availability), metadata: refreshedMetadata };
    this.publish(snapshot);
    return snapshot;
  }

  stop(): void {
    this.stopped = true;
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
      retryAt: this.retryAt || this.snapshot?.retryAt,
    };
  }

  async connect(): Promise<ProviderSnapshot | undefined> {
    const result = await this.options.authentication.connect();
    if (result === 'cancelled') return this.snapshot;
    return this.refresh(true);
  }

  async disconnect(): Promise<ProviderSnapshot | undefined> {
    await this.options.authentication.disconnect();
    this.publish(this.baseSnapshot('authentication-required'));
    return this.snapshot;
  }

  async refresh(force = false): Promise<ProviderSnapshot | undefined> {
    if (this.stopped) return this.snapshot;
    if (this.options.enabled?.() === false) {
      const snapshot = this.baseSnapshot('disabled');
      this.publish(snapshot);
      return snapshot;
    }
    if (this.running) return this.running;
    const now = Date.now();
    const refreshMs =
      clampCopilotRefreshSeconds(
        (this.options.refreshSeconds ?? (() => DEFAULT_COPILOT_REFRESH_SECONDS))(),
      ) * 1000;
    // `force` only means manual freshness; it never bypasses a provider backoff.
    if (now < this.retryAt || (!force && now - this.lastRefreshAt < refreshMs))
      return this.snapshot;
    if (this.options.globalState) {
      const lease = mementoLeaseStore(this.options.globalState, COPILOT_LEASE_KEY);
      if (!tryAcquireLease(lease, COPILOT_LEASE_KEY, this.options.windowId ?? 'default', 8_000)) {
        return this.snapshot;
      }
    }
    this.running = this.refreshOnce(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async refreshOnce(checkedAt: number): Promise<ProviderSnapshot | undefined> {
    this.lastRefreshAt = checkedAt;
    let token: string | undefined;
    try {
      token = await this.options.authentication.getToken(false);
      if (!token) {
        const snapshot = this.baseSnapshot('authentication-required', checkedAt);
        snapshot.warning = 'Connect GitHub to read Copilot billing usage.';
        this.publish(snapshot);
        return snapshot;
      }
      const result = await this.options.billing.getCurrentUsage(token);
      if (result.kind === 'organization-managed') {
        if (this.options.experimentalEnabled?.() && this.options.experimentalFetch) {
          const experimental = await this.tryExperimentalEntitlement(token, checkedAt);
          if (experimental) {
            this.publish(experimental);
            return experimental;
          }
        }
        const snapshot = this.baseSnapshot('organization-managed', checkedAt);
        snapshot.connected = true;
        snapshot.warning =
          'Copilot is managed by an organization or enterprise; personal allowance is not available.';
        snapshot.metadata = { ...snapshot.metadata, billingEndpoint: 'organization-managed' };
        snapshot.usageInsights = buildCopilotOrganizationInsights(checkedAt);
        this.publish(snapshot);
        return snapshot;
      }
      if (result.kind !== 'success' || !result.usage) {
        throw new Error(result.message ?? 'Copilot billing data unavailable');
      }
      this.consecutive429s = 0;
      this.retryAt = 0;
      const snapshot = this.snapshotFromUsage(result.usage, checkedAt);
      this.publish(snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof GitHubBillingHttpError && error.status === 403) {
        const snapshot = this.baseSnapshot('authentication-required', checkedAt);
        snapshot.warning =
          'GitHub billing permission is insufficient. Connect again with Plan: read permission.';
        snapshot.errorCategory = 'permission-denied';
        snapshot.safeErrorCategory = snapshot.errorCategory;
        this.publish(snapshot);
        return snapshot;
      }
      if (error instanceof GitHubBillingHttpError && error.status === 429) {
        this.consecutive429s++;
        const waitMs = Math.min(
          3_600_000,
          Math.max(
            copilotBackoffMs(this.consecutive429s, error.retryAfterSeconds),
            this.consecutive429s >= 3 ? 900_000 : 0,
          ),
        );
        this.retryAt = Date.now() + waitMs;
      } else {
        this.retryAt = Date.now() + Math.min(3_600_000, copilotBackoffMs(1));
      }
      const lastGood =
        this.snapshot?.lastSuccessfulUpdateAt ?? this.snapshot?.lastSuccessfulDataUpdate;
      if (this.snapshot && lastGood !== undefined) {
        const stale: ProviderSnapshot = {
          ...this.snapshot,
          availability:
            error instanceof GitHubBillingHttpError && error.status === 429
              ? 'rate-limited'
              : 'stale',
          checkedAt,
          stale: true,
          retryAt: this.retryAt,
          warning: 'Showing the last known good Copilot billing snapshot.',
        };
        this.publish(stale);
        return stale;
      }
      const snapshot = this.baseSnapshot('unavailable', checkedAt);
      snapshot.errorCategory =
        error instanceof GitHubBillingHttpError && error.status >= 500
          ? 'upstream-unavailable'
          : 'unknown';
      snapshot.safeErrorCategory = snapshot.errorCategory;
      snapshot.retryAt = this.retryAt;
      snapshot.warning = 'GitHub Copilot billing usage is currently unavailable.';
      this.publish(snapshot);
      return snapshot;
    } finally {
      // Keep the token scoped to this request and never expose it through diagnostics or state.
      token = undefined;
    }
  }

  private snapshotFromUsage(usage: CopilotUsageSummary, checkedAt: number): ProviderSnapshot {
    const plan = (this.options.plan ?? (() => 'auto'))();
    const calculated = calculateCopilotAllowance(
      plan,
      (this.options.customMonthlyCredits ?? (() => undefined))(),
      usage,
    );
    const usageWindows =
      calculated.allowance === null
        ? []
        : [
            {
              id: 'copilot-monthly-ai-credits',
              label: 'Monthly AI Credits',
              usedPercent: Math.max(
                0,
                Math.min(100, (usage.usedCredits / calculated.allowance) * 100),
              ),
              remainingPercent: calculated.remainingPercent ?? 0,
              resetsAt: Math.floor(usage.nextResetAt / 1000),
              windowDurationMinutes: null,
            },
          ];
    const planLabel = plan === 'auto' ? null : plan;
    return {
      ...this.baseSnapshot(
        calculated.allowance === null ? 'plan-configuration-required' : 'ready-calculated',
        checkedAt,
      ),
      availability:
        calculated.allowance === null ? 'plan-configuration-required' : 'ready-calculated',
      connected: true,
      plan: planLabel,
      usageWindows,
      credits: {
        ...usage.credits,
        allowance: calculated.allowance,
        remaining: calculated.remaining,
        allowanceSource: calculated.allowanceSource,
      },
      observedAt: checkedAt,
      checkedAt,
      sourceUpdatedAt: checkedAt,
      lastSuccessfulDataUpdate: checkedAt,
      lastSuccessfulUpdateAt: checkedAt,
      stale: false,
      warning:
        calculated.allowance === null
          ? 'Monthly allowance not configured. Remaining percentage is intentionally not calculated.'
          : 'Calculated from GitHub usage and configured plan allowance.',
      provenance:
        calculated.allowanceSource ??
        'Official GitHub Billing REST API; allowance not provided by the API.',
      metadata: {
        ...this.baseMetadata(),
        currentPeriod: usage.timePeriod,
        nextResetAt: usage.nextResetAt,
        includedCredits: usage.includedCredits,
        additionalCredits: usage.additionalCredits,
        cost: usage.cost,
        modelBreakdown: JSON.stringify(usage.modelBreakdown),
        billingDelayNotice:
          'GitHub billing data may not update immediately after each Copilot request.',
      },
      usageInsights: buildCopilotUsageInsights({
        usage,
        allowance: calculated.allowance,
        checkedAt,
      }),
    };
  }

  /**
   * Best-effort only: called from the `organization-managed` branch when the user has explicitly
   * enabled the experimental entitlement fallback. Returns `undefined` (never throws) on any
   * failure so the caller falls back to the existing, unchanged `organization-managed` snapshot.
   */
  private async tryExperimentalEntitlement(
    token: string,
    checkedAt: number,
  ): Promise<ProviderSnapshot | undefined> {
    try {
      const host = this.options.experimentalHost?.() || undefined;
      const result = await fetchCopilotEntitlement(token, this.options.experimentalFetch!, host);
      if (result.kind !== 'ok') return undefined;
      const { premiumInteractions, chat, completions } = result.summary;
      // A bucket reporting exactly 0 credits used is real data, not an absence of data — only the
      // total absence of every allowlisted bucket means there is nothing to show.
      if (!premiumInteractions && !chat && !completions) return undefined;
      return this.snapshotFromEntitlement(result.summary, checkedAt);
    } catch {
      return undefined;
    }
  }

  private snapshotFromEntitlement(
    summary: CopilotEntitlementSummary,
    checkedAt: number,
  ): ProviderSnapshot {
    const resetAt = summary.quotaResetDate ? Date.parse(summary.quotaResetDate) : NaN;
    // Primary metric for credits/usageWindows: premium interactions first, falling back to
    // whichever allowlisted bucket the endpoint actually populated. Buckets are never summed —
    // the same underlying usage may be reflected in more than one bucket.
    const primary = summary.premiumInteractions ?? summary.chat ?? summary.completions;
    const showPercent =
      primary !== null &&
      primary.creditsUsed !== null &&
      !primary.unlimited &&
      primary.entitlement !== null &&
      primary.entitlement > 0;
    const usageWindows =
      showPercent && primary && primary.percentRemaining !== null
        ? [
            {
              id: 'copilot-experimental-premium-interactions',
              label: 'Premium Interactions',
              usedPercent: Math.max(0, Math.min(100, 100 - primary.percentRemaining)),
              remainingPercent: Math.max(0, Math.min(100, primary.percentRemaining)),
              resetsAt: Number.isFinite(resetAt) ? Math.floor(resetAt / 1000) : null,
              windowDurationMinutes: null,
            },
          ]
        : [];
    // Account management (organization vs. personal) is a fact about who owns the seat; this
    // fallback path only ever runs when the official billing API already reported
    // organization-managed, so that classification is never guessed from endpoint fields.
    const accountManagement: 'organization-managed' | 'personal' | 'unknown' =
      'organization-managed';
    const configuredPlanSetting = (this.options.plan ?? (() => 'auto'))();
    return {
      ...this.baseSnapshot('ready-experimental', checkedAt),
      connected: true,
      plan: summary.copilotPlan,
      usageWindows,
      credits: {
        used: primary?.creditsUsed ?? null,
        allowance: showPercent ? primary!.entitlement : null,
        remaining: showPercent ? primary!.remaining : null,
        allowanceSource: null,
      },
      observedAt: checkedAt,
      checkedAt,
      sourceUpdatedAt: checkedAt,
      lastSuccessfulDataUpdate: checkedAt,
      lastSuccessfulUpdateAt: checkedAt,
      stale: false,
      warning:
        "Organization-managed account: this is the undocumented Copilot entitlement endpoint, not the official personal billing API. Numbers may not match GitHub's own usage page exactly. Usage data may lag behind recent Copilot activity. This metric represents AI credits reported by the entitlement endpoint, not total chat messages.",
      source: 'Experimental — GitHub Copilot entitlement endpoint',
      provenance:
        'Experimental — undocumented GitHub Copilot entitlement endpoint (copilot_internal/user).',
      metadata: {
        ...this.baseMetadata(),
        billingEndpoint: 'experimental-entitlement',
        accountManagement,
        endpointPlan: summary.copilotPlan ?? 'Not provided',
        configuredBillingScope: configuredPlanSetting,
        copilotPlan: summary.copilotPlan,
        accessTypeSku: summary.accessTypeSku,
        tokenBasedBilling: summary.tokenBasedBilling,
        quotaResetAt: Number.isFinite(resetAt) ? resetAt : null,
        quotaUnlimited: primary?.unlimited ?? null,
        quotaOveragePermitted: primary?.overagePermitted ?? null,
        premiumInteractionsCreditsUsed: summary.premiumInteractions?.creditsUsed ?? null,
        chatCreditsUsed: summary.chat?.creditsUsed ?? null,
        completionsCreditsUsed: summary.completions?.creditsUsed ?? null,
      },
      usageInsights: buildCopilotEntitlementInsights({
        summary,
        configuredBillingScope: configuredPlanSetting,
        checkedAt,
      }),
    };
  }

  private baseSnapshot(
    availability: ProviderSnapshot['availability'],
    checkedAt = Date.now(),
  ): ProviderSnapshot {
    return {
      providerId: this.id,
      providerName: this.displayName,
      availability,
      connected: availability === 'organization-managed' || availability === 'ready-experimental',
      plan: null,
      cliVersion: this.cli.version,
      extensionVersion: this.extension.version,
      usageWindows: [],
      source: 'Official GitHub Billing REST API',
      provenance: 'Official GitHub Billing REST API; user-level AI credit usage.',
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
      extensionIds: this.extension.ids.join(','),
      nextRefreshAt:
        this.lastRefreshAt +
        clampCopilotRefreshSeconds(
          (this.options.refreshSeconds ?? (() => DEFAULT_COPILOT_REFRESH_SECONDS))(),
        ) *
          1000,
      refreshIntervalSeconds: clampCopilotRefreshSeconds(
        (this.options.refreshSeconds ?? (() => DEFAULT_COPILOT_REFRESH_SECONDS))(),
      ),
      retryAt: this.retryAt || null,
    };
  }

  async configurePlan(
    plan: CopilotPlan,
    customMonthlyCredits?: number,
  ): Promise<ProviderSnapshot | undefined> {
    // The extension owns configuration persistence; this method is a convenient refresh hook for commands.
    void plan;
    void customMonthlyCredits;
    return this.refresh(true);
  }

  get cliInfo(): CopilotCliInfo {
    return this.cli;
  }

  get extensionInfo(): CopilotExtensionInfo {
    return this.extension;
  }

  get tokenPresent(): boolean {
    return false;
  }

  private publish(snapshot: ProviderSnapshot): void {
    this.snapshot = snapshot;
    this.emitter.fire(snapshot);
  }
}
