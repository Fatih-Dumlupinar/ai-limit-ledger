import { describe, expect, it } from 'vitest';
import {
  isBackoffActive,
  recordRateLimited,
  recordSuccess,
  type BackoffState,
  type BackoffStore,
} from '../src/providers/claude/oauth/ClaudeOAuthBackoff';

function memoryBackoffStore(): BackoffStore {
  let state: BackoffState | undefined;
  return {
    get: () => state,
    set: (_key, value) => {
      state = value;
    },
  };
}

const MIN = 60_000;

describe('ClaudeOAuthBackoff', () => {
  it('honors an explicit Retry-After exactly for the first 429', () => {
    const store = memoryBackoffStore();
    const state = recordRateLimited(store, 'k', 37, 0);
    expect(state.retryAt).toBe(37_000);
  });

  it('falls back to the 2/4/8 minute sequence when no Retry-After is present', () => {
    const store = memoryBackoffStore();
    const first = recordRateLimited(store, 'k', undefined, 0);
    expect(first.retryAt).toBe(2 * MIN);
    const second = recordRateLimited(store, 'k', undefined, 2 * MIN);
    expect(second.retryAt).toBe(2 * MIN + 4 * MIN);
    const third = recordRateLimited(store, 'k', undefined, 6 * MIN);
    // Third consecutive 429: the sequence value (8min) already meets the 15-minute floor? No —
    // the floor must still win when the sequence value is smaller than 15 minutes.
    expect(third.retryAt - 6 * MIN).toBe(15 * MIN);
  });

  it('enforces at least a 15-minute pause after three consecutive 429s even if Retry-After is smaller', () => {
    const store = memoryBackoffStore();
    recordRateLimited(store, 'k', 5, 0);
    recordRateLimited(store, 'k', 5, 10_000);
    const third = recordRateLimited(store, 'k', 5, 20_000);
    expect(third.retryAt - 20_000).toBe(15 * MIN);
  });

  it('never exceeds a 60-minute maximum backoff even after many consecutive 429s', () => {
    const store = memoryBackoffStore();
    let now = 0;
    for (let i = 0; i < 10; i += 1) {
      const attempt = recordRateLimited(store, 'k', undefined, now);
      expect(attempt.retryAt - now).toBeLessThanOrEqual(60 * MIN);
      now = attempt.retryAt;
    }
  });

  it('resets the consecutive-failure counter on success', () => {
    const store = memoryBackoffStore();
    recordRateLimited(store, 'k', undefined, 0);
    recordRateLimited(store, 'k', undefined, 2 * MIN);
    recordSuccess(store, 'k');
    expect(isBackoffActive(store, 'k', 2 * MIN + 1)).toBe(false);
    const next = recordRateLimited(store, 'k', undefined, 3 * MIN);
    // Back to the first step of the sequence, not continuing from where it left off.
    expect(next.retryAt - 3 * MIN).toBe(2 * MIN);
  });

  it('reports backoff as active only while retryAt is in the future', () => {
    const store = memoryBackoffStore();
    recordRateLimited(store, 'k', 60, 0);
    expect(isBackoffActive(store, 'k', 30_000)).toBe(true);
    expect(isBackoffActive(store, 'k', 60_001)).toBe(false);
  });
});
