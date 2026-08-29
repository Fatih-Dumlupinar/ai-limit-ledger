import {
  COPILOT_BILLING_API_VERSION,
  type CopilotUsageResponse,
  type CopilotUsageTransportResult,
} from './types';
import { parseCopilotUsage } from './CopilotUsageParser';

export interface GitHubResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type GitHubFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<GitHubResponse>;

export class GitHubBillingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`GitHub billing request failed with status ${status}`);
    this.name = 'GitHubBillingHttpError';
  }
}

function retryAfter(response: GitHubResponse): number | undefined {
  const value = response.headers?.get('retry-after');
  const seconds = value ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': COPILOT_BILLING_API_VERSION,
  };
}

function usernameFromUserResponse(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const login = (value as { login?: unknown }).login;
  return typeof login === 'string' && /^[A-Za-z0-9-]+$/.test(login) ? login : null;
}

/** Small, injectable HTTP client. The token is never included in errors or diagnostics. */
export class GitHubBillingClient {
  constructor(
    private readonly fetchImpl: GitHubFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCurrentUsage(token: string): Promise<CopilotUsageTransportResult> {
    const userResponse = await this.fetchImpl('https://api.github.com/user', {
      headers: headers(token),
    });
    if (!userResponse.ok) {
      throw new GitHubBillingHttpError(userResponse.status, retryAfter(userResponse));
    }
    const username = usernameFromUserResponse(await userResponse.json());
    if (!username) return { kind: 'unavailable', message: 'GitHub username was not provided.' };
    const date = this.now();
    const url = `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage?year=${date.getUTCFullYear()}&month=${date.getUTCMonth() + 1}`;
    const response = await this.fetchImpl(url, { headers: headers(token) });
    if (response.status === 403) throw new GitHubBillingHttpError(403, retryAfter(response));
    if (response.status === 404) return { kind: 'organization-managed', status: 404 };
    if (!response.ok) throw new GitHubBillingHttpError(response.status, retryAfter(response));
    const sanitized = parseCopilotApiResponse(await response.json());
    return { kind: 'success', usage: parseCopilotUsage(sanitized, date) };
  }
}

/** Only the documented fields are copied. Unknown fields, including any future secrets, vanish. */
export function parseCopilotApiResponse(value: unknown): CopilotUsageResponse {
  const object =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const timePeriod = normalizeTimePeriod(object.timePeriod);
  const items = Array.isArray(object.usageItems) ? object.usageItems : [];
  return {
    timePeriod,
    usageItems: items.map((item) => {
      const source =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
      return {
        product: stringOrNull(source.product),
        sku: stringOrNull(source.sku),
        model: stringOrNull(source.model),
        unitType: stringOrNull(source.unitType),
        grossQuantity: numberOrNull(source.grossQuantity),
        discountQuantity: numberOrNull(source.discountQuantity),
        netQuantity: numberOrNull(source.netQuantity),
        grossAmount: numberOrNull(source.grossAmount),
        netAmount: numberOrNull(source.netAmount),
      };
    }),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTimePeriod(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 80);
  if (typeof value !== 'object' || value === null) return null;
  const year = numberOrNull((value as { year?: unknown }).year);
  const month = numberOrNull((value as { month?: unknown }).month);
  return year !== null && month !== null ? `${year}-${String(month).padStart(2, '0')}` : null;
}
