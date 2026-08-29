import { describe, expect, it } from 'vitest';
import { tryAcquireLease, type LeaseState, type LeaseStore } from '../src/providers/RefreshLease';

function memoryLeaseStore(): LeaseStore {
  let state: LeaseState | undefined;
  return {
    get: () => state,
    set: (_key, value) => {
      state = value;
    },
  };
}

describe('tryAcquireLease', () => {
  it('grants the lease when it is free', () => {
    const store = memoryLeaseStore();
    expect(tryAcquireLease(store, 'k', 'window-a', 8_000, 1_000)).toBe(true);
  });

  it('denies a second window while the lease is still held', () => {
    const store = memoryLeaseStore();
    tryAcquireLease(store, 'k', 'window-a', 8_000, 1_000);
    expect(tryAcquireLease(store, 'k', 'window-b', 8_000, 2_000)).toBe(false);
  });

  it('re-grants to the same holder (refreshing the lease) without being blocked by itself', () => {
    const store = memoryLeaseStore();
    tryAcquireLease(store, 'k', 'window-a', 8_000, 1_000);
    expect(tryAcquireLease(store, 'k', 'window-a', 8_000, 2_000)).toBe(true);
  });

  it('grants the lease to a new holder once the previous one expires', () => {
    const store = memoryLeaseStore();
    tryAcquireLease(store, 'k', 'window-a', 8_000, 1_000);
    expect(tryAcquireLease(store, 'k', 'window-b', 8_000, 20_000)).toBe(true);
  });
});
