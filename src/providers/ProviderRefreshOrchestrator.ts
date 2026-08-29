import { mementoLeaseStore, tryAcquireLease, type MementoLike } from './RefreshLease';
import type { ProviderCoordinator } from './ProviderCoordinator';
import { normalizeProviderId } from './ProviderCapabilityContract';
import type { ProviderAvailability, ProviderId } from './types';
import type { SafeErrorCategory } from '../infrastructure/ProviderDiagnostics';

export type RefreshInvocationSource = 'command-palette' | 'dashboard' | 'internal';

export interface RefreshInvocationContext {
  source: RefreshInvocationSource;
  correlationId?: string;
  /** Manual provider actions may skip the ordinary freshness interval, never backoff. */
  force?: boolean;
}

export interface ProviderRefreshResult {
  providerId: ProviderId;
  ok: boolean;
  status: 'success' | 'throttled' | 'cancelled' | 'error';
  correlationId: string;
  safeErrorCategory?: SafeErrorCategory;
  availability?: ProviderAvailability;
  checkedAt?: number;
  nextRefreshAt?: number;
}

export interface ProviderRefreshOrchestratorOptions {
  coordinator: ProviderCoordinator;
  globalState?: MementoLike;
  windowId?: string;
  logger?: { createCorrelationId?: () => string };
  /** Claude's OAuth service already owns consent, minimum-interval, lease and backoff gates. */
  refreshClaudeOAuth?: () => Promise<unknown>;
  leaseTtlMs?: number;
}

const PROVIDER_LEASE_PREFIX = 'aiLimitLedger.providerRefreshLease';
const DEFAULT_LEASE_TTL_MS = 8_000;

function correlationIdFor(options: ProviderRefreshOrchestratorOptions, requested?: string): string {
  return (
    requested ??
    options.logger?.createCorrelationId?.() ??
    `refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function providerIdOf(value: string): ProviderId | undefined {
  const normalized = normalizeProviderId(value);
  return normalized === 'codex' ||
    normalized === 'claude' ||
    normalized === 'copilot' ||
    normalized === 'grok'
    ? normalized
    : undefined;
}

/**
 * The only host entry point for user-initiated provider refreshes. It keeps provider transport
 * details out of Dashboard/Command Palette code and makes Refresh All a composition of the same
 * four isolated provider paths.
 */
export class ProviderRefreshOrchestrator {
  private readonly running = new Map<ProviderId, Promise<ProviderRefreshResult>>();
  private readonly leaseTtlMs: number;

  constructor(private readonly options: ProviderRefreshOrchestratorOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  async refreshProvider(
    providerId: ProviderId | string,
    context: RefreshInvocationContext,
  ): Promise<ProviderRefreshResult> {
    const id = providerIdOf(providerId);
    const correlationId = correlationIdFor(this.options, context.correlationId);
    if (!id) {
      return {
        providerId: 'codex',
        ok: false,
        status: 'error',
        correlationId,
        safeErrorCategory: 'configuration-error',
      };
    }

    const existing = this.running.get(id);
    if (existing) return existing;

    const run = this.refreshOne(id, context, correlationId).finally(() => {
      if (this.running.get(id) === run) this.running.delete(id);
    });
    this.running.set(id, run);
    return run;
  }

  async refreshAll(context: RefreshInvocationContext): Promise<ProviderRefreshResult[]> {
    const correlationId = correlationIdFor(this.options, context.correlationId);
    const providerIds = this.options.coordinator
      .getSelectedProviderIds()
      .map(providerIdOf)
      .filter((id): id is ProviderId => id !== undefined);
    const settled = await Promise.allSettled(
      providerIds.map((providerId) =>
        this.refreshProvider(providerId, { ...context, correlationId }),
      ),
    );
    return settled.map((result, index) => {
      const providerId = providerIds[index];
      if (result.status === 'fulfilled') return result.value;
      return {
        providerId,
        ok: false,
        status: 'error',
        correlationId,
        safeErrorCategory: 'unknown',
      } satisfies ProviderRefreshResult;
    });
  }

  dispose(): void {
    this.running.clear();
  }

  private async refreshOne(
    providerId: ProviderId,
    context: RefreshInvocationContext,
    correlationId: string,
  ): Promise<ProviderRefreshResult> {
    if (!this.options.coordinator.getSelectedProviderIds().includes(providerId)) {
      return {
        providerId,
        ok: false,
        status: 'error',
        correlationId,
        availability: 'not-selected',
        safeErrorCategory: 'configuration-error',
      };
    }

    const leaseKey = `${PROVIDER_LEASE_PREFIX}.${providerId}`;
    const leaseStore = this.options.globalState
      ? mementoLeaseStore(this.options.globalState, leaseKey)
      : undefined;
    if (
      leaseStore &&
      !tryAcquireLease(leaseStore, leaseKey, this.options.windowId ?? 'default', this.leaseTtlMs)
    ) {
      return {
        providerId,
        ok: false,
        status: 'throttled',
        correlationId,
        safeErrorCategory: 'throttled',
      };
    }

    const result = await this.options.coordinator.refreshProvider(
      providerId,
      context.force ?? false,
      correlationId,
    );
    if (providerId === 'claude' && this.options.refreshClaudeOAuth) {
      try {
        await this.options.refreshClaudeOAuth();
      } catch {
        // The official Claude snapshot remains useful if the optional OAuth capability fails.
        // The service itself converts transport failures into a safe last-known-good snapshot.
      }
    }
    return {
      providerId,
      ok: result.ok,
      status: result.status,
      correlationId,
      ...(result.availability ? { availability: result.availability } : {}),
      ...(result.safeErrorCategory ? { safeErrorCategory: result.safeErrorCategory } : {}),
      ...(result.checkedAt ? { checkedAt: result.checkedAt } : {}),
      ...(result.nextRefreshAt ? { nextRefreshAt: result.nextRefreshAt } : {}),
    };
  }
}
