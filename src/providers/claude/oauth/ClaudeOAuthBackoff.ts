/**
 * Pure, deterministic 429 backoff for the experimental Claude OAuth usage transport. Shared
 * machine-wide (via `BackoffStore`, the same `vscode.Memento`-shaped contract as `RefreshLease`)
 * so multiple VS Code windows never keep independent backoff clocks for the same account.
 */
export interface BackoffState {
  consecutive429s: number;
  retryAt: number;
}

export interface BackoffStore {
  get(key: string): BackoffState | undefined;
  set(key: string, value: BackoffState): void | PromiseLike<void>;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export function mementoBackoffStore(memento: MementoLike, key: string): BackoffStore {
  return {
    get: () => memento.get<BackoffState>(key),
    set: (_key, value) => memento.update(key, value),
  };
}

const MINUTE_MS = 60_000;
/** Retry-After-less sequence for the 1st/2nd/3rd consecutive 429 in a row. */
const SEQUENCE_MS = [2 * MINUTE_MS, 4 * MINUTE_MS, 8 * MINUTE_MS];
const MIN_PAUSE_AFTER_THREE_MS = 15 * MINUTE_MS;
const MAX_BACKOFF_MS = 60 * MINUTE_MS;

/** True while a shared backoff clock says a new network request must not be sent yet. */
export function isBackoffActive(
  store: BackoffStore,
  key: string,
  now: number = Date.now(),
): boolean {
  const state = store.get(key);
  return Boolean(state && state.retryAt > now);
}

/** Milliseconds until the next allowed attempt (0 if none is active). */
export function backoffRemainingMs(
  store: BackoffStore,
  key: string,
  now: number = Date.now(),
): number {
  const state = store.get(key);
  if (!state || state.retryAt <= now) return 0;
  return state.retryAt - now;
}

/**
 * Records a 429 response and computes the next allowed attempt. `retryAfterSeconds` (from the
 * response's `Retry-After` header) is honored exactly when present, except that the 15-minute
 * floor after three consecutive 429s always wins if it is larger — the server-provided value is
 * never allowed to leave AI Limit Ledger hammering the endpoint sooner than the hard floor.
 */
export function recordRateLimited(
  store: BackoffStore,
  key: string,
  retryAfterSeconds: number | undefined,
  now: number = Date.now(),
): BackoffState {
  const previous = store.get(key);
  const consecutive429s = (previous?.consecutive429s ?? 0) + 1;
  const sequenceIndex = Math.min(consecutive429s, SEQUENCE_MS.length) - 1;
  const sequenceMs = SEQUENCE_MS[sequenceIndex] ?? SEQUENCE_MS[SEQUENCE_MS.length - 1];
  const doublingBeyondSequence =
    consecutive429s > SEQUENCE_MS.length
      ? sequenceMs * 2 ** (consecutive429s - SEQUENCE_MS.length)
      : sequenceMs;
  const computedMs = Math.min(MAX_BACKOFF_MS, doublingBeyondSequence);
  const retryAfterMs =
    retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1000
      : undefined;
  const floorMs = consecutive429s >= 3 ? MIN_PAUSE_AFTER_THREE_MS : 0;
  const backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs ?? computedMs, floorMs));
  const state: BackoffState = { consecutive429s, retryAt: now + backoffMs };
  void store.set(key, state);
  return state;
}

/** Clears the backoff clock after a successful request. */
export function recordSuccess(store: BackoffStore, key: string): void {
  void store.set(key, { consecutive429s: 0, retryAt: 0 });
}
