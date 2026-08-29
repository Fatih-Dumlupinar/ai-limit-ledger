import * as vscode from 'vscode';
import {
  diagnosticForError,
  formatDiagnostic,
  type DiagnosticLogger,
  type SafeErrorCategory,
} from '../infrastructure/ProviderDiagnostics';
import { normalizeProviderId, type ProviderLifecyclePhase } from './ProviderCapabilityContract';
import type { ProviderAdapter, ProviderAvailability, ProviderSnapshot } from './types';
import type { ProviderRefreshResult } from './ProviderRefreshOrchestrator';

export type { ProviderRefreshResult } from './ProviderRefreshOrchestrator';

export { normalizeProviderId } from './ProviderCapabilityContract';
export type { ProviderLifecyclePhase } from './ProviderCapabilityContract';

export interface ProviderLifecycleRecord {
  providerId: string;
  phase: ProviderLifecyclePhase;
  checkedAt: number;
  errorCategory?: SafeErrorCategory;
}

export type ProviderFactory = () => ProviderAdapter;

export interface ProviderCoordinatorOptions {
  selectedProviderIds?: readonly string[];
  providerFactories?: Readonly<Record<string, ProviderFactory>>;
}

/**
 * Owns provider lifecycle independently from provider detection. A selected provider gets an
 * initial snapshot before awaits; a rejected or silent provider gets a safe fallback snapshot so
 * the UI can never mistake a startup failure for an infinite initialization state.
 */
export class ProviderCoordinator implements vscode.Disposable {
  private readonly snapshots = new Map<string, ProviderSnapshot>();
  private readonly lifecycle = new Map<string, ProviderLifecycleRecord>();
  private readonly listeners = new Map<string, vscode.Disposable>();
  private readonly emitter = new vscode.EventEmitter<ProviderSnapshot[]>();
  private readonly factories: Readonly<Record<string, ProviderFactory>>;
  private selected = new Set<string>();
  readonly onDidChange = this.emitter.event;

  constructor(
    readonly providers: ProviderAdapter[],
    private readonly logger?: DiagnosticLogger,
    options: ProviderCoordinatorOptions = {},
  ) {
    this.factories = options.providerFactories ?? {};
    const selected = options.selectedProviderIds ?? providers.map((provider) => provider.id);
    this.selected = new Set(selected.map(normalizeProviderId));
    providers.forEach((provider) => {
      this.bind(provider);
      if (!this.selected.has(normalizeProviderId(provider.id))) {
        this.setLifecycle(provider.id, 'not-selected');
        this.publish(this.lifecycleSnapshot(provider, 'not-selected'));
      }
    });
  }

  async start(): Promise<void> {
    for (const provider of this.providers) {
      if (!this.selected.has(normalizeProviderId(provider.id))) {
        this.setLifecycle(provider.id, 'not-selected');
        this.publish(this.lifecycleSnapshot(provider, 'not-selected'));
      }
    }
    const selectedProviders = this.providers.filter((provider) =>
      this.selected.has(normalizeProviderId(provider.id)),
    );
    const correlationId = this.logger?.createCorrelationId?.();
    // Promise.allSettled intentionally covers every selected provider; one broken integration must
    // not prevent the remaining providers from reaching their own first snapshot.
    await Promise.allSettled(
      selectedProviders.map((provider) => this.startOne(provider, correlationId)),
    );
  }

  async reconcile(providerIds: readonly string[]): Promise<void> {
    const next = new Set(providerIds.map(normalizeProviderId));
    const previous = this.selected;
    this.selected = next;

    for (const provider of [...this.providers]) {
      const id = normalizeProviderId(provider.id);
      if (previous.has(id) && !next.has(id)) {
        provider.stop();
        this.listeners.get(id)?.dispose();
        this.listeners.delete(id);
        this.setLifecycle(id, 'stopped');
        this.publish(this.lifecycleSnapshot(provider, 'not-selected'));
      }
    }

    const starts: Promise<void>[] = [];
    const correlationId = this.logger?.createCorrelationId?.();
    for (const id of next) {
      let provider = this.getProvider(id);
      const prior = this.lifecycle.get(id)?.phase;
      if (!provider || prior === 'stopped') {
        const factory = this.factories[id];
        if (!factory) {
          this.publish(this.lifecycleSnapshotForId(id, 'startup-error'));
          this.setLifecycle(id, 'failed', 'unknown');
          continue;
        }
        provider = factory();
        const index = this.providers.findIndex(
          (candidate) => normalizeProviderId(candidate.id) === id,
        );
        if (index >= 0) this.providers[index] = provider;
        else this.providers.push(provider);
        this.bind(provider);
      }
      if (prior !== 'started' && prior !== 'initializing')
        starts.push(this.startOne(provider, correlationId));
    }
    await Promise.allSettled(starts);
  }

  async refresh(force = false, operationCorrelationId?: string): Promise<ProviderRefreshResult[]> {
    const selectedProviders = this.providers.filter((provider) =>
      this.selected.has(normalizeProviderId(provider.id)),
    );
    const correlationId = operationCorrelationId ?? this.logger?.createCorrelationId?.();
    const results = await Promise.allSettled(
      selectedProviders.map((provider) =>
        this.refreshProvider(normalizeProviderId(provider.id), force, correlationId),
      ),
    );
    return results.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : ({
            providerId: normalizeProviderId(
              selectedProviders[index].id,
            ) as ProviderRefreshResult['providerId'],
            ok: false,
            status: 'error',
            correlationId:
              correlationId ?? this.logger?.createCorrelationId?.() ?? 'refresh-failed',
            availability: this.snapshots.get(normalizeProviderId(selectedProviders[index].id))
              ?.availability,
            safeErrorCategory: diagnosticForError(
              selectedProviders[index].id,
              'refresh',
              result.reason,
            ).category,
          } satisfies ProviderRefreshResult),
    );
  }

  async refreshProvider(
    providerId: string,
    force = false,
    operationCorrelationId?: string,
  ): Promise<ProviderRefreshResult> {
    const canonicalId = normalizeProviderId(providerId);
    const provider = this.getProvider(canonicalId);
    const correlationId =
      operationCorrelationId ?? this.logger?.createCorrelationId?.() ?? 'refresh-operation';
    if (!provider || !this.selected.has(canonicalId)) {
      return {
        providerId: canonicalId as ProviderRefreshResult['providerId'],
        ok: false,
        status: 'error',
        correlationId,
        availability: !provider ? undefined : 'not-selected',
        safeErrorCategory: 'configuration-error',
      };
    }

    const startedAt = Date.now();
    this.logRecord('info', {
      correlationId,
      providerId: canonicalId,
      action: 'operation.started',
      stage: 'refresh',
      message: 'Provider refresh started.',
    });
    try {
      const snapshot = await provider.refresh(force);
      const throttled =
        snapshot?.availability === 'rate-limited' ||
        snapshot?.availability === 'rate-limited-experimental';
      this.logRecord(throttled ? 'warn' : 'info', {
        correlationId,
        providerId: canonicalId,
        action: throttled ? 'operation.throttled' : 'operation.completed',
        stage: 'refresh',
        durationMs: Date.now() - startedAt,
        availability: snapshot?.availability,
        category: snapshot?.errorCategory,
        message: 'Provider refresh completed.',
      });
      return {
        providerId: canonicalId as ProviderRefreshResult['providerId'],
        ok: true,
        status: throttled ? 'throttled' : 'success',
        correlationId,
        availability: snapshot?.availability,
        ...(snapshot?.errorCategory ? { safeErrorCategory: snapshot.errorCategory } : {}),
        ...(snapshot?.checkedAt ? { checkedAt: snapshot.checkedAt } : {}),
        ...(snapshot?.nextFallbackRefreshAt
          ? { nextRefreshAt: snapshot.nextFallbackRefreshAt }
          : typeof snapshot?.metadata?.nextRefreshAt === 'number'
            ? { nextRefreshAt: snapshot.metadata.nextRefreshAt }
            : {}),
      };
    } catch (error) {
      const diagnostic = diagnosticForError(canonicalId, 'refresh', error);
      this.logRecord(diagnostic.category === 'cancelled' ? 'info' : 'error', {
        correlationId,
        providerId: canonicalId,
        action: diagnostic.category === 'cancelled' ? 'operation.cancelled' : 'operation.failed',
        stage: 'refresh',
        category: diagnostic.category,
        durationMs: Date.now() - startedAt,
        message: 'Provider refresh failed.',
      });
      this.logError(`Provider refresh rejected ${formatDiagnostic(diagnostic)}`);
      return {
        providerId: canonicalId as ProviderRefreshResult['providerId'],
        ok: false,
        status: diagnostic.category === 'cancelled' ? 'cancelled' : 'error',
        correlationId,
        safeErrorCategory: diagnostic.category,
        availability: this.snapshots.get(canonicalId)?.availability,
      };
    }
  }

  getSnapshot(providerId: string): ProviderSnapshot | undefined {
    const id = normalizeProviderId(providerId);
    const snapshot = this.snapshots.get(id) ?? this.getProvider(id)?.getSnapshot();
    return snapshot ? this.canonicalSnapshot(snapshot) : undefined;
  }

  getSnapshots(): ProviderSnapshot[] {
    return this.providers.map((provider) => {
      const id = normalizeProviderId(provider.id);
      if (!this.selected.has(id)) return this.lifecycleSnapshot(provider, 'not-selected');
      const snapshot =
        this.snapshots.get(id) ??
        provider.getSnapshot() ??
        this.lifecycleSnapshot(provider, 'initializing');
      return this.decorateSnapshot(snapshot, id, true);
    });
  }

  getProvider<T extends ProviderAdapter = ProviderAdapter>(providerId: string): T | undefined {
    const id = normalizeProviderId(providerId);
    return this.providers.find((provider) => normalizeProviderId(provider.id) === id) as
      T | undefined;
  }

  getSelectedProviderIds(): string[] {
    return [...this.selected];
  }

  getLifecycle(
    providerId?: string,
  ): ProviderLifecycleRecord | ProviderLifecycleRecord[] | undefined {
    if (providerId !== undefined) return this.lifecycle.get(normalizeProviderId(providerId));
    return this.providers
      .map((provider) => this.lifecycle.get(normalizeProviderId(provider.id)))
      .filter((record): record is ProviderLifecycleRecord => Boolean(record));
  }

  dispose(): void {
    this.providers.forEach((provider) => provider.stop());
    this.listeners.forEach((listener) => listener.dispose());
    this.listeners.clear();
    this.emitter.dispose();
  }

  private bind(provider: ProviderAdapter): void {
    const id = normalizeProviderId(provider.id);
    this.listeners.get(id)?.dispose();
    this.listeners.set(
      id,
      provider.onDidChange((snapshot) => {
        this.snapshots.set(
          normalizeProviderId(snapshot.providerId),
          this.canonicalSnapshot(snapshot),
        );
        this.emitter.fire(this.getSnapshots());
      }),
    );
  }

  private async startOne(provider: ProviderAdapter, correlationId?: string): Promise<void> {
    const id = normalizeProviderId(provider.id);
    const startedAt = Date.now();
    this.logRecord('info', {
      correlationId,
      providerId: id,
      action: 'operation.started',
      stage: 'start',
      message: 'Provider startup started.',
    });
    this.setLifecycle(id, 'initializing');
    // Drop a previous synthetic not-selected snapshot. From this point on, only an actual
    // provider event/getSnapshot can satisfy the startup contract.
    this.snapshots.delete(id);
    this.publish(this.lifecycleSnapshot(provider, 'initializing'));
    try {
      await provider.start();
      await provider.refresh();
      const actualSnapshot = this.snapshots.get(id) ?? provider.getSnapshot();
      if (!actualSnapshot) {
        this.logRecord('error', {
          correlationId,
          providerId: id,
          action: 'operation.failed',
          stage: 'start',
          category: 'initialize-failed',
          durationMs: Date.now() - startedAt,
          message: 'Provider startup produced no snapshot.',
        });
        this.publish(this.lifecycleSnapshot(provider, 'startup-error'));
      } else {
        this.logRecord('info', {
          correlationId,
          providerId: id,
          action: 'operation.completed',
          stage: 'start',
          durationMs: Date.now() - startedAt,
          availability: actualSnapshot.availability,
          message: 'Provider startup completed.',
        });
      }
      this.setLifecycle(id, !actualSnapshot ? 'failed' : 'started');
    } catch (error) {
      const diagnostic = diagnosticForError(id, 'start', error);
      this.logRecord(diagnostic.category === 'cancelled' ? 'info' : 'error', {
        correlationId,
        providerId: id,
        action: diagnostic.category === 'cancelled' ? 'operation.cancelled' : 'operation.failed',
        stage: 'start',
        category: diagnostic.category,
        durationMs: Date.now() - startedAt,
        message: 'Provider startup failed.',
      });
      this.logError(`Provider startup rejected ${formatDiagnostic(diagnostic)}`);
      this.publish(this.lifecycleSnapshot(provider, 'startup-error', diagnostic.category));
      this.setLifecycle(id, 'failed', diagnostic.category);
      throw error;
    }
  }

  private setLifecycle(
    id: string,
    phase: ProviderLifecyclePhase,
    errorCategory?: SafeErrorCategory,
  ): void {
    this.lifecycle.set(normalizeProviderId(id), {
      providerId: normalizeProviderId(id),
      phase,
      checkedAt: Date.now(),
      ...(errorCategory ? { errorCategory } : {}),
    });
  }

  private publish(snapshot: ProviderSnapshot): void {
    this.snapshots.set(normalizeProviderId(snapshot.providerId), this.canonicalSnapshot(snapshot));
    this.emitter.fire(this.getSnapshots());
  }

  private logRecord(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
    fields: Parameters<NonNullable<DiagnosticLogger['logRecord']>>[1],
  ): void {
    try {
      this.logger?.logRecord?.(level, fields);
    } catch {
      // Observability must never become a provider failure or stop another provider.
    }
  }

  private logError(message: string): void {
    try {
      this.logger?.error(message);
    } catch {
      // A broken output channel is not a provider failure.
    }
  }

  private canonicalSnapshot(snapshot: ProviderSnapshot): ProviderSnapshot {
    const providerId = normalizeProviderId(snapshot.providerId);
    return providerId === snapshot.providerId ? snapshot : { ...snapshot, providerId };
  }

  /** Adds coordinator-owned lifecycle facts without overwriting provider-specific metadata. */
  private decorateSnapshot(
    snapshot: ProviderSnapshot,
    providerId: string,
    selected: boolean,
  ): ProviderSnapshot {
    const lifecyclePhase = this.lifecycle.get(providerId)?.phase ?? 'initializing';
    return {
      ...snapshot,
      providerId,
      metadata: {
        ...snapshot.metadata,
        selected,
        lifecyclePhase,
      },
    };
  }

  private lifecycleSnapshot(
    provider: ProviderAdapter,
    availability: ProviderAvailability,
    errorCategory?: SafeErrorCategory,
  ): ProviderSnapshot {
    return this.lifecycleSnapshotForId(
      normalizeProviderId(provider.id),
      availability,
      provider,
      errorCategory,
    );
  }

  private lifecycleSnapshotForId(
    providerId: string,
    availability: ProviderAvailability,
    provider = this.getProvider(providerId),
    errorCategory?: SafeErrorCategory,
  ): ProviderSnapshot {
    const checkedAt = Date.now();
    return {
      providerId: normalizeProviderId(providerId),
      providerName: provider?.displayName ?? normalizeProviderId(providerId),
      availability,
      connected: false,
      plan: null,
      cliVersion: null,
      usageWindows: [],
      source: 'Not connected',
      observedAt: checkedAt,
      checkedAt,
      stale: false,
      ...(errorCategory ? { errorCategory, safeErrorCategory: errorCategory } : {}),
      warning:
        availability === 'not-selected'
          ? 'Provider is not selected in aiLimitLedger.providers.'
          : availability === 'startup-error'
            ? 'Provider failed during startup. Open diagnostics for the safe error category.'
            : availability === 'initializing'
              ? 'Provider startup is in progress.'
              : undefined,
      capabilities: provider?.capabilities ?? {
        rateLimits: false,
        usage: false,
        statusLine: false,
      },
      metadata: {
        selected: availability !== 'not-selected',
        lifecyclePhase:
          availability === 'not-selected'
            ? 'not-selected'
            : availability === 'startup-error'
              ? 'failed'
              : availability,
      },
    };
  }
}
