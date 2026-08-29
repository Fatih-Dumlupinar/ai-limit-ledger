import { describe, expect, it, vi } from 'vitest';
import { GrokMethodNotSupportedError } from '../src/providers/grok/GrokAcpClient';
import { resolveGrokCli, validateExplicitGrokPath } from '../src/providers/grok/GrokCliResolver';
import { GrokProvider } from '../src/providers/grok/GrokProvider';
import { parseGrokBilling } from '../src/providers/grok/GrokUsageParser';

describe('Grok detection and allowlist parsing', () => {
  it('rejects relative and workspace executable paths', () => {
    expect(validateExplicitGrokPath('grok.exe', 'C:\\workspace', 'win32').valid).toBe(false);
    expect(
      validateExplicitGrokPath('C:\\workspace\\tools\\grok.exe', 'C:\\workspace', 'win32').reason,
    ).toBe('workspace-path-rejected');
    expect(
      validateExplicitGrokPath('C:\\Program Files\\Grok\\grok.exe', 'C:\\workspace', 'win32').valid,
    ).toBe(true);
  });

  it('does not turn a missing percentage into zero', () => {
    const summary = parseGrokBilling({
      subscriptionTier: 'Pro',
      currentPeriod: { start: '2026-08-18T00:00:00Z', end: '2026-08-25T00:00:00Z' },
      productBreakdown: [{ product: 'Build', usedPercent: 34 }],
      prepaidBalance: 12,
      secret: 'ignored',
    });
    expect(summary.usageWindows).toHaveLength(0);
    expect(summary.productBreakdown).toEqual([
      { product: 'Build', usedPercent: 34, credits: null },
    ]);
    expect(summary.extraCreditBalance).toBe(12);
  });

  it('contains rejected PATH version probes instead of rejecting CLI resolution', async () => {
    await expect(
      resolveGrokCli({
        platform: 'linux',
        env: { HOME: '/home/test' },
        fs: { stat: async () => ({ isFile: () => false }) },
        runVersion: async () => {
          throw Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });
        },
      }),
    ).resolves.toMatchObject({ installed: false, reason: 'not-found' });
  });

  it('parses a real weekly percentage and reset timestamp when provided', () => {
    const summary = parseGrokBilling({
      creditUsagePercent: 34,
      currentPeriod: { end: '2026-09-01T00:00:00Z' },
    });
    expect(summary.usageWindows[0]).toMatchObject({
      usedPercent: 34,
      remainingPercent: 66,
      resetsAt: 1788220800,
    });
  });
});

describe('GrokProvider lifecycle', () => {
  it('keeps the selected provider visible when the CLI is missing', async () => {
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({
        installed: false,
        executablePath: null,
        version: null,
        reason: 'not-found',
      }),
      detectExtension: () => ({
        installed: true,
        id: 'pawelhuryn.grok-vscode-phuryn',
        version: '3.16.0',
        official: false,
      }),
    });
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('cli-not-installed');
    expect(provider.getSnapshot()?.metadata?.extensionOfficial).toBe(false);
  });

  it('publishes CLI setup before disabled state can hide it', async () => {
    const provider = new GrokProvider({
      enabled: () => false,
      detectCli: async () => ({ installed: false, executablePath: null, version: null }),
    });
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('cli-not-installed');
  });

  it('caches method-not-found as capability unavailable for the same CLI version', async () => {
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
    });
    await provider.start();
    await provider.refresh(true);
    expect(provider.getSnapshot()?.availability).toBe('method-not-supported');
    await provider.refresh(true);
    expect(provider.getSnapshot()?.availability).toBe('method-not-supported');
  });

  it('engages the experimental CLI-proxy fallback when ACP is method-not-supported and opted in', async () => {
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ config: { creditUsagePercent: 24 } }),
    }));
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch,
      authFile: { readFile: async () => JSON.stringify(validGrokAuthStore()) },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    const snapshot = provider.getSnapshot();
    expect(snapshot?.availability).toBe('ready-experimental');
    expect(snapshot?.usageWindows[0]?.usedPercent).toBe(24);
    expect(snapshot?.metadata?.acpBillingCapability).toBe('unavailable-safe-fallback-active');
    // method-not-supported is not a terminal error state while the fallback is active.
    expect(snapshot?.availability).not.toBe('method-not-supported');
  });

  it('does not read the auth file when the experimental fallback is not opted in (no consent, no read)', async () => {
    const readFile = vi.fn(async () => JSON.stringify(validGrokAuthStore()));
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => false,
      authFile: { readFile },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(provider.getSnapshot()?.availability).toBe('method-not-supported');
  });

  it('falls back to the plain method-not-supported snapshot when the auth file is missing', async () => {
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch: vi.fn(),
      authFile: {
        readFile: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    expect(provider.getSnapshot()?.availability).toBe('method-not-supported');
    // The auth-file-missing reason must be diagnosable — this is the exact silent-failure class
    // reported in production ("grok komutu olmadı") where Enable ran but nothing ever explained why.
    expect(provider.experimentalFallbackStatus).toEqual({ reason: 'auth-file-missing' });
    expect(provider.experimentalFallbackStatusText).toBe('auth-file-missing');
    expect(provider.getSnapshot()?.metadata?.experimentalFallbackStatus).toBe('auth-file-missing');
  });

  it('reports invalid-auth-store-structure without ever exposing the file contents', async () => {
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch: vi.fn(),
      authFile: { readFile: async () => JSON.stringify({ email: 'user@example.com' }) },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    expect(provider.experimentalFallbackStatus).toEqual({ reason: 'no-compatible-session' });
    expect(provider.experimentalFallbackStatusText).toBe('no-compatible-session');
    expect(JSON.stringify(provider.getSnapshot())).not.toContain('user@example.com');
  });

  it('reports a safe proxy-authentication-required reason when the CLI-proxy rejects the token', async () => {
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch: vi.fn(async () => ({
        status: 401,
        ok: false,
        headers: { get: () => null },
        text: async () => '',
      })),
      authFile: { readFile: async () => JSON.stringify(validGrokAuthStore()) },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    expect(provider.experimentalFallbackStatus).toEqual({
      reason: 'proxy-authentication-required',
    });
    expect(provider.getSnapshot()?.availability).toBe('method-not-supported');
  });

  it('never leaks the auth-store scope key (URL/UUID) into diagnostics', async () => {
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch: vi.fn(async () => ({
        status: 401,
        ok: false,
        headers: { get: () => null },
        text: async () => '',
      })),
      authFile: {
        readFile: async () =>
          JSON.stringify({
            'https://auth.x.ai::11111111-1111-1111-1111-111111111111': {
              key: 'tok',
              user_id: 'user-1',
              auth_mode: 'oidc',
              oidc_issuer: 'https://auth.x.ai',
              create_time: 1_700_000_000,
            },
          }),
      },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    const serialized = JSON.stringify(provider.getSnapshot());
    expect(serialized).not.toContain('https://auth.x.ai::');
    expect(serialized).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(serialized).not.toContain('tok');
    expect(serialized).not.toContain('user-1');
  });
  it('classifies an explicit free-plan billing response without treating it as an error', async () => {
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ config: null, subscription_tier: 'free' }),
    }));
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch,
      authFile: { readFile: async () => JSON.stringify(validGrokAuthStore()) },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    const snapshot = provider.getSnapshot();
    expect(snapshot?.availability).toBe('ready-experimental');
    expect(snapshot?.warning).toContain('Free plan');
    expect(provider.experimentalFallbackStatus).toEqual({ reason: 'free-plan' });
  });

  it('reports billing-not-exposed when auth is valid but the endpoint returns no billing config', async () => {
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ config: null }),
    }));
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch,
      authFile: { readFile: async () => JSON.stringify(validGrokAuthStore()) },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    expect(provider.experimentalFallbackStatus).toEqual({ reason: 'billing-not-exposed' });
    expect(provider.getSnapshot()?.availability).toBe('method-not-supported');
  });

  it('sends the resolved CLI version and selected user_id as request headers', async () => {
    const experimentalFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ config: { creditUsagePercent: 10 } }),
    }));
    const provider = new GrokProvider({
      enabled: () => true,
      detectCli: async () => ({ installed: true, executablePath: 'grok.exe', version: '0.2.117' }),
      detectExtension: () => ({ installed: false, id: null, version: null, official: false }),
      createTransport: () => ({
        getBilling: async () => {
          throw new GrokMethodNotSupportedError();
        },
        dispose: () => undefined,
      }),
      experimentalEnabled: () => true,
      experimentalFetch,
      authFile: { readFile: async () => JSON.stringify(validGrokAuthStore()) },
      homeDir: () => 'C:\\Users\\me',
    });
    await provider.start();
    await provider.refresh(true);
    const [, init] = experimentalFetch.mock.calls[0];
    expect(init.headers['x-userid']).toBe('user-1');
    expect(init.headers['x-grok-client-version']).toBe('0.2.117');
    expect(init.headers['X-XAI-Token-Auth']).toBe('xai-grok-cli');
  });
});

function validGrokAuthStore() {
  return {
    'https://auth.x.ai::22222222-2222-2222-2222-222222222222': {
      key: 'tok',
      user_id: 'user-1',
      auth_mode: 'oidc',
      oidc_issuer: 'https://auth.x.ai',
      create_time: 1_700_000_000,
    },
  };
}
