export const GROK_MAX_BACKOFF_MS = 3_600_000;

export function grokBackoffMs(consecutiveFailures: number, retryAfterSeconds?: number): number {
  const retryAfter =
    typeof retryAfterSeconds === 'number' && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : 0;
  const exponential = Math.min(
    GROK_MAX_BACKOFF_MS,
    120_000 * 2 ** Math.max(0, consecutiveFailures - 1),
  );
  return Math.min(GROK_MAX_BACKOFF_MS, Math.max(exponential, retryAfter));
}
