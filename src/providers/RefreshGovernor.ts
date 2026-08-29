/** A refresh was skipped purely because it arrived before the minimum interval/backoff elapsed — never a real failure. */
export class ThrottledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThrottledError';
  }
}

export class RefreshGovernor {
  private running?: Promise<unknown>;
  private last = 0;
  private failures = 0;
  private retryAt = 0;
  private retryIsRateLimited = false;
  constructor(private minimumIntervalMs: number) {}
  /** Applied live from a settings change; does not affect a currently in-flight request. */
  setMinimumIntervalMs(ms: number): void {
    this.minimumIntervalMs = ms;
  }
  async run<T>(work: () => Promise<T>, force = false): Promise<T> {
    if (this.running) return this.running as Promise<T>;
    const now = Date.now();
    // A manual refresh may skip the ordinary freshness interval, but it must never skip a
    // provider backoff established after a transient/429 failure.
    if (
      (!force && now - this.last < this.minimumIntervalMs) ||
      (now < this.retryAt && (this.retryIsRateLimited || !force))
    )
      throw new ThrottledError(
        `Refresh available in ${Math.ceil((Math.max(this.last + this.minimumIntervalMs, this.retryAt) - now) / 1000)}s.`,
      );
    this.running = work()
      .then((v) => {
        this.last = Date.now();
        this.failures = 0;
        this.retryAt = 0;
        this.retryIsRateLimited = false;
        return v;
      })
      .catch((e: unknown) => {
        this.failures++;
        const retry = /retry-after\s*[:=]?\s*(\d+)/i.exec(String(e));
        this.retryIsRateLimited = Boolean(retry) || /\b429\b|rate.?limit/i.test(String(e));
        const ms = retry
          ? Number(retry[1]) * 1000
          : Math.min(300000, 1000 * 2 ** this.failures + Math.random() * 1000);
        this.retryAt = Date.now() + ms;
        throw e;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running as Promise<T>;
  }
  get nextRetryAt(): number {
    return this.retryAt;
  }
  get isRunning(): boolean {
    return this.running !== undefined;
  }
  get consecutiveFailures(): number {
    return this.failures;
  }
  get lastSuccessAt(): number {
    return this.last;
  }
}
