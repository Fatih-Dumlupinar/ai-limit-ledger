import { describe, expect, it } from 'vitest';
import { CACHE_CLEAR_ALLOWLIST, clearAllowedCaches } from '../src/infrastructure/CacheKeys';
import {
  buildRedactedDiagnostics,
  buildRedactedSupportBundle,
  serializeRedacted,
  writeRedactedSupportBundleAtomically,
  type RedactedSupportBundle,
} from '../src/infrastructure/RedactedDiagnostics';
import { resolveProviderPresentations } from '../src/providers/ProviderCapabilityContract';
import type { ProviderSnapshot } from '../src/providers/types';
import type { SafeLogRecord } from '../src/infrastructure/Logger';

function snapshot(): ProviderSnapshot {
  return {
    providerId: 'codex',
    providerName: 'Codex',
    availability: 'ready',
    connected: true,
    plan: null,
    cliVersion: '1.2.3',
    usageWindows: [],
    source: 'Official Codex App Server',
    observedAt: 1000,
    checkedAt: 1000,
    stale: false,
    capabilities: { rateLimits: true, usage: true, statusLine: false },
    metadata: {
      cliInstalled: true,
      lifecyclePhase: 'started',
      wrapperDetected: true,
      wrapperHashMatch: true,
    },
  };
}

describe('Task 2 diagnostics and cache boundaries', () => {
  it('builds a support bundle from safe fields and caps memory logs at 200', () => {
    const provider = snapshot();
    const diagnostics = buildRedactedDiagnostics(
      [provider],
      resolveProviderPresentations([provider]),
      {
        now: 2000,
        extensionVersion: '0.4.5',
        vscodeVersion: '1.95.0',
        platform: 'win32',
        architecture: 'x64',
      },
    );
    const logs: SafeLogRecord[] = Array.from({ length: 205 }, (_, index) => ({
      timestamp: new Date(1000 + index).toISOString(),
      level: 'info',
      action: 'test',
      correlationId: 'test-correlation-id',
      message: index === 204 ? 'token=super-secret C:\\Users\\fixture\\secret' : `safe-${index}`,
    }));
    const bundle = buildRedactedSupportBundle(
      diagnostics,
      {
        selectedProviders: ['codex'],
        refresh: { manualCooldownSeconds: 10 },
      },
      logs,
    );
    expect(bundle.extension.version).toBe('0.4.5');
    expect(bundle.configuration.selectedProviders).toEqual(['codex']);
    expect(bundle.recentLogs).toHaveLength(200);
    expect(serializeRedacted(bundle)).not.toContain('super-secret');
    expect(serializeRedacted(bundle)).not.toContain('C:\\Users\\fixture');
  });

  it('clears only the explicit cache allowlist', async () => {
    const updates: Array<{ key: string; value: undefined }> = [];
    await clearAllowedCaches({
      update: async (key, value) => {
        updates.push({ key, value });
      },
    });
    expect(updates.map((update) => update.key)).toEqual([...CACHE_CLEAR_ALLOWLIST]);
    expect(updates.every((update) => update.value === undefined)).toBe(true);
    expect(updates.map((update) => update.key)).not.toContain('aiLimitLedger.claudeEnabled');
    expect(updates.map((update) => update.key)).not.toContain(
      'aiLimitLedger.claude.autoRepairConsent',
    );
  });

  it('writes support bundles through temp file and atomic rename', async () => {
    const writes: string[] = [];
    const renames: string[][] = [];
    const bundle = {
      schemaVersion: 1 as const,
      generatedAt: new Date(1000).toISOString(),
      extension: { version: '0.4.5', vscodeVersion: '1.95.0', platform: 'test', arch: 'x64' },
      providers: [],
      configuration: { selectedProviders: [], safeRefreshSettings: {} },
      recentLogs: [],
    } satisfies RedactedSupportBundle;
    await writeRedactedSupportBundleAtomically(
      {
        writeFile: async (path) => {
          writes.push(path);
        },
        rename: async (from, to) => {
          renames.push([from, to]);
        },
      },
      'selected.json',
      bundle,
      'selected.json.tmp',
    );
    expect(writes).toEqual(['selected.json.tmp']);
    expect(renames).toEqual([['selected.json.tmp', 'selected.json']]);
  });
});
