/**
 * A minimal cross-window "leader" lease: when more than one VS Code window has AI Limit Ledger
 * active, this prevents them from all issuing a real provider refresh for the same trigger at
 * once. Backed by `vscode.Memento`-shaped storage (shared machine-wide, not per-window), so it
 * needs no IPC of its own.
 */
export interface LeaseState {
  holder: string;
  expiresAt: number;
}

export interface LeaseStore {
  get(key: string): LeaseState | undefined;
  set(key: string, value: LeaseState): void | PromiseLike<void>;
}

/** vscode.Memento already has this exact shape for `get`/`update`. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export function mementoLeaseStore(memento: MementoLike, key: string): LeaseStore {
  return {
    get: () => memento.get<LeaseState>(key),
    set: (_key, value) => memento.update(key, value),
  };
}

/**
 * Returns true if `holderId` now holds the lease (either it already did, or the lease was free/
 * expired and this call claimed it) — the caller should perform the real refresh only then.
 * Returns false when a different holder's lease is still active — the caller should skip the
 * network call and rely on the cached/shared snapshot instead.
 */
export function tryAcquireLease(
  store: LeaseStore,
  key: string,
  holderId: string,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  const current = store.get(key);
  if (current && current.expiresAt > now && current.holder !== holderId) return false;
  void store.set(key, { holder: holderId, expiresAt: now + ttlMs });
  return true;
}
