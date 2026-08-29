export const COPILOT_BACKOFF_MS = [120_000, 240_000, 480_000] as const;
export const COPILOT_MAX_BACKOFF_MS = 3_600_000;

export function copilotBackoffMs(consecutive429s: number, retryAfterSeconds?: number): number {
  const retryAfterMs =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds * 1000)
      : 0;
  const exponential =
    consecutive429s >= 3
      ? 900_000
      : (COPILOT_BACKOFF_MS[
          Math.max(0, Math.min(COPILOT_BACKOFF_MS.length - 1, consecutive429s - 1))
        ] ?? 120_000);
  return Math.min(COPILOT_MAX_BACKOFF_MS, Math.max(exponential, retryAfterMs));
}
