/**
 * Experimental, opt-in transport for GitHub's undocumented `copilot_internal/user` entitlement
 * endpoint. Used only when the user has explicitly enabled "Experimental Copilot Usage" — see
 * `CopilotProvider.enableExperimentalUsage`. Only the allowlisted fields below are ever read out
 * of the response; the raw body is discarded the instant parsing finishes.
 */
export const COPILOT_ENTITLEMENT_HOST = 'api.github.com';
export const COPILOT_ENTITLEMENT_PATH = '/copilot_internal/user';
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface CopilotQuotaSnapshot {
  creditsUsed: number | null;
  entitlement: number | null;
  remaining: number | null;
  percentRemaining: number | null;
  unlimited: boolean | null;
  overagePermitted: boolean | null;
}

export interface CopilotEntitlementSummary {
  copilotPlan: string | null;
  accessTypeSku: string | null;
  tokenBasedBilling: boolean | null;
  quotaResetDate: string | null;
  premiumInteractions: CopilotQuotaSnapshot | null;
  chat: CopilotQuotaSnapshot | null;
  completions: CopilotQuotaSnapshot | null;
}

export interface EntitlementSuccess {
  kind: 'ok';
  summary: CopilotEntitlementSummary;
}
export interface EntitlementAuthRequired {
  kind: 'authentication-required';
}
export interface EntitlementRateLimited {
  kind: 'rate-limited';
  retryAfterSeconds?: number;
}
export interface EntitlementFailure {
  kind: 'failure';
  category:
    | 'timeout'
    | 'transport-error'
    | 'protocol-error'
    | 'usage-read-failed'
    | 'response-too-large'
    | 'unexpected-content-type'
    | 'redirect-rejected'
    | 'upstream-unavailable';
}
export type EntitlementResult =
  EntitlementSuccess | EntitlementAuthRequired | EntitlementRateLimited | EntitlementFailure;

/** Matches the shape of the global `fetch`, injectable for tests. */
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

const num = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const str = (x: unknown): string | null => (typeof x === 'string' && x.length <= 160 ? x : null);
const bool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
const obj = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;

function parseQuota(raw: unknown): CopilotQuotaSnapshot | null {
  const value = obj(raw);
  if (!value) return null;
  return {
    creditsUsed: num(value.credits_used),
    entitlement: num(value.entitlement),
    remaining: num(value.remaining),
    percentRemaining:
      num(value.percent_remaining) !== null && num(value.percent_remaining)! <= 100
        ? num(value.percent_remaining)
        : null,
    unlimited: bool(value.unlimited),
    overagePermitted: bool(value.overage_permitted),
  };
}

/** Only the documented-below allowlist survives; every other field is dropped immediately. */
export function parseCopilotEntitlement(value: unknown): CopilotEntitlementSummary {
  const root = obj(value) ?? {};
  const snapshots = obj(root.quota_snapshots);
  return {
    copilotPlan: str(root.copilot_plan),
    accessTypeSku: str(root.access_type_sku),
    tokenBasedBilling: bool(root.token_based_billing),
    quotaResetDate: str(root.quota_reset_date),
    premiumInteractions: parseQuota(snapshots?.premium_interactions),
    chat: parseQuota(snapshots?.chat),
    completions: parseQuota(snapshots?.completions),
  };
}

/**
 * Fetches Copilot's undocumented per-user entitlement snapshot. Contacts only
 * `https://api.github.com/copilot_internal/user` (or an explicitly configured GitHub Enterprise
 * API host, never inferred). Redirects are rejected, responses over 64KB are refused, and the
 * token is never logged or included in the returned result.
 */
export async function fetchCopilotEntitlement(
  accessToken: string,
  fetchImpl: FetchLike,
  allowedHost: string = COPILOT_ENTITLEMENT_HOST,
): Promise<EntitlementResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(`https://${allowedHost}${COPILOT_ENTITLEMENT_PATH}`, {
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
    if (response.status >= 500) return { kind: 'failure', category: 'upstream-unavailable' };
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
    const summary = parseCopilotEntitlement(parsed);
    if (!summary.premiumInteractions && !summary.chat && !summary.completions) {
      return { kind: 'failure', category: 'usage-read-failed' };
    }
    return { kind: 'ok', summary };
  } finally {
    clearTimeout(timer);
  }
}
