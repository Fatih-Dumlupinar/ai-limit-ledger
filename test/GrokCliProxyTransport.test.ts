import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchGrokProxyBilling,
  parseGrokProxyBilling,
  grokProxyBillingHeaders,
  GROK_PROXY_HOST,
  type FetchLike,
} from '../src/providers/grok/experimental/GrokCliProxyTransport';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const merged = { 'content-type': 'application/json', ...headers };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => merged[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

describe('parseGrokProxyBilling', () => {
  it('parses a direct percentage when provided', () => {
    const summary = parseGrokProxyBilling({
      config: { creditUsagePercent: 24, currentPeriod: { start: '2026-08-01', end: '2026-09-01' } },
      monthlyLimit: { val: 1000 },
      usage: { totalUsed: { val: 240 } },
    });
    expect(summary.usageWindows[0].usedPercent).toBe(24);
    expect(summary.usageWindows[0].remainingPercent).toBe(76);
  });

  it('falls back to totalUsed/monthlyLimit when no percent field is present', () => {
    const summary = parseGrokProxyBilling({
      monthlyLimit: { val: 200 },
      usage: { totalUsed: { val: 50 } },
    });
    expect(summary.usageWindows[0].usedPercent).toBe(25);
  });

  it('produces no usage window when neither a percent nor a computable ratio exists', () => {
    const summary = parseGrokProxyBilling({});
    expect(summary.usageWindows).toEqual([]);
  });

  it('parses the reset date from the period end', () => {
    const summary = parseGrokProxyBilling({
      config: { creditUsagePercent: 10, currentPeriod: { end: '2026-09-01T00:00:00Z' } },
    });
    expect(summary.usageWindows[0].resetsAt).toBe(
      Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000),
    );
  });

  it('accepts an externally supplied plan display over subscription_tier', () => {
    const summary = parseGrokProxyBilling({ subscription_tier: 'super-grok' }, 'SuperGrok');
    expect(summary.plan).toBe('SuperGrok');
  });
});

describe('grokProxyBillingHeaders', () => {
  it('sends exactly the required, safe headers', () => {
    const headers = grokProxyBillingHeaders('tok', 'user-1', '0.2.117');
    expect(headers).toEqual({
      Authorization: 'Bearer tok',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-userid': 'user-1',
      Accept: 'application/json',
      'x-grok-client-version': '0.2.117',
    });
  });

  it('omits the client-version header when the CLI version is unknown', () => {
    const headers = grokProxyBillingHeaders('tok', 'user-1', null);
    expect(headers['x-grok-client-version']).toBeUndefined();
  });
});

describe('fetchGrokProxyBilling', () => {
  it('only ever contacts cli-chat-proxy.grok.com', async () => {
    const calledUrls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url) => {
      calledUrls.push(url);
      return jsonResponse(200, { config: { creditUsagePercent: 10 } });
    });
    await fetchGrokProxyBilling('token', 'user-1', '0.2.117', fetchImpl);
    for (const url of calledUrls) expect(new URL(url).hostname).toBe(GROK_PROXY_HOST);
  });

  it('never issues more than the billing + settings GETs (no chat/model request)', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { config: {} }));
    await fetchGrokProxyBilling('token', 'user-1', '0.2.117', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of (fetchImpl as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1].method).toBe('GET');
    }
  });

  it('sends the required billing headers, including x-userid and x-grok-client-version', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { config: {} }));
    await fetchGrokProxyBilling('secret-token', 'user-42', '0.2.117', fetchImpl);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).toEqual({
      Authorization: 'Bearer secret-token',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-userid': 'user-42',
      Accept: 'application/json',
      'x-grok-client-version': '0.2.117',
    });
  });

  it('maps 401 to authentication-required', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, {});
    expect((await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).kind).toBe(
      'authentication-required',
    );
  });

  it('maps 403 to billing-not-available', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(403, {});
    expect((await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).kind).toBe(
      'billing-not-available',
    );
  });

  it('maps 404 to billing-endpoint-unavailable', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(404, {});
    expect((await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).kind).toBe(
      'billing-endpoint-unavailable',
    );
  });

  it('maps 429 to rate-limited', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(429, {}, { 'retry-after': '60' });
    const result = await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl);
    expect(result.kind).toBe('rate-limited');
  });

  it('maps 5xx to upstream-unavailable', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(500, {});
    expect(await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).toEqual({
      kind: 'failure',
      category: 'upstream-unavailable',
    });
  });

  it('maps a config-null (billing config not exposed) body to billing-not-exposed', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { config: null });
    expect((await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).kind).toBe(
      'billing-not-exposed',
    );
  });

  it('classifies an explicit free-plan body as free-plan, not an error', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { config: null, subscription_tier: 'free' });
    const result = await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl);
    expect(result.kind).toBe('free-plan');
    if (result.kind === 'free-plan') expect(result.summary.plan).toBe('free');
  });

  it('maps a schema-incompatible body to incompatible-response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, 'not-an-object');
    expect((await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).kind).toBe(
      'incompatible-response',
    );
  });

  it('rejects a redirect instead of following it', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 0,
      ok: false,
      type: 'opaqueredirect',
      headers: { get: () => null },
      text: async () => '',
    });
    expect(await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).toEqual({
      kind: 'failure',
      category: 'redirect-rejected',
    });
  });

  it('rejects an oversized response', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
    });
    expect(await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl)).toEqual({
      kind: 'failure',
      category: 'response-too-large',
    });
  });

  it('maps an aborted request to a timeout failure', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init.signal.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    const result = await fetchGrokProxyBilling('token', 'user-1', null, fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'timeout' });
  });

  it('never includes the token or user id in the returned result', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { config: { creditUsagePercent: 5 } });
    const result = await fetchGrokProxyBilling(
      'super-secret-grok-token',
      'super-secret-user-id',
      null,
      fetchImpl,
    );
    expect(JSON.stringify(result)).not.toContain('super-secret-grok-token');
    expect(JSON.stringify(result)).not.toContain('super-secret-user-id');
  });
});
