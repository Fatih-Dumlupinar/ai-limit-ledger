import { describe, expect, it, vi } from 'vitest';
import { registerWrapperWatcher } from '../src/extension';
import { ProviderCoordinator } from '../src/providers/ProviderCoordinator';
import type { ProviderAdapter, ProviderSnapshot } from '../src/providers/types';
import { EventEmitter } from './vscode';

type Disposable = { dispose(): void };
type Callback = () => void;

function fakeWatcher(options: { throwOn?: 'change' | 'create' | 'delete' } = {}) {
  const callbacks: Callback[] = [];
  const watcher = {
    onDidChange(callback: Callback): Disposable {
      if (options.throwOn === 'change') throw new Error('registration failed');
      callbacks.push(callback);
      return { dispose: vi.fn() };
    },
    onDidCreate(callback: Callback): Disposable {
      if (options.throwOn === 'create') throw new Error('registration failed');
      callbacks.push(callback);
      return { dispose: vi.fn() };
    },
    onDidDelete(callback: Callback): Disposable {
      if (options.throwOn === 'delete') throw new Error('registration failed');
      callbacks.push(callback);
      return { dispose: vi.fn() };
    },
    dispose: vi.fn(),
  };
  return { watcher, callbacks };
}

describe('wrapper watcher registration', () => {
  it('handles a missing wrapper and missing parent directory without throwing', () => {
    const watchers: Disposable[] = [];
    const created = fakeWatcher();
    const onError = vi.fn();

    registerWrapperWatcher(
      'C:\\missing-parent\\missing-wrapper.cmd',
      watchers,
      vi.fn(),
      onError,
      () => created.watcher as never,
    );

    expect(watchers).toHaveLength(4);
    expect(onError).not.toHaveBeenCalled();
  });

  it('contains watcher-construction exceptions', () => {
    const watchers: Disposable[] = [];
    const onError = vi.fn();

    registerWrapperWatcher('C:\\fixture\\claude-wrapper.cmd', watchers, vi.fn(), onError, () => {
      throw new Error('construction failed');
    });

    expect(watchers).toHaveLength(0);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('contains watcher-registration exceptions and disposes partial registrations', () => {
    const watchers: Disposable[] = [];
    const created = fakeWatcher({ throwOn: 'delete' });
    const onError = vi.fn();

    registerWrapperWatcher(
      'C:\\fixture\\claude-wrapper.cmd',
      watchers,
      vi.fn(),
      onError,
      () => created.watcher as never,
    );

    expect(watchers).toHaveLength(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(created.watcher.dispose).toHaveBeenCalledOnce();
  });

  it('contains callback exceptions and leaves provider startup independent', async () => {
    const watchers: Disposable[] = [];
    const created = fakeWatcher();
    const onError = vi.fn();
    const refresh = vi.fn(() => {
      throw new Error('refresh failed');
    });
    registerWrapperWatcher(
      'C:\\fixture\\claude-wrapper.cmd',
      watchers,
      refresh,
      onError,
      () => created.watcher as never,
    );
    expect(() => created.callbacks[0]()).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();

    const started = vi.fn();
    const emitter = new EventEmitter<ProviderSnapshot>();
    const provider: ProviderAdapter = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: { rateLimits: true, usage: true, statusLine: false },
      detect: async () => true,
      start: async () => {
        started();
      },
      stop: () => undefined,
      refresh: async () => undefined,
      getSnapshot: () => undefined,
      onDidChange: emitter.event,
      getDiagnostics: () => ({ state: 'loading' }),
    };
    const coordinator = new ProviderCoordinator([provider]);
    await coordinator.start();
    expect(started).toHaveBeenCalledOnce();
  });
});
