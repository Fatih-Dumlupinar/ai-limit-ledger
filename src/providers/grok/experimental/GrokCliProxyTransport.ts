import { URL } from 'node:url';
import type { ProviderCredits } from '../../types';
import type { GrokBillingSummary, GrokUsageWindow } from '../types';

/**
 * Experimental, opt-in fallback used only when the Grok ACP `x.ai/billing` method is unavailable
 * (`method-not-supported`). Contacts the CLI's own chat-proxy billing service directly over HTTPS.
 * Never issues a model/chat request — GET only, two fixed paths, fixed host.
 */
export const GROK_PROXY_HOST = 'cli-chat-proxy.grok.com';
export const GROK_PROXY_BILLING_PATH = '/v1/billing?format=credits';
export const GROK_PROXY_SETTINGS_PATH = '/v1/settings';
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export type GrokProxyResult =
  | { kind: 'ok'; summary: GrokBillingSummary }
  | { kind: 'free-plan'; summary: GrokBillingSummary }
  | { kind: 'billing-not-exposed' }
  | { kind: 'incompatible-response' }
  | { kind: 'authentication-required' }
  | { kind: 'billing-not-available' }
  | { kind: 'billing-endpoint-unavailable' }
  | { kind: 'rate-limited'; retryAfterSeconds?: number }
  | {
      kind: 'failure';
      category:
        | 'timeout'
        | 'transport-error'
        | 'protocol-error'
        | 'usage-read-failed'
        | 'response-too-large'
        | 'unexpected-content-type'
        | 'redirect-rejected'
        | 'wrong-host'
        | 'upstream-unavailable';
    };

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
const numField = (x: unknown): number | null => {
  const value = obj(x);
  return value ? num(value.val) : null;
};

/** Only the fields below are ever extracted. Everything else in the response is discarded. */
export function parseGrokProxyBilling(
  value: unknown,
  planDisplay?: string | null,
): GrokBillingSummary {
  const root = obj(value) ?? {};
  const config = obj(root.config) ?? {};
  const usage = obj(root.usage) ?? {};
  const period = obj(config.currentPeriod);

  const periodStart = str(period?.start);
  const periodEnd = str(period?.end ?? config.billingPeriodEnd);
  const monthlyLimit = numField(root.monthlyLimit);
  const includedUsed = numField(usage.includedUsed);
  const onDemandUsed = numField(usage.onDemandUsed);
  const totalUsed = numField(usage.totalUsed);
  const onDemandCap = numField(root.onDemandCap);
  const onDemandEnabled = bool(root.on_demand_enabled);
  const subscriptionTier = str(root.subscription_tier);

  let percent = num(config.creditUsagePercent);
  if (percent !== null && (percent < 0 || percent > 100)) percent = null;
  if (percent === null && monthlyLimit !== null && monthlyLimit > 0 && totalUsed !== null) {
    percent = (totalUsed / monthlyLimit) * 100;
  }

  const windows: GrokUsageWindow[] = [];
  if (percent !== null) {
    windows.push({
      id: 'grok-current-period',
      label:
        periodStart || periodEnd
          ? `Current period (${periodStart ?? 'Not provided'} – ${periodEnd ?? 'Not provided'})`
          : 'Current period',
      usedPercent: clampPercent(percent),
      remainingPercent: clampPercent(100 - percent),
      resetsAt: parseTimestamp(periodEnd),
    });
  }

  const used = totalUsed ?? includedUsed;
  const credits: ProviderCredits = {
    used,
    allowance: monthlyLimit,
    remaining: monthlyLimit !== null && used !== null ? Math.max(monthlyLimit - used, 0) : null,
    additional: onDemandUsed,
    included: monthlyLimit,
  };

  return {
    plan: planDisplay ?? subscriptionTier,
    currentPeriod:
      periodStart || periodEnd
        ? `${periodStart ?? 'Not provided'} → ${periodEnd ?? 'Not provided'}`
        : null,
    usageWindows: windows,
    productBreakdown: null,
    buildUsage: null,
    onDemandEnabled,
    extraCreditBalance: onDemandCap,
    credits,
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * The only headers ever sent to the CLI-proxy billing service. Never includes `refresh_token`,
 * email, or any other field from the auth file — only the bearer `key` and `user_id` extracted by
 * `readGrokAuthToken`, plus fixed, non-sensitive client-identification values.
 */
export function grokProxyBillingHeaders(
  token: string,
  userId: string,
  cliVersion: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-userid': userId,
    Accept: 'application/json',
  };
  if (cliVersion) headers['x-grok-client-version'] = cliVersion;
  return headers;
}

type GetJsonResult = { kind: 'json-ok'; body: unknown } | GrokProxyResult;

async function getJson(
  path: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<GetJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://${GROK_PROXY_HOST}${path}`;
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname !== GROK_PROXY_HOST || parsedUrl.protocol !== 'https:') {
      return { kind: 'failure', category: 'wrong-host' };
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
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
    if (response.status === 401) return { kind: 'authentication-required' };
    if (response.status === 403) return { kind: 'billing-not-available' };
    if (response.status === 404) return { kind: 'billing-endpoint-unavailable' };
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
    try {
      return { kind: 'json-ok', body: JSON.parse(text) };
    } catch {
      return { kind: 'failure', category: 'protocol-error' };
    }
  } finally {
    clearTimeout(timer);
  }
}

const FREE_PLAN_VALUES = new Set(['free']);

function isFreePlanValue(value: string | null): boolean {
  return value !== null && FREE_PLAN_VALUES.has(value.toLowerCase());
}

/**
 * Classifies a successfully-fetched billing body. `config` absent (null/undefined) with valid
 * auth means the account's billing configuration is not exposed by this experimental endpoint —
 * distinct from an explicit, safely-reported free plan, which is shown as such rather than as an
 * error.
 */
function classifyBillingBody(body: unknown, planDisplay: string | null): GrokProxyResult {
  const root = obj(body);
  if (!root) return { kind: 'incompatible-response' };
  const config = obj(root.config);
  const planValue = planDisplay ?? str(root.subscription_tier);
  if (root.config === null || root.config === undefined || !config) {
    if (isFreePlanValue(planValue)) {
      return { kind: 'free-plan', summary: parseGrokProxyBilling(body, planValue) };
    }
    return { kind: 'billing-not-exposed' };
  }
  return { kind: 'ok', summary: parseGrokProxyBilling(body, planDisplay) };
}

/**
 * Token/user id are used only for the duration of these two GETs and are never stored by this
 * function. `cliVersion` is the locally-detected Grok CLI version, sent as a fixed
 * client-identification header only.
 */
export async function fetchGrokProxyBilling(
  token: string,
  userId: string,
  cliVersion: string | null,
  fetchImpl: FetchLike,
): Promise<GrokProxyResult> {
  const headers = grokProxyBillingHeaders(token, userId, cliVersion);
  const billing = await getJson(GROK_PROXY_BILLING_PATH, headers, fetchImpl);
  if (billing.kind !== 'json-ok') return billing;

  let planDisplay: string | null = null;
  const settings = await getJson(GROK_PROXY_SETTINGS_PATH, headers, fetchImpl);
  if (settings.kind === 'json-ok') {
    const root = obj(settings.body);
    planDisplay = str(root?.subscription_tier_display) ?? null;
  }

  return classifyBillingBody(billing.body, planDisplay);
}
