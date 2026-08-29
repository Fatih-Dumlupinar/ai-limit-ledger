import { clamp } from '../limits/RateLimitParser';
import { normalizeToEpochSeconds } from '../limits/TimestampNormalizer';
import type { ProviderSnapshot, UsageWindow } from './types';
import { buildClaudeUsageInsights, isSafeMetricNumber } from './UsageInsights';

const MAX_INPUT_BYTES = 256 * 1024;
type Json = Record<string, unknown>;
const obj = (x: unknown): Json | undefined =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Json) : undefined;
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const bool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
function window(id: string, label: string, raw: unknown, minutes: number): UsageWindow | undefined {
  const value = obj(raw);
  const used = num(value?.used_percentage);
  if (used === null || used < 0 || used > 100) return undefined;
  // The documented contract states resets_at is unix seconds. An implausible value normalizes
  // to null ("Not available") rather than a 1970 date.
  return {
    id,
    label,
    usedPercent: clamp(used),
    remainingPercent: clamp(100 - used),
    resetsAt: normalizeToEpochSeconds(value?.resets_at, 'unix-seconds'),
    windowDurationMinutes: minutes,
  };
}
/** Parses only the public Claude Code status-line contract; credentials and session identifiers are discarded. */
export function parseClaudeStatusLine(input: string, now = Date.now()): ProviderSnapshot {
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES)
    throw new Error('Claude status-line input exceeds the safe size limit.');
  let root: Json;
  try {
    root = obj(JSON.parse(input)) ?? {};
  } catch {
    throw new Error('Claude status-line JSON is invalid.');
  }
  const limits = obj(root.rate_limits);
  const windows = [
    window('five-hour', '5h', limits?.five_hour, 300),
    window('seven-day', '7d', limits?.seven_day, 10080),
  ].filter((x): x is UsageWindow => Boolean(x));
  const context = obj(root.context_window);
  const cost = obj(root.cost);
  const model = obj(root.model);
  const effort = obj(root.effort);
  const thinking = obj(root.thinking);
  // The wrapper stamps its own write time (`observedAt`, ISO-8601) each time it runs — the real
  // source-event time, distinct from `now` (when AI Limit Ledger happened to read/parse the file).
  const sourceUpdatedAt = typeof root.observedAt === 'string' ? Date.parse(root.observedAt) : NaN;
  const snapshot: ProviderSnapshot = {
    providerId: 'claude',
    providerName: 'Claude Code',
    availability: windows.length ? 'ready' : 'waiting-for-first-response',
    connected: windows.length > 0,
    plan: null,
    cliVersion: str(root.version),
    usageWindows: windows,
    source: 'Official Claude Code status-line',
    observedAt: now,
    sourceUpdatedAt: Number.isNaN(sourceUpdatedAt) ? null : sourceUpdatedAt,
    lastProviderEventAt: Number.isNaN(sourceUpdatedAt) ? null : sourceUpdatedAt,
    stale: false,
    warning: windows.length
      ? undefined
      : 'Waiting for the first completed Claude CLI response containing rate-limit data.',
    capabilities: { rateLimits: true, usage: true, statusLine: true },
    tokens: {
      contextUsedPercent: safePercent(context?.used_percentage),
      contextRemainingPercent: safePercent(context?.remaining_percentage),
      contextWindowSize: safeMetric(context?.context_window_size),
      totalInputTokens: safeMetric(
        obj(context?.current_usage)?.input_tokens ?? context?.total_input_tokens,
      ),
      totalOutputTokens: safeMetric(
        obj(context?.current_usage)?.output_tokens ?? context?.total_output_tokens,
      ),
      cacheCreationInputTokens: safeMetric(
        obj(context?.current_usage)?.cache_creation_input_tokens,
      ),
      cacheReadInputTokens: safeMetric(obj(context?.current_usage)?.cache_read_input_tokens),
      totalCostUsd: safeMetric(cost?.total_cost_usd),
      totalDurationMs: safeMetric(cost?.total_duration_ms),
      totalApiDurationMs: safeMetric(cost?.total_api_duration_ms),
      totalLinesAdded: safeMetric(cost?.total_lines_added),
      totalLinesRemoved: safeMetric(cost?.total_lines_removed),
    },
    metadata: {
      modelId: str(model?.id),
      modelName: str(model?.display_name),
      fastMode: bool(root.fast_mode),
      effort: str(effort?.level),
      thinking: bool(thinking?.enabled),
      exceeds200kTokens: bool(root.exceeds_200k_tokens),
      outputStyle: str(obj(root.output_style)?.name),
      schemaVersion: schemaVersion(root.schemaVersion),
    },
  };
  snapshot.usageInsights = buildClaudeUsageInsights(snapshot);
  return snapshot;
}
export { MAX_INPUT_BYTES };

function safeMetric(value: unknown): number | null {
  return isSafeMetricNumber(value) ? value : null;
}

function safePercent(value: unknown): number | null {
  const metric = safeMetric(value);
  return metric !== null && metric <= 100 ? metric : null;
}

function schemaVersion(value: unknown): number {
  return value === 2 ? 2 : 1;
}
