import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../src/providers/ClaudeCodeProvider';
import {
  EXTENSION_ONLY_GRACE_MS,
  RESTART_GRACE_MS,
  WAITING_TIMEOUT_MS,
} from '../src/providers/claude/ClaudeStateMachine';
import { ProviderCoordinator } from '../src/providers/ProviderCoordinator';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderHealth,
  ProviderSnapshot,
} from '../src/providers/types';
import { EventEmitter } from './vscode';

describe('ClaudeCodeProvider lifecycle', () => {
  it('reports unavailable when the Claude CLI is absent', async () => {
    const provider = new ClaudeCodeProvider(
      'missing',
      () => false,
      () => false,
    );
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('unavailable');
  });

  it('reports setup when the CLI exists but integration is disabled', async () => {
    const provider = new ClaudeCodeProvider(
      'missing',
      () => false,
      () => true,
    );
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('integration-required');
  });

  it('reports waiting when integration is enabled without a bridge snapshot', async () => {
    const provider = new ClaudeCodeProvider(
      'missing',
      () => true,
      () => true,
    );
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('waiting-for-first-response');
  });

  it('transitions integration-required -> waiting-for-first-response -> ready as enablement and the bridge snapshot change', async () => {
    let enabled = false;
    const provider = new ClaudeCodeProvider(
      'missing',
      () => enabled,
      () => true,
    );
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('integration-required');

    enabled = true;
    await provider.refresh();
    expect(provider.getSnapshot()?.availability).toBe('waiting-for-first-response');
  });

  it('shows restart-required (not waiting-for-first-response) right after enable, until a real snapshot arrives', async () => {
    let snapshotConfirmed = 0;
    const provider = new ClaudeCodeProvider(
      'missing-bridge-file',
      () => true,
      () => true,
      async () => ({
        ownedEffective: true,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: true,
        awaitingSessionRestart: true,
        msSinceEnabled: 1000,
        hostKind: 'standalone-cli',
      }),
      async () => {
        snapshotConfirmed += 1;
      },
    );
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('restart-required');
    expect(snapshotConfirmed).toBe(0);
  });

  it('is waiting-for-first-response (not restart-required) once the restart has already happened', async () => {
    const provider = new ClaudeCodeProvider(
      'missing-bridge-file',
      () => true,
      () => true,
      async () => ({
        ownedEffective: true,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: true,
        awaitingSessionRestart: false,
        msSinceEnabled: RESTART_GRACE_MS + 1000,
        hostKind: 'standalone-cli',
      }),
    );
    await provider.start();
    expect(provider.getSnapshot()?.availability).toBe('waiting-for-first-response');
  });

  it('never waits indefinitely: a CLI-capable host escalates to upstream-statusline-not-invoked once the wait timeout elapses', async () => {
    const withCli = new ClaudeCodeProvider(
      'missing-bridge-file',
      () => true,
      () => true,
      async () => ({
        ownedEffective: true,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: true,
        awaitingSessionRestart: false,
        msSinceEnabled: WAITING_TIMEOUT_MS + 1000,
        hostKind: 'standalone-cli',
        accessMode: 'standalone-cli',
        extensionVersion: null,
      }),
    );
    await withCli.start();
    expect(withCli.getSnapshot()?.availability).toBe('upstream-statusline-not-invoked');
    expect(withCli.getSnapshot()?.warning).toContain('upstream Claude Code behavior');
  });

  it('extension-only mode never waits indefinitely either: falls back to manual-only well before the CLI-track timeout', async () => {
    const extensionOnly = new ClaudeCodeProvider(
      'missing-bridge-file',
      () => true,
      () => true,
      async () => ({
        ownedEffective: true,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: true,
        awaitingSessionRestart: false,
        msSinceEnabled: EXTENSION_ONLY_GRACE_MS + 1000,
        hostKind: 'vscode-sidebar',
        accessMode: 'vscode-extension',
        extensionVersion: '2.1.241',
      }),
    );
    await extensionOnly.start();
    expect(extensionOnly.getSnapshot()?.availability).toBe('manual-only');
    expect(extensionOnly.getSnapshot()?.connected).toBe(true);
  });

  it('extension-only, no CLI, no snapshot yet: is connected and manual-only, never integration-required/unavailable/unsupported-surface', async () => {
    const provider = new ClaudeCodeProvider(
      'missing-bridge-file',
      () => false, // automatic tracking never opted into
      () => true, // extension detected -> cliAvailable() true even without a standalone CLI
      async () => ({
        ownedEffective: true,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: null,
        awaitingSessionRestart: false,
        msSinceEnabled: null,
        hostKind: 'vscode-sidebar',
        accessMode: 'vscode-extension',
        extensionVersion: '2.1.241',
      }),
    );
    await provider.start();
    const snapshot = provider.getSnapshot();
    expect(snapshot?.availability).toBe('manual-only');
    expect(snapshot?.connected).toBe(true);
    expect(snapshot?.availability).not.toBe('integration-required');
    expect(snapshot?.availability).not.toBe('unavailable');
    expect(snapshot?.availability).not.toBe('unsupported-surface');
    expect(snapshot?.availability).not.toBe('waiting-for-first-response');
  });

  it('never shows a successful data-update timestamp in manual-only mode', async () => {
    const provider = new ClaudeCodeProvider(
      'missing-bridge-file',
      () => false,
      () => true,
      async () => ({
        ownedEffective: true,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: null,
        awaitingSessionRestart: false,
        msSinceEnabled: null,
        hostKind: 'vscode-sidebar',
        accessMode: 'vscode-extension',
        extensionVersion: null,
      }),
    );
    await provider.start();
    const snapshot = provider.getSnapshot();
    expect(snapshot?.usageWindows).toHaveLength(0);
    // No real snapshot was ever parsed, so any "observedAt" is only a checked-at timestamp,
    // never presented in the UI as a successful data update (see DetailsView.timestampLines).
  });

  it('a later real snapshot promotes extension-only manual-only straight to ready/connected with usage data', async () => {
    let bridgeContent: string | undefined;
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ail-manual-promote-'));
    const bridgeFile = path.join(dir, 'claude-status.json');
    try {
      const provider = new ClaudeCodeProvider(
        bridgeFile,
        () => true,
        () => true,
        async () => ({
          ownedEffective: true,
          shadowedByProject: false,
          wrapperExists: true,
          cliVersionCompatible: null,
          awaitingSessionRestart: false,
          msSinceEnabled: EXTENSION_ONLY_GRACE_MS + 1000,
          hostKind: 'vscode-sidebar',
          accessMode: 'vscode-extension',
          extensionVersion: '2.1.241',
        }),
      );
      await provider.start();
      expect(provider.getSnapshot()?.availability).toBe('manual-only');

      bridgeContent = JSON.stringify({
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_900_000_000 } },
      });
      await fs.writeFile(bridgeFile, bridgeContent, 'utf8');
      await provider.refresh();
      const snapshot = provider.getSnapshot();
      expect(snapshot?.availability).toBe('ready');
      expect(snapshot?.usageWindows.length).toBeGreaterThan(0);
      expect(snapshot?.metadata?.usageCapability).toBe('automatic-live');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces configuration-shadowed, repair-required, and external-change from the classifier', async () => {
    const shadowed = new ClaudeCodeProvider(
      'missing',
      () => true,
      () => true,
      async () => ({
        ownedEffective: true,
        effectiveStatusLinePresent: true,
        shadowedByProject: true,
        wrapperExists: true,
        cliVersionCompatible: true,
        awaitingSessionRestart: false,
      }),
    );
    await shadowed.start();
    expect(shadowed.getSnapshot()?.availability).toBe('configuration-shadowed');

    const missingWrapper = new ClaudeCodeProvider(
      'missing',
      () => true,
      () => true,
      async () => ({
        ownedEffective: true,
        effectiveStatusLinePresent: true,
        shadowedByProject: false,
        wrapperExists: false,
        cliVersionCompatible: true,
        awaitingSessionRestart: false,
      }),
    );
    await missingWrapper.start();
    expect(missingWrapper.getSnapshot()?.availability).toBe('repair-required');

    const externallyChanged = new ClaudeCodeProvider(
      'missing',
      () => true,
      () => true,
      async () => ({
        ownedEffective: false,
        effectiveStatusLinePresent: true,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: true,
        awaitingSessionRestart: false,
      }),
    );
    await externallyChanged.start();
    expect(externallyChanged.getSnapshot()?.availability).toBe('external-change');

    const statusLineDropped = new ClaudeCodeProvider(
      'missing',
      () => true,
      () => true,
      async () => ({
        ownedEffective: false,
        effectiveStatusLinePresent: false,
        shadowedByProject: false,
        wrapperExists: true,
        cliVersionCompatible: true,
        awaitingSessionRestart: false,
      }),
    );
    await statusLineDropped.start();
    expect(statusLineDropped.getSnapshot()?.availability).toBe('repair-required');
  });

  it('fires onDidChange immediately on refresh, without waiting for a poll interval', async () => {
    const provider = new ClaudeCodeProvider(
      'missing',
      () => true,
      () => true,
    );
    const seen: string[] = [];
    provider.onDidChange((snapshot) => seen.push(snapshot.availability));
    await provider.start();
    await provider.refresh();
    expect(seen).toEqual(['waiting-for-first-response', 'waiting-for-first-response']);
  });
});

class FailingProvider implements ProviderAdapter {
  readonly id = 'failing';
  readonly displayName = 'Failing';
  readonly capabilities: ProviderCapabilities = {
    rateLimits: false,
    usage: false,
    statusLine: false,
  };
  readonly emitter = new EventEmitter<ProviderSnapshot>();
  readonly onDidChange = this.emitter.event;
  async detect(): Promise<boolean> {
    return false;
  }
  async start(): Promise<void> {
    throw new Error('expected');
  }
  stop(): void {}
  async refresh(): Promise<undefined> {
    return undefined;
  }
  getSnapshot(): undefined {
    return undefined;
  }
  getDiagnostics(): ProviderHealth {
    return { state: 'error' };
  }
}

class ReadyProvider extends FailingProvider {
  override readonly id = 'ready';
  override async start(): Promise<void> {
    this.emitter.fire(this.snapshot);
  }
  private readonly snapshot: ProviderSnapshot = {
    providerId: 'ready',
    providerName: 'Ready',
    availability: 'ready',
    connected: true,
    plan: null,
    cliVersion: null,
    usageWindows: [],
    source: 'Official Codex App Server',
    observedAt: 0,
    stale: false,
    capabilities: { rateLimits: false, usage: false, statusLine: false },
  };
}

class RefreshFailingProvider extends ReadyProvider {
  override readonly id = 'claude';
  override async refresh(): Promise<undefined> {
    throw new Error('claude auto-heal / provider refresh failed');
  }
}

describe('ProviderCoordinator', () => {
  it('isolates a provider startup error and starts the remaining providers', async () => {
    const logger = { error: vi.fn() };
    const coordinator = new ProviderCoordinator(
      [new FailingProvider(), new ReadyProvider()],
      logger,
    );
    await coordinator.start();
    expect(coordinator.getSnapshots().map((snapshot) => snapshot.providerId)).toEqual([
      'failing',
      'ready',
    ]);
    expect(coordinator.getSnapshot('failing')?.availability).toBe('startup-error');
    expect(coordinator.getLifecycle('failing')).toMatchObject({ phase: 'failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"providerId":"failing"'));
  });

  it('retains a canonical snapshot key for a selected provider', async () => {
    const provider = new ReadyProvider();
    const coordinator = new ProviderCoordinator([provider], undefined, {
      selectedProviderIds: ['ready'],
    });
    await coordinator.start();
    expect(coordinator.getSnapshot('ready')?.providerId).toBe('ready');
  });

  it('keeps Codex refreshing normally when the Claude provider throws on refresh', async () => {
    const logger = { error: vi.fn() };
    const claude = new RefreshFailingProvider();
    const codex = new ReadyProvider();
    const coordinator = new ProviderCoordinator([claude, codex], logger);
    await coordinator.start();
    await coordinator.refresh(true);
    const codexSnapshot = coordinator.getSnapshots().find((s) => s.providerId === 'ready');
    expect(codexSnapshot?.availability).toBe('ready');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"providerId":"claude"'));
  });
});
