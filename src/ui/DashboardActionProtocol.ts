import type { SafeErrorCategory } from '../infrastructure/ProviderDiagnostics';
import { SAFE_ERROR_CATEGORIES } from '../infrastructure/ProviderDiagnostics';

export const DASHBOARD_ACTION_IDS = [
  'refresh-all',
  'refresh-codex',
  'refresh-claude',
  'open-provider-settings',
  'show-logs',
  'copy-redacted-diagnostics',
  'export-redacted-support-bundle',
  'restart-codex-app-server',
  'diagnose-codex',
  'open-codex-usage',
  'enable-claude',
  'disable-claude',
  'repair-claude',
  'recheck-claude',
  'diagnose-claude',
  'open-claude-usage',
  'open-claude-install-guide',
  'launch-claude-terminal',
  'copy-claude-diagnostics',
  'open-claude-code',
  'copy-claude-usage',
  'open-claude-enhanced-mode-docs',
  'enable-claude-auto-repair',
  'disable-claude-auto-repair',
  'enable-claude-oauth',
  'disable-claude-oauth',
  'open-claude-oauth-docs',
  'connect-copilot',
  'disconnect-copilot',
  'refresh-copilot',
  'configure-copilot-plan',
  'diagnose-copilot',
  'open-copilot-usage',
  'enable-copilot-experimental',
  'disable-copilot-experimental',
  'enable-grok',
  'disable-grok',
  'refresh-grok',
  'recheck-grok',
  'launch-grok-login',
  'diagnose-grok',
  'open-grok-install-guide',
  'open-grok-usage',
  'copy-grok-usage',
  'enable-grok-experimental',
  'disable-grok-experimental',
] as const;

export type DashboardActionId = (typeof DASHBOARD_ACTION_IDS)[number];

export interface DashboardActionRequest {
  type: 'dashboard.action.request';
  requestId: string;
  actionId: DashboardActionId;
}

export interface DashboardActionAccepted {
  type: 'dashboard.action.accepted';
  requestId: string;
  actionId: DashboardActionId;
  correlationId: string;
  acceptedAt: string;
}

export interface DashboardActionResult {
  type: 'dashboard.action.result';
  requestId: string;
  actionId: DashboardActionId;
  correlationId: string;
  status: 'success' | 'error' | 'cancelled' | 'throttled';
  message: string;
  safeErrorCategory?: SafeErrorCategory;
  retryable: boolean;
  completedAt: string;
}

export const DASHBOARD_REQUEST_ID_MAX_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const actionIdSet = new Set<string>(DASHBOARD_ACTION_IDS);

export function isDashboardActionId(value: unknown): value is DashboardActionId {
  return typeof value === 'string' && actionIdSet.has(value);
}

export function isSafeDashboardRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DASHBOARD_REQUEST_ID_MAX_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

export function isDashboardActionRequest(value: unknown): value is DashboardActionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).every(
      (key) => key === 'type' || key === 'requestId' || key === 'actionId',
    ) &&
    candidate.type === 'dashboard.action.request' &&
    isSafeDashboardRequestId(candidate.requestId) &&
    isDashboardActionId(candidate.actionId)
  );
}

export function isDashboardActionResult(value: unknown): value is DashboardActionResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).every(
      (key) =>
        key === 'type' ||
        key === 'requestId' ||
        key === 'actionId' ||
        key === 'correlationId' ||
        key === 'status' ||
        key === 'message' ||
        key === 'safeErrorCategory' ||
        key === 'retryable' ||
        key === 'completedAt',
    ) &&
    candidate.type === 'dashboard.action.result' &&
    isSafeDashboardRequestId(candidate.requestId) &&
    isDashboardActionId(candidate.actionId) &&
    typeof candidate.correlationId === 'string' &&
    /^[a-z0-9-]{8,80}$/i.test(candidate.correlationId) &&
    ['success', 'error', 'cancelled', 'throttled'].includes(String(candidate.status)) &&
    typeof candidate.message === 'string' &&
    (candidate.safeErrorCategory === undefined ||
      (typeof candidate.safeErrorCategory === 'string' &&
        SAFE_ERROR_CATEGORIES.includes(candidate.safeErrorCategory as SafeErrorCategory))) &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.completedAt === 'string'
  );
}
