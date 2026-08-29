import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  __createdWebviewPanels,
  __resetWindowMocks,
  __setWarningResponse,
  __warningCalls,
} from 'vscode';
import {
  getDashboardDiagnosticsSnapshot,
  recoverDashboard,
  refreshDashboard,
  setDashboardActionRunner,
  setDashboardLogger,
  showDashboard,
  __resetDashboardStateForTests,
} from '../src/ui/DetailsView';
import { DashboardActionRunner } from '../src/ui/DashboardActionRunner';
import { Logger } from '../src/infrastructure/Logger';
import {
  __resetDashboardGenerationCounterForTests,
  isDashboardReadyMessage,
} from '../src/ui/DashboardPanelSession';
import type { ProviderSnapshot } from '../src/providers/types';

function makeContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('/ext'),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function makeRunner(logger: Logger): DashboardActionRunner {
  return new DashboardActionRunner({
    logger,
    execute: async () => undefined,
  });
}

const snapshots: ProviderSnapshot[] = [];

const codexSnapshot: ProviderSnapshot = {
  providerId: 'codex',
  providerName: 'Codex',
  availability: 'ready',
  connected: true,
  plan: 'Plus',
  cliVersion: '1.0',
  usageWindows: [],
  source: 'Official Codex App Server',
  observedAt: Date.now(),
  checkedAt: Date.now(),
  stale: false,
  capabilities: { rateLimits: true, usage: true, statusLine: false },
};

describe('Dashboard panel lifecycle', () => {
  let logger: Logger;
  let context: vscode.ExtensionContext;
  let runner: DashboardActionRunner;

  beforeEach(() => {
    __resetWindowMocks();
    __resetDashboardStateForTests();
    __resetDashboardGenerationCounterForTests();
    logger = new Logger();
    context = makeContext();
    runner = makeRunner(logger);
    setDashboardActionRunner(runner);
    setDashboardLogger(logger);
  });

  afterEach(() => {
    vi.useRealTimers();
    logger.dispose();
  });

  it('reuses a healthy existing panel instead of creating a duplicate', () => {
    showDashboard(snapshots, context, runner);
    showDashboard(snapshots, context, runner);
    expect(__createdWebviewPanels()).toHaveLength(1);
    expect(__createdWebviewPanels()[0]!.visible).toBe(true);
  });

  it('does not reuse a disposed panel and drops the stale reference', () => {
    showDashboard(snapshots, context, runner);
    const first = __createdWebviewPanels()[0]!;
    first.dispose();
    expect(getDashboardDiagnosticsSnapshot().panelPresent).toBe(false);

    showDashboard(snapshots, context, runner);
    expect(__createdWebviewPanels()).toHaveLength(2);
    expect(getDashboardDiagnosticsSnapshot().panelPresent).toBe(true);
  });

  it("an old panel's dispose callback never clears a newer panel's reference", () => {
    showDashboard(snapshots, context, runner);
    const first = __createdWebviewPanels()[0]!;
    const firstGeneration = getDashboardDiagnosticsSnapshot().generation;

    // Simulate Recover Dashboard replacing the session, then the old panel's own
    // dispose event finally arriving afterwards (a real-world ordering race).
    void recoverDashboard(context);
    const secondGeneration = getDashboardDiagnosticsSnapshot().generation;
    expect(secondGeneration).not.toBe(firstGeneration);

    first.dispose();
    expect(getDashboardDiagnosticsSnapshot().generation).toBe(secondGeneration);
    expect(getDashboardDiagnosticsSnapshot().panelPresent).toBe(true);
  });

  it('a valid ready message marks the panel ready; an invalid payload is rejected', () => {
    expect(isDashboardReadyMessage({ type: 'dashboard.ready', clientVersion: 1 })).toBe(true);
    expect(isDashboardReadyMessage({ type: 'dashboard.ready' })).toBe(false);
    expect(isDashboardReadyMessage({ type: 'evil', clientVersion: 1 })).toBe(false);
    expect(isDashboardReadyMessage(null)).toBe(false);

    showDashboard(snapshots, context, runner);
    expect(getDashboardDiagnosticsSnapshot().ready).toBe(false);
    __createdWebviewPanels()[0]!.webview.__receiveMessage({
      type: 'dashboard.ready',
      clientVersion: 1,
    });
    expect(getDashboardDiagnosticsSnapshot().ready).toBe(true);
  });

  it('a duplicate ready message is harmless', () => {
    showDashboard(snapshots, context, runner);
    const webview = __createdWebviewPanels()[0]!.webview;
    webview.__receiveMessage({ type: 'dashboard.ready', clientVersion: 1 });
    const readyAtFirst = getDashboardDiagnosticsSnapshot().readyAt;
    webview.__receiveMessage({ type: 'dashboard.ready', clientVersion: 1 });
    expect(getDashboardDiagnosticsSnapshot().readyAt).toBe(readyAtFirst);
  });

  it('a message from a disposed panel is never forwarded to the action runner', () => {
    showDashboard(snapshots, context, runner);
    const panel = __createdWebviewPanels()[0]!;
    const handleRequestSpy = vi.spyOn(runner, 'handleRequest');
    panel.dispose();
    panel.webview.__receiveMessage({
      type: 'dashboard.action.request',
      requestId: 'r1',
      actionId: 'refresh-all',
    });
    expect(handleRequestSpy).not.toHaveBeenCalled();
  });

  it('recoverDashboard disposes the old panel and creates exactly one new panel', async () => {
    showDashboard(snapshots, context, runner);
    const first = __createdWebviewPanels()[0]!;
    const result = await recoverDashboard(context);
    expect(result.status).toBe('success');
    expect(first.disposed).toBe(true);
    expect(__createdWebviewPanels()).toHaveLength(2);
    expect(__createdWebviewPanels()[1]!.disposed).toBe(false);
  });

  it('recoverDashboard is single-flight: concurrent calls share one in-flight result and create one panel', async () => {
    showDashboard(snapshots, context, runner);
    const [a, b] = await Promise.all([recoverDashboard(context), recoverDashboard(context)]);
    expect(a).toBe(b);
    // One panel from showDashboard + exactly one recovery panel, not two.
    expect(__createdWebviewPanels()).toHaveLength(2);
  });

  it('showDashboard does not create a second panel while a recovery is in flight', async () => {
    showDashboard(snapshots, context, runner);
    const recovery = recoverDashboard(context);
    showDashboard(snapshots, context, runner);
    await recovery;
    expect(__createdWebviewPanels()).toHaveLength(2);
  });

  it('html is assigned once per generation and is not re-assigned for identical input', () => {
    showDashboard(snapshots, context, runner);
    expect(getDashboardDiagnosticsSnapshot().htmlAssignmentCount).toBe(1);
    showDashboard(snapshots, context, runner);
    expect(getDashboardDiagnosticsSnapshot().htmlAssignmentCount).toBe(1);
  });

  it('refresh before ready is buffered and flushed once, not replayed per call', () => {
    showDashboard(snapshots, context, runner);
    expect(getDashboardDiagnosticsSnapshot().htmlAssignmentCount).toBe(1);
    const changedA: ProviderSnapshot[] = [codexSnapshot];
    refreshDashboard(changedA);
    refreshDashboard(changedA);
    refreshDashboard(changedA);
    // Not ready yet: buffered, no extra html assignment.
    expect(getDashboardDiagnosticsSnapshot().htmlAssignmentCount).toBe(1);
    __createdWebviewPanels()[0]!.webview.__receiveMessage({
      type: 'dashboard.ready',
      clientVersion: 1,
    });
    // Ready flushes exactly one buffered render.
    expect(getDashboardDiagnosticsSnapshot().htmlAssignmentCount).toBe(2);
  });

  it('ready-timeout logs once and offers Recreate Dashboard without auto-recreating', async () => {
    vi.useFakeTimers();
    __setWarningResponse(undefined);
    showDashboard(snapshots, context, runner);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(__warningCalls()).toHaveLength(1);
    expect(__warningCalls()[0]!.message).toContain('Webview host did not initialize');
    expect(__warningCalls()[0]!.items[0]).toBe('Open Safe Dashboard');
    // No automatic second panel was created just because of the timeout.
    expect(__createdWebviewPanels()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6_000);
    // Firing again does not spam a second notification for the same panel.
    expect(__warningCalls()).toHaveLength(1);
  });

  it('getDashboardDiagnosticsSnapshot never present when no panel exists', () => {
    const snapshot = getDashboardDiagnosticsSnapshot();
    expect(snapshot.panelPresent).toBe(false);
    expect(snapshot.generation).toBeNull();
    expect(snapshot.disposed).toBe(true);
  });
});
