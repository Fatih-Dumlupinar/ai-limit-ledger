import { clamp } from '../../../limits/RateLimitParser';
import { normalizeToEpochSeconds } from '../../../limits/TimestampNormalizer';

/** Only Anthropic's own account-usage host is ever contacted. No redirect is ever followed. */
export const ALLOWED_HOST = 'api.anthropic.com';
export const USAGE_PATH = '/api/oauth/usage';
export const REQUEST_TIMEOUT_MS = 10_000;
/** Refuses to parse a response larger than this, even if content-length lied. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface UsageWindowResult {
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
}

export interface OAuthUsageSuccess {
  kind: 'ok';
  fiveHour?: UsageWindowResult;
  sevenDay?: UsageWindowResult;
}
export interface OAuthUsageRateLimited {
  kind: 'rate-limited';
  retryAfterSeconds?: number;
}
export interface OAuthUsageAuthRequired {
  kind: 'authentication-required';
}
export interface OAuthUsageFailure {
  kind: 'failure';
  category:
    | 'timeout'
    | 'transport-error'
    | 'protocol-error'
    | 'usage-read-failed'
    | 'response-too-large'
    | 'unexpected-content-type'
    | 'redirect-rejected';
}
export type OAuthUsageResult =
  OAuthUsageSuccess | OAuthUsageRateLimited | OAuthUsageAuthRequired | OAuthUsageFailure;

/** Matches the shape of the global `fetch`, injectable for tests. Never a full HTTP client abstraction. */
export type FetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'manual';
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  redirected?: boolean;
  type?: string;
  text(): Promise<string>;
}>;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const obj = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;

function parseWindow(raw: unknown): UsageWindowResult | undefined {
  const value = obj(raw);
  if (!value) return undefined;
  const used = num(value.used_percentage) ?? num(value.utilization);
  if (used === null) return undefined;
  return {
    usedPercent: clamp(used),
    remainingPercent: clamp(100 - used),
    resetsAt: normalizeToEpochSeconds(value.resets_at ?? value.reset_at, 'unix-seconds'),
  };
}

/**
 * Fetches account-global 5h/7d usage from Anthropic's undocumented `/api/oauth/usage` endpoint —
 * the same endpoint Claude Code's own `/usage` command uses. Only the allowlisted fields below are
 * ever extracted; the raw response body is discarded the instant parsing finishes and is never
 * logged, cached, or surfaced in diagnostics.
 */
export async function fetchClaudeOAuthUsage(
  accessToken: string,
  fetchImpl: FetchLike,
  now: () => number = Date.now,
): Promise<OAuthUsageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(`https://${ALLOWED_HOST}${USAGE_PATH}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return { kind: 'failure', category: 'timeout' };
      return { kind: 'failure', category: 'transport-error' };
    }

    // `redirect: 'manual'` surfaces a redirect as an opaque-redirect response (status 0, type
    // 'opaqueredirect') rather than following it — treated as a hard failure either way.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return { kind: 'failure', category: 'redirect-rejected' };
    }
    if (response.status === 401 || response.status === 403)
      return { kind: 'authentication-required' };
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = header !== null ? Number(header) : undefined;
      return {
        kind: 'rate-limited',
        retryAfterSeconds: seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined,
      };
    }
    if (!response.ok) return { kind: 'failure', category: 'usage-read-failed' };

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return { kind: 'failure', category: 'unexpected-content-type' };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return { kind: 'failure', category: 'transport-error' };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      return { kind: 'failure', category: 'response-too-large' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: 'failure', category: 'protocol-error' };
    }
    const root = obj(parsed);
    const fiveHour = parseWindow(root?.five_hour ?? obj(root?.rate_limits)?.five_hour);
    const sevenDay = parseWindow(root?.seven_day ?? obj(root?.rate_limits)?.seven_day);
    if (!fiveHour && !sevenDay) return { kind: 'failure', category: 'usage-read-failed' };
    void now;
    return { kind: 'ok', fiveHour, sevenDay };
  } finally {
    clearTimeout(timer);
  }
}
