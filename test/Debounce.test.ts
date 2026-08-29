import { describe, expect, it, vi } from 'vitest';
import { debounce } from '../src/extension';

describe('debounce', () => {
  it('coalesces a burst of fires into a single call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.fire();
    d.fire();
    d.fire();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    d.dispose();
    vi.useRealTimers();
  });

  it('dispose cancels a pending call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.fire();
    d.dispose();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
