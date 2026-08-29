import { describe, expect, it, vi } from 'vitest';
import {
  fetchCopilotEntitlement,
  parseCopilotEntitlement,
  COPILOT_ENTITLEMENT_HOST,
  COPILOT_ENTITLEMENT_PATH,
  type FetchLike,
} from '../src/providers/copilot/experimental/CopilotEntitlementTransport';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const merged = { 'content-type': 'application/json', ...headers };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => merged[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

describe('parseCopilotEntitlement allowlist', () => {
  it('extracts only the documented fields and drops everything else', () => {
    const summary = parseCopilotEntitlement({
      copilot_plan: 'business',
      access_type_sku: 'copilot_enterprise',
      token_based_billing: true,
      quota_reset_date: '2026-09-01',
      secret_internal_field: 'must not survive',
      quota_snapshots: {
        premium_interactions: {
          credits_used: 31,
          entitlement: 0,
          remaining: 0,
          percent_remaining: 0,
          unlimited: true,
          overage_permitted: false,
          irrelevant: 'dropped',
        },
      },
    });
    expect(summary.copilotPlan).toBe('business');
    expect(summary.tokenBasedBilling).toBe(true);
    expect(summary.premiumInteractions?.creditsUsed).toBe(31);
    expect(summary.premiumInteractions?.unlimited).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('must not survive');
    expect(JSON.stringify(summary)).not.toContain('dropped');
  });

  it('returns null quota snapshots when absent', () => {
    const summary = parseCopilotEntitlement({});
    expect(summary.premiumInteractions).toBeNull();
    expect(summary.chat).toBeNull();
    expect(summary.completions).toBeNull();
  });
});

describe('fetchCopilotEntitlement', () => {
  it('requests only the documented host and path', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(200, { quota_snapshots: { premium_interactions: { credits_used: 5 } } }),
    );
    await fetchCopilotEntitlement('token-value', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://${COPILOT_ENTITLEMENT_HOST}${COPILOT_ENTITLEMENT_PATH}`,
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('succeeds on a well-formed response', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { quota_snapshots: { premium_interactions: { credits_used: 31 } } });
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.summary.premiumInteractions?.creditsUsed).toBe(31);
  });

  it('maps 401/403 to authentication-required', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, {});
    expect((await fetchCopilotEntitlement('token', fetchImpl)).kind).toBe(
      'authentication-required',
    );
  });

  it('maps 429 to rate-limited and reads retry-after', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(429, {}, { 'retry-after': '30' });
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result.kind).toBe('rate-limited');
    if (result.kind === 'rate-limited') expect(result.retryAfterSeconds).toBe(30);
  });

  it('maps 5xx to upstream-unavailable', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(503, {});
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'upstream-unavailable' });
  });

  it('rejects a redirect instead of following it', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 0,
      ok: false,
      type: 'opaqueredirect',
      headers: { get: () => null },
      text: async () => '',
    });
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'redirect-rejected' });
  });

  it('rejects a non-JSON content type', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
      text: async () => '<html></html>',
    });
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'unexpected-content-type' });
  });

  it('rejects an oversized response', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
    });
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'response-too-large' });
  });

  it('rejects malformed JSON', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => '{not json',
    });
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'protocol-error' });
  });

  it('treats a response with no recognizable quota snapshot as a failure', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { copilot_plan: 'business' });
    const result = await fetchCopilotEntitlement('token', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'usage-read-failed' });
  });

  it('never includes the token in the returned result', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { quota_snapshots: { premium_interactions: { credits_used: 5 } } });
    const result = await fetchCopilotEntitlement('super-secret-token', fetchImpl);
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });
});
