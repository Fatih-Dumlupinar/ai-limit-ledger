import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchClaudeOAuthUsage,
  MAX_RESPONSE_BYTES,
  type FetchLike,
} from '../src/providers/claude/oauth/ClaudeOAuthUsageTransport';

function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
  type: string = 'basic',
): Awaited<ReturnType<FetchLike>> {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    type,
    text: async () => body,
  };
}

describe('fetchClaudeOAuthUsage', () => {
  it('parses the allowlisted five-hour/seven-day fields from a well-formed response', async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse(
        200,
        JSON.stringify({
          five_hour: { used_percentage: 42, resets_at: 1_800_000_000 },
          seven_day: { used_percentage: 12, resets_at: 1_800_500_000 },
          account_id: 'must-not-leak',
        }),
        { 'content-type': 'application/json' },
      );
    const result = await fetchClaudeOAuthUsage('fixture-token', fetchImpl);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.fiveHour?.usedPercent).toBe(42);
    expect(result.sevenDay?.usedPercent).toBe(12);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('only ever contacts api.anthropic.com/api/oauth/usage over https', async () => {
    let requestedUrl = '';
    const fetchImpl: FetchLike = async (url) => {
      requestedUrl = url;
      return fakeResponse(200, JSON.stringify({ five_hour: { used_percentage: 1 } }), {
        'content-type': 'application/json',
      });
    };
    await fetchClaudeOAuthUsage('t', fetchImpl);
    expect(requestedUrl).toBe('https://api.anthropic.com/api/oauth/usage');
  });

  it('never follows a redirect', async () => {
    const fetchImpl: FetchLike = async () => fakeResponse(0, '', {}, 'opaqueredirect');
    const result = await fetchClaudeOAuthUsage('t', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'redirect-rejected' });
  });

  it('reports authentication-required on 401', async () => {
    const fetchImpl: FetchLike = async () => fakeResponse(401, '');
    const result = await fetchClaudeOAuthUsage('t', fetchImpl);
    expect(result).toEqual({ kind: 'authentication-required' });
  });

  it('reports rate-limited with the parsed Retry-After header on 429', async () => {
    const fetchImpl: FetchLike = async () => fakeResponse(429, '', { 'retry-after': '90' });
    const result = await fetchClaudeOAuthUsage('t', fetchImpl);
    expect(result).toEqual({ kind: 'rate-limited', retryAfterSeconds: 90 });
  });

  it('rejects a response larger than the safe size limit', async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse(200, 'x'.repeat(MAX_RESPONSE_BYTES + 1), { 'content-type': 'application/json' });
    const result = await fetchClaudeOAuthUsage('t', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'response-too-large' });
  });

  it('rejects an unexpected content type rather than guessing at HTML/text', async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse(200, '<html>not json</html>', { 'content-type': 'text/html' });
    const result = await fetchClaudeOAuthUsage('t', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'unexpected-content-type' });
  });

  it('applies a 10-second timeout and reports it as a timeout failure', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      const pending = fetchClaudeOAuthUsage('t', fetchImpl);
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await pending;
      expect(result).toEqual({ kind: 'failure', category: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats an out-of-range/invalid percentage as a read failure rather than a fabricated value', async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse(200, JSON.stringify({ five_hour: {}, seven_day: {} }), {
        'content-type': 'application/json',
      });
    const result = await fetchClaudeOAuthUsage('t', fetchImpl);
    expect(result).toEqual({ kind: 'failure', category: 'usage-read-failed' });
  });
});
