import type * as vscode from 'vscode';
import type { Logger } from '../infrastructure/Logger';

/**
 * Generation-based lifecycle tracking for the single Dashboard webview panel.
 *
 * Exists because `vscode.window.createWebviewPanel` + a module-level "current panel"
 * reference is prone to reuse-after-dispose and duplicate-panel races when Open
 * Dashboard / Recover Dashboard / provider snapshot updates race each other. Every
 * panel gets a monotonic generation id; anything that could act on a stale panel
 * (postMessage, webview.html assignment, dispose cleanup) must first check that the
 * generation it holds still matches the current session and that the session is not
 * already disposed.
 */
export interface DashboardPanelSession {
  readonly generation: number;
  readonly panel: vscode.WebviewPanel;
  ready: boolean;
  disposed: boolean;
  readonly createdAt: number;
  readyAt?: number;
  htmlAssignmentCount: number;
  lastHtmlHash?: string;
  readyTimeoutNotified: boolean;
  readonly disposables: vscode.Disposable[];
}

let nextGeneration = 1;

/** Test-only: resets the module-level generation counter so test runs are deterministic. */
export function __resetDashboardGenerationCounterForTests(): void {
  nextGeneration = 1;
}

export function createDashboardPanelSession(panel: vscode.WebviewPanel): DashboardPanelSession {
  return {
    generation: nextGeneration++,
    panel,
    ready: false,
    disposed: false,
    createdAt: Date.now(),
    htmlAssignmentCount: 0,
    readyTimeoutNotified: false,
    disposables: [],
  };
}

export const DASHBOARD_READY_TIMEOUT_MS = 6_000;

export interface DashboardReadyMessage {
  type: 'dashboard.ready';
  clientVersion: number;
}

/** Runtime type guard — the webview is untrusted input, so this never trusts shape beyond what it checks. */
export function isDashboardReadyMessage(value: unknown): value is DashboardReadyMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'dashboard.ready' && typeof record.clientVersion === 'number';
}

/**
 * A cheap (non-cryptographic) content hash used only to skip re-assigning
 * `webview.html` when the new markup is byte-identical to what is already
 * loaded — assigning the same HTML twice would still reload the webview and
 * reset its in-page script state for no visible change.
 */
export function hashHtml(html: string): string {
  let hash = 5381;
  for (let index = 0; index < html.length; index += 1) {
    hash = (hash * 33 + html.charCodeAt(index)) | 0;
  }
  return `${hash.toString(36)}:${html.length.toString(36)}`;
}

export type DashboardLifecycleEvent =
  | 'dashboard.panel.created'
  | 'dashboard.panel.ready'
  | 'dashboard.panel.disposed'
  | 'dashboard.panel.ready-timeout'
  | 'dashboard.panel.recovered';

/**
 * Logs only safe, non-identifying fields — never a panel UUID, webview origin, user
 * path, or raw payload. `generation` and any `extra` numeric/boolean detail are
 * embedded directly in the (redacted, length-capped) message text rather than in
 * arbitrary structured fields, since `Logger.logRecord` only forwards a fixed
 * whitelist of field names.
 */
export function logDashboardLifecycle(
  logger: Logger,
  event: DashboardLifecycleEvent,
  generation: number,
  extra: Record<string, string | number | boolean> = {},
): void {
  const detail = Object.entries(extra)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  logger.logRecord('info', {
    action: event,
    message: detail
      ? `${event} generation=${generation} ${detail}`
      : `${event} generation=${generation}`,
  });
}

/**
 * Disposes a session's tracked disposables and marks it disposed. Safe to call more
 * than once; a second call is a no-op because `disposed` is already true.
 */
export function disposeDashboardPanelSession(session: DashboardPanelSession): void {
  if (session.disposed) return;
  session.disposed = true;
  for (const disposable of session.disposables) {
    try {
      disposable.dispose();
    } catch {
      // Best-effort cleanup only — a single disposable failing must not block the rest.
    }
  }
  session.disposables.length = 0;
}
