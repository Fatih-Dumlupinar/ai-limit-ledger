import { describe, expect, it, vi } from 'vitest';
import {
  isDashboardActionRequest,
  isSafeDashboardRequestId,
} from '../src/ui/DashboardActionProtocol';
import {
  DASHBOARD_ACTION_REGISTRY,
  getDashboardActionDefinition,
} from '../src/ui/DashboardActionRegistry';
import { DashboardActionRunner } from '../src/ui/DashboardActionRunner';

function logger() {
  return {
    createCorrelationId: vi.fn(() => 'host-correlation-1'),
    logRecord: vi.fn(),
    redact: (value: string) => value.replace(/token=[^ ]+/gi, 'token=[redacted]'),
  };
}

describe('Dashboard action protocol and registry', () => {
  it('accepts only the exact typed request envelope', () => {
    expect(
      isDashboardActionRequest({
        type: 'dashboard.action.request',
        requestId: 'request-1',
        actionId: 'refresh-all',
      }),
    ).toBe(true);
    expect(
      isDashboardActionRequest({
        type: 'dashboard.action.request',
        requestId: 'request-1',
        actionId: 'refresh-all',
        url: 'https://attacker.example',
      }),
    ).toBe(false);
    expect(
      isDashboardActionRequest({
        type: 'dashboard.action.request',
        requestId: 'request-1',
        actionId: 'evil',
      }),
    ).toBe(false);
    expect(isSafeDashboardRequestId('bad request')).toBe(false);
    expect(isSafeDashboardRequestId('x'.repeat(129))).toBe(false);
  });

  it('has unique registered IDs and host-only command mappings', () => {
    const ids = DASHBOARD_ACTION_REGISTRY.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getDashboardActionDefinition('open-codex-usage')?.commandId).toBe(
      'aiLimitLedger.openCodexUsagePage',
    );
    expect(getDashboardActionDefinition('refresh-codex')?.commandId).toBe(
      'aiLimitLedger.refreshCodex',
    );
    expect(getDashboardActionDefinition('refresh-claude')?.commandId).toBe(
      'aiLimitLedger.refreshClaude',
    );
    expect(getDashboardActionDefinition('refresh-codex')?.mutexGroup).toBe('provider:codex');
    expect(getDashboardActionDefinition('refresh-claude')?.mutexGroup).toBe('provider:claude');
    expect(
      DASHBOARD_ACTION_REGISTRY.every((definition) =>
        definition.commandId.startsWith('aiLimitLedger.'),
      ),
    ).toBe(true);
  });
});

describe('DashboardActionRunner', () => {
  it('acknowledges before awaiting execution and ignores request replay', async () => {
    const messages: Array<{ type: string; requestId: string }> = [];
    let resolveExecution!: (value: unknown) => void;
    const execution = new Promise<unknown>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const runnerLogger = logger();
    const runner = new DashboardActionRunner({
      logger: runnerLogger,
      execute,
      postMessage: (message) => messages.push({ type: message.type, requestId: message.requestId }),
    });

    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'request-1',
      actionId: 'refresh-all',
    });
    expect(messages[0]).toEqual({ type: 'dashboard.action.accepted', requestId: 'request-1' });
    expect(execute).toHaveBeenCalledTimes(1);
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'request-1',
      actionId: 'refresh-all',
    });
    expect(execute).toHaveBeenCalledTimes(1);

    expect(runner.getActionStates()[0]?.state).toBe('working');
    resolveExecution({ status: 'success', safeMessage: 'must be replaced by registry message' });
    await vi.waitFor(() => expect(messages.at(-1)?.type).toBe('dashboard.action.result'));
    expect(runnerLogger.createCorrelationId).toHaveBeenCalledTimes(1);
    runner.dispose();
  });

  it('single-flights conflicting provider actions and releases the mutex in finally', async () => {
    let resolveExecution!: (value: unknown) => void;
    const execution = new Promise<unknown>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const messages: Array<{ type: string; actionId: string; status?: string }> = [];
    const runner = new DashboardActionRunner({
      logger: logger(),
      execute,
      postMessage: (message) =>
        messages.push({
          type: message.type,
          actionId: message.actionId,
          ...(message.type.endsWith('result') ? { status: message.status } : {}),
        }),
    });

    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'claude-1',
      actionId: 'enable-claude',
    });
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'claude-2',
      actionId: 'repair-claude',
    });
    await vi.waitFor(() =>
      expect(messages.some((message) => message.status === 'throttled')).toBe(true),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    resolveExecution({ status: 'success' });
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.status === 'success')).toHaveLength(1),
    );
    runner.dispose();
  });

  it('does not expose a thrown exception and preserves working state across snapshot renders', async () => {
    const runner = new DashboardActionRunner({
      logger: logger(),
      execute: async () => {
        throw new Error('token=secret C:\\Users\\private\\path');
      },
      postMessage: () => undefined,
    });
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'error-1',
      actionId: 'copy-redacted-diagnostics',
    });
    expect(runner.getActionStates()[0]?.state).toBe('working');
    await vi.waitFor(() => expect(runner.getActionStates()[0]?.state).toBe('error'));
    expect(runner.getActionStates()[0]?.message).not.toContain('secret');
    expect(runner.getActionStates()[0]?.message).not.toContain('C:\\Users');
    runner.dispose();
  });

  it('does not run the same external action twice and isolates refresh-all from provider refresh', async () => {
    let resolveExecution!: (value: unknown) => void;
    const execution = new Promise<unknown>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const results: string[] = [];
    const runner = new DashboardActionRunner({
      logger: logger(),
      execute,
      postMessage: (message) => {
        if (message.type === 'dashboard.action.result') results.push(message.status);
      },
    });
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'link-1',
      actionId: 'open-codex-usage',
    });
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'link-2',
      actionId: 'open-codex-usage',
    });
    await vi.waitFor(() => expect(results).toContain('throttled'));
    expect(execute).toHaveBeenCalledTimes(1);
    resolveExecution({ status: 'success' });
    await vi.waitFor(() => expect(results).toContain('success'));

    let resolveRefresh!: (value: unknown) => void;
    const refreshExecution = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve;
    });
    execute.mockImplementation(() => refreshExecution);
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'all-1',
      actionId: 'refresh-all',
    });
    runner.handleRequest({
      type: 'dashboard.action.request',
      requestId: 'provider-1',
      actionId: 'refresh-copilot',
    });
    await vi.waitFor(() =>
      expect(results.filter((status) => status === 'throttled')).toHaveLength(2),
    );
    resolveRefresh({ status: 'success' });
    runner.dispose();
  });
});
