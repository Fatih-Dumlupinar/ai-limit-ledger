import {
  mementoLeaseStore,
  tryAcquireLease,
  type MementoLike as LeaseMemento,
} from '../../RefreshLease';
import {
  backoffRemainingMs,
  isBackoffActive,
  mementoBackoffStore,
  recordRateLimited,
  recordSuccess,
  type MementoLike as BackoffMemento,
} from './ClaudeOAuthBackoff';
import {
  credentialsPathFor,
  readClaudeAccessToken,
  type CredentialFsLike,
} from './ClaudeCredentialReader';
import {
  fetchClaudeOAuthUsage,
  type FetchLike,
  type UsageWindowResult,
} from './ClaudeOAuthUsageTransport';
import {
  loadOAuthUsageConsent,
  loadOAuthUsageLastKnownGood,
  saveOAuthUsageLastKnownGood,
  type GlobalStateLike,
} from '../ClaudeRecoveryStore';
import { isCacheExpired } from '../../../configuration/EffectiveSettings';

const LEASE_KEY = 'aiLimitLedger.claude.oauthUsageRefreshLease';
const LEASE_TTL_MS = 15_000;
const BACKOFF_KEY = 'aiLimitLedger.claude.oauthUsageBackoff';
const LAST_FETCH_KEY = 'aiLimitLedger.claude.oauthUsageLastFetchAt';

export type OAuthUsageAvailability =
  | 'disabled'
  | 'consent-required'
  | 'authentication-required'
  | 'unavailable'
  | 'ready'
  | 'stale'
  | 'rate-limited';

export interface ClaudeOAuthSnapshot {
  availability: OAuthUsageAvailability;
  fiveHour?: UsageWindowResult;
  sevenDay?: UsageWindowResult;
  checkedAt: number;
  observedAt: number | null;
  stale: boolean;
  retryAt: number | null;
  /** Earliest local time at which another OAuth request is eligible. */
  nextEligibleAt?: number | null;
  cacheExpired?: boolean;
}

export type RefreshTrigger = 'timer' | 'activity' | 'manual';

export interface ClaudeOAuthUsageServiceDeps {
  fs: CredentialFsLike;
  homeDir: string;
  fetchImpl: FetchLike;
  globalState: GlobalStateLike & LeaseMemento & BackoffMemento;
  enabled: () => boolean;
  refreshSecondsProvider: () => number;
  windowId: string;
  cacheMaxAgeHoursProvider?: () => number;
  showExpiredCacheProvider?: () => boolean;
  now?: () => number;
}

const DEFAULT_REFRESH_SECONDS = 120;

/**
 * Orchestrates the experimental OAuth usage transport end to end: consent/enabled gating,
 * cross-window single-flight (a short lease, mirroring `RefreshLease`), the minimum-interval and
 * 429-backoff clocks (shared machine-wide, never per-window), and a last-known-good fallback.
 * Never reads a credential unless the feature is both consented to and enabled; never keeps a
 * token beyond the lifetime of one in-flight request.
 */
export class ClaudeOAuthUsageService {
  private snapshot: ClaudeOAuthSnapshot | undefined;
  private inFlight: Promise<ClaudeOAuthSnapshot> | undefined;
  /** Every trigger shares identical gating; kept only for future diagnostics. */
  private lastTrigger: RefreshTrigger | undefined;
  private readonly listeners = new Set<(snapshot: ClaudeOAuthSnapshot) => void>();
  private readonly now: () => number;

  constructor(private readonly deps: ClaudeOAuthUsageServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  onDidChange(listener: (snapshot: ClaudeOAuthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ClaudeOAuthSnapshot | undefined {
    return this.snapshot;
  }

  private emit(snapshot: ClaudeOAuthSnapshot): ClaudeOAuthSnapshot {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  private lastKnownGoodSnapshot(
    availability: OAuthUsageAvailability,
    retryAt: number | null,
  ): ClaudeOAuthSnapshot {
    const lkg = loadOAuthUsageLastKnownGood(this.deps.globalState);
    const checkedAt = this.now();
    if (!lkg)
      return {
        availability,
        checkedAt,
        observedAt: null,
        stale: false,
        retryAt,
        nextEligibleAt: retryAt,
      };
    const cacheExpired = isCacheExpired(
      lkg.capturedAt,
      checkedAt,
      this.deps.cacheMaxAgeHoursProvider?.() ?? 24,
    );
    const showExpired = this.deps.showExpiredCacheProvider?.() ?? false;
    return {
      availability,
      ...(cacheExpired && !showExpired
        ? {}
        : {
            fiveHour:
              lkg.fiveHourUsedPercent === null
                ? undefined
                : {
                    usedPercent: lkg.fiveHourUsedPercent,
                    remainingPercent: 100 - lkg.fiveHourUsedPercent,
                    resetsAt: lkg.fiveHourResetsAt,
                  },
            sevenDay:
              lkg.sevenDayUsedPercent === null
                ? undefined
                : {
                    usedPercent: lkg.sevenDayUsedPercent,
                    remainingPercent: 100 - lkg.sevenDayUsedPercent,
                    resetsAt: lkg.sevenDayResetsAt,
                  },
          }),
      checkedAt,
      observedAt: lkg.capturedAt,
      stale: true,
      retryAt,
      nextEligibleAt: retryAt,
      cacheExpired,
    };
  }

  /**
   * The single entry point. Every trigger — the periodic timer, a Stop-hook activity signal, or
   * the user's own manual refresh — goes through the exact same gates: enabled, consented,
   * outside an active 429 pause, minimum interval, and cross-window lease. No trigger bypasses
   * any of them.
   */
  async requestRefresh(trigger: RefreshTrigger): Promise<ClaudeOAuthSnapshot> {
    this.lastTrigger = trigger;
    if (this.inFlight) return this.inFlight;
    const run = this.doRefresh();
    this.inFlight = run.finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<ClaudeOAuthSnapshot> {
    const now = this.now();

    if (!this.deps.enabled()) {
      return this.emit({
        availability: 'disabled',
        checkedAt: now,
        observedAt: null,
        stale: false,
        retryAt: null,
        nextEligibleAt: null,
      });
    }
    if (!loadOAuthUsageConsent(this.deps.globalState)) {
      return this.emit({
        availability: 'consent-required',
        checkedAt: now,
        observedAt: null,
        stale: false,
        retryAt: null,
        nextEligibleAt: null,
      });
    }

    const backoffStore = mementoBackoffStore(this.deps.globalState, BACKOFF_KEY);
    if (isBackoffActive(backoffStore, BACKOFF_KEY, now)) {
      return this.emit(
        this.lastKnownGoodSnapshot(
          'rate-limited',
          now + backoffRemainingMs(backoffStore, BACKOFF_KEY, now),
        ),
      );
    }

    const refreshMs = Math.max(DEFAULT_REFRESH_SECONDS, this.deps.refreshSecondsProvider()) * 1000;
    const lastFetchAt = this.deps.globalState.get<number>(LAST_FETCH_KEY) ?? 0;
    if (now - lastFetchAt < refreshMs) {
      return this.emit({
        ...(this.snapshot ?? this.lastKnownGoodSnapshot('stale', null)),
        nextEligibleAt: lastFetchAt + refreshMs,
      });
    }

    const leaseStore = mementoLeaseStore(this.deps.globalState, LEASE_KEY);
    if (!tryAcquireLease(leaseStore, LEASE_KEY, this.deps.windowId, LEASE_TTL_MS, now)) {
      // Another window is the leader for this cycle; render from the shared last-known-good
      // snapshot instead of also hitting the network.
      return this.emit({
        ...(this.snapshot ?? this.lastKnownGoodSnapshot('stale', null)),
        nextEligibleAt: lastFetchAt + refreshMs,
      });
    }

    const credentialsPath = credentialsPathFor(this.deps.homeDir);
    const credential = await readClaudeAccessToken(this.deps.fs, credentialsPath, this.now);
    if (credential.kind === 'missing' || credential.kind === 'invalid') {
      return this.emit({
        availability: 'unavailable',
        checkedAt: now,
        observedAt: null,
        stale: false,
        retryAt: null,
        nextEligibleAt: null,
      });
    }
    if (credential.kind === 'expired') {
      return this.emit({
        availability: 'authentication-required',
        checkedAt: now,
        observedAt: null,
        stale: false,
        retryAt: null,
        nextEligibleAt: null,
      });
    }

    await this.deps.globalState.update(LAST_FETCH_KEY, now);
    const result = await fetchClaudeOAuthUsage(
      credential.accessToken,
      this.deps.fetchImpl,
      this.now,
    );

    if (result.kind === 'rate-limited') {
      const state = recordRateLimited(backoffStore, BACKOFF_KEY, result.retryAfterSeconds, now);
      return this.emit(this.lastKnownGoodSnapshot('rate-limited', state.retryAt));
    }
    if (result.kind === 'authentication-required') {
      return this.emit({
        availability: 'authentication-required',
        checkedAt: now,
        observedAt: null,
        stale: false,
        retryAt: null,
        nextEligibleAt: null,
      });
    }
    if (result.kind === 'failure') {
      // A non-429 failure does not touch the shared 429 backoff clock — only the ordinary
      // minimum-interval gate governs the next attempt — but the last-known-good value (if any)
      // is preserved and marked stale rather than discarded.
      return this.emit(this.lastKnownGoodSnapshot('stale', null));
    }

    recordSuccess(backoffStore, BACKOFF_KEY);
    await saveOAuthUsageLastKnownGood(this.deps.globalState, {
      fiveHourUsedPercent: result.fiveHour?.usedPercent ?? null,
      fiveHourResetsAt: result.fiveHour?.resetsAt ?? null,
      sevenDayUsedPercent: result.sevenDay?.usedPercent ?? null,
      sevenDayResetsAt: result.sevenDay?.resetsAt ?? null,
      capturedAt: now,
    });
    return this.emit({
      availability: 'ready',
      fiveHour: result.fiveHour,
      sevenDay: result.sevenDay,
      checkedAt: now,
      observedAt: now,
      stale: false,
      retryAt: null,
      nextEligibleAt: now + refreshMs,
    });
  }
}
