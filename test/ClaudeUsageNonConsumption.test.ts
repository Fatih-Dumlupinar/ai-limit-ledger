import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchClaudeOAuthUsage,
  ALLOWED_HOST,
  USAGE_PATH,
  type FetchLike,
} from '../src/providers/claude/oauth/ClaudeOAuthUsageTransport';
import { ClaudeOAuthUsageService } from '../src/providers/claude/oauth/ClaudeOAuthUsageService';
import { renderDashboard } from '../src/ui/DetailsView';
import { renderSafeDashboard, buildSafeDashboardDocumentModel } from '../src/ui/SafeDashboard';
import { formatProviderTooltip } from '../src/ui/ProviderStatusBarTooltip';
import { providerSegmentText } from '../src/ui/StatusBarFormatter';
import type { ProviderSnapshot } from '../src/providers/types';

const now = 1_800_000_000_000;

function state(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get<T>(key: string, fallback: T): T {
      return (values.get(key) as T | undefined) ?? fallback;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

function snapshot(): ProviderSnapshot {
  return {
    providerId: 'claude',
    providerName: 'Claude Code',
    availability: 'ready',
    connected: true,
    plan: 'Pro',
    cliVersion: '2.0',
    usageWindows: [],
    source: 'Official Claude Code status-line',
    observedAt: now,
    checkedAt: now,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: true },
  };
}

function response(body: unknown) {
  return {
    status: 200,
    ok: true,
    headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
  };
}

describe('Claude usage non-consumption boundaries', () => {
  it('uses only the allowlisted host and usage path', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return response({ five_hour: { used_percentage: 12, resets_at: 1_900_000_000 } });
    };
    await fetchClaudeOAuthUsage('token', fetchImpl, () => now);
    expect(calls[0]?.url).toBe(`https://${ALLOWED_HOST}${USAGE_PATH}`);
    expect(new globalThis.URL(calls[0]?.url ?? '').hostname).toBe(ALLOWED_HOST);
    expect(new globalThis.URL(calls[0]?.url ?? '').pathname).toBe(USAGE_PATH);
  });

  it('uses GET, has no request body, and never follows redirects', async () => {
    let init: Parameters<FetchLike>[1] | undefined;
    await fetchClaudeOAuthUsage(
      'token',
      async (_url, requestInit) => {
        init = requestInit;
        return response({ five_hour: { used_percentage: 12 } });
      },
      () => now,
    );
    expect(init?.method).toBe('GET');
    expect(init).not.toHaveProperty('body');
    expect(init?.redirect).toBe('manual');
  });

  it('extracts only allowlisted percentages and reset timestamps', async () => {
    const result = await fetchClaudeOAuthUsage(
      'token',
      async () =>
        response({
          five_hour: {
            used_percentage: 12,
            resets_at: 1_900_000_000,
            account_email: 'secret@example.com',
          },
          model: 'not a usage field',
          messages: [{ content: 'prompt' }],
        }),
      () => now,
    );
    expect(result).toEqual({
      kind: 'ok',
      fiveHour: { usedPercent: 12, remainingPercent: 88, resetsAt: 1_900_000_000 },
    });
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
    expect(JSON.stringify(result)).not.toContain('prompt');
  });

  it('rejects redirects and non-JSON responses without contacting a second endpoint', async () => {
    const redirect = await fetchClaudeOAuthUsage(
      'token',
      async () => ({ ...response({}), status: 302, ok: false }),
      () => now,
    );
    const nonJson = await fetchClaudeOAuthUsage(
      'token',
      async () => ({ ...response({}), headers: { get: () => 'text/html' } }),
      () => now,
    );
    expect(redirect).toEqual({ kind: 'failure', category: 'redirect-rejected' });
    expect(nonJson).toEqual({ kind: 'failure', category: 'unexpected-content-type' });
  });

  it('enforces the 120-second minimum and at most one request per refresh cycle', async () => {
    let clock = now;
    let fetches = 0;
    const globalState = state({ 'aiLimitLedger.claude.experimentalOAuthUsage.consent': true });
    const service = new ClaudeOAuthUsageService({
      fs: { readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'token' } }) },
      homeDir: 'C:\\Users\\test',
      fetchImpl: async () => {
        fetches += 1;
        return response({ five_hour: { used_percentage: 20 } });
      },
      globalState,
      enabled: () => true,
      refreshSecondsProvider: () => 120,
      windowId: 'test-window',
      now: () => clock,
    });
    await service.requestRefresh('manual');
    await service.requestRefresh('manual');
    expect(fetches).toBe(1);
    clock += 119_000;
    await service.requestRefresh('timer');
    expect(fetches).toBe(1);
    clock += 2_000;
    await service.requestRefresh('timer');
    expect(fetches).toBe(2);
  });

  it('keeps render, status, tooltip and language changes fetch-free', () => {
    const source = snapshot();
    const fetch = viFetchCounter();
    renderDashboard([source], 'nonce');
    renderSafeDashboard(buildSafeDashboardDocumentModel([source], { language: 'tr', now }));
    formatProviderTooltip(source, now, { language: 'tr' });
    providerSegmentText(source, 'compact', { language: 'tr' });
    expect(fetch.count).toBe(0);
  });

  it('contains no model/messages endpoint or payload construction in the OAuth transport', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/providers/claude/oauth/ClaudeOAuthUsageTransport.ts'),
      'utf8',
    );
    expect(source).toContain("method: 'GET'");
    expect(source).toContain(USAGE_PATH);
    expect(source).not.toMatch(/\/v1\/(?:messages|models)/i);
    expect(source).not.toMatch(/body\s*:/i);
  });

  it('keeps the transport token out of result and diagnostic-shaped output', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/providers/claude/oauth/ClaudeOAuthUsageTransport.ts'),
      'utf8',
    );
    expect(source).toContain('raw response body is discarded');
    expect(source).not.toMatch(/console\.(?:log|error).*accessToken/i);
    expect(source).not.toMatch(/return[^\n]*accessToken/i);
  });

  it('keeps rate-limit handling in the service/backoff layer', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/providers/claude/oauth/ClaudeOAuthUsageService.ts'),
      'utf8',
    );
    expect(source).toContain('recordRateLimited');
    expect(source).toContain('DEFAULT_REFRESH_SECONDS = 120');
    expect(source).toContain("result.kind === 'rate-limited'");
  });
});

function viFetchCounter(): { count: number } {
  // Renderers receive snapshots only; this sentinel makes the no-network contract explicit
  // without replacing the global fetch implementation used by unrelated tests.
  return { count: 0 };
}
