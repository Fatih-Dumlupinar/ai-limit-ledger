import type { DashboardActionId } from './DashboardActionProtocol';

export type DashboardIconId =
  | 'refresh'
  | 'settings'
  | 'external-link'
  | 'more'
  | 'diagnose'
  | 'restart'
  | 'connect'
  | 'enable'
  | 'disable'
  | 'repair'
  | 'install'
  | 'terminal'
  | 'copy'
  | 'export'
  | 'logs'
  | 'check'
  | 'error'
  | 'warning'
  | 'info';

/**
 * Fixed SVG path data. Values in this registry are extension-owned source code;
 * they are never selected from a webview message or provider response.
 */
export const DASHBOARD_ICON_REGISTRY = {
  refresh:
    '<path d="M13.25 6.25A5.5 5.5 0 1 0 14 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.25 2.75v3.5h-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  settings:
    '<circle cx="8" cy="8" r="2.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.58 3.58 5 5M11 11l1.42 1.42M12.42 3.58 11 5M5 11l-1.42 1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  'external-link':
    '<path d="M9 2.5h4.5V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="m13.25 2.75-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 9.5v3A1.5 1.5 0 0 1 10.5 14h-6A1.5 1.5 0 0 1 3 12.5v-6A1.5 1.5 0 0 1 4.5 5h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  more: '<circle cx="3.25" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.75" cy="8" r="1.25" fill="currentColor"/>',
  diagnose:
    '<circle cx="7" cy="7" r="4" stroke="currentColor" stroke-width="1.5"/><path d="m10 10 3.5 3.5M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  restart:
    '<path d="M13.25 6A5.5 5.5 0 1 0 14 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.25 2.75V6h-3.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  connect:
    '<path d="m6.25 9.75 3.5-3.5M5 6.75l-1.5 1.5a2.65 2.65 0 0 0 3.75 3.75l1.5-1.5M11 9.25l1.5-1.5a2.65 2.65 0 0 0-3.75-3.75l-1.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  enable:
    '<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  disable:
    '<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.5"/><path d="M5 8h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  repair:
    '<path d="M9.75 3.25a3.25 3.25 0 0 0-4.2 4.2L2.5 10.5a1.77 1.77 0 1 0 2.5 2.5l3.05-3.05a3.25 3.25 0 0 0 4.2-4.2l-2.1 2.1-1.5-.5-.5-1.5 2.1-2.1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  install:
    '<path d="M8 2.25v7.5M5 7.25 8 10.5l3-3.25M3 12.75h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  terminal:
    '<rect x="2" y="3" width="12" height="10" rx="1.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m4.5 6 2 2-2 2M8 10h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="5" y="5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.75A1.75 1.75 0 0 0 9.25 2h-5.5A1.75 1.75 0 0 0 2 3.75v5.5A1.75 1.75 0 0 0 3.75 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  export:
    '<path d="M8 10.5V2.75M5 5.75 8 2.5l3 3.25M3 9.75v2.5A1.75 1.75 0 0 0 4.75 14h6.5A1.75 1.75 0 0 0 13 12.25v-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  logs: '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  check:
    '<path d="m3.25 8.25 3.1 3.1 6.4-6.7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  error:
    '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.75v4M8 11.25v.1" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>',
  warning:
    '<path d="m8 2.25 6 11H2l6-11Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v3M8 11v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  info: '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.25v3.5M8 4.9v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
} as const satisfies Record<DashboardIconId, string>;

export const DASHBOARD_ICON_IDS = Object.keys(DASHBOARD_ICON_REGISTRY) as DashboardIconId[];

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function isDashboardIconId(value: string): value is DashboardIconId {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_ICON_REGISTRY, value);
}

export function renderDashboardIcon(
  iconId: DashboardIconId,
  options: { className?: string; label?: string } = {},
): string {
  const pathData = DASHBOARD_ICON_REGISTRY[iconId];
  if (!pathData) return '';
  const className = options.className ? `dashboard-icon ${options.className}` : 'dashboard-icon';
  const accessibleName = options.label
    ? `role="img" aria-label="${escapeAttribute(options.label)}"`
    : 'aria-hidden="true"';
  return `<svg class="${escapeAttribute(className)}" viewBox="0 0 16 16" width="16" height="16" fill="none" focusable="false" ${accessibleName}>${pathData}</svg>`;
}

export const DASHBOARD_ACTION_ICON_IDS: Readonly<Record<DashboardActionId, DashboardIconId>> = {
  'refresh-all': 'refresh',
  'refresh-codex': 'refresh',
  'refresh-claude': 'refresh',
  'refresh-copilot': 'refresh',
  'refresh-grok': 'refresh',
  'open-provider-settings': 'settings',
  'show-logs': 'logs',
  'copy-redacted-diagnostics': 'copy',
  'export-redacted-support-bundle': 'export',
  'restart-codex-app-server': 'restart',
  'diagnose-codex': 'diagnose',
  'open-codex-usage': 'external-link',
  'enable-claude': 'enable',
  'disable-claude': 'disable',
  'repair-claude': 'repair',
  'recheck-claude': 'diagnose',
  'diagnose-claude': 'diagnose',
  'open-claude-usage': 'external-link',
  'open-claude-install-guide': 'install',
  'launch-claude-terminal': 'terminal',
  'copy-claude-diagnostics': 'copy',
  'open-claude-code': 'external-link',
  'copy-claude-usage': 'copy',
  'open-claude-enhanced-mode-docs': 'external-link',
  'enable-claude-auto-repair': 'enable',
  'disable-claude-auto-repair': 'disable',
  'enable-claude-oauth': 'enable',
  'disable-claude-oauth': 'disable',
  'open-claude-oauth-docs': 'external-link',
  'connect-copilot': 'connect',
  'disconnect-copilot': 'disable',
  'configure-copilot-plan': 'settings',
  'diagnose-copilot': 'diagnose',
  'open-copilot-usage': 'external-link',
  'enable-copilot-experimental': 'enable',
  'disable-copilot-experimental': 'disable',
  'enable-grok': 'enable',
  'disable-grok': 'disable',
  'recheck-grok': 'diagnose',
  'launch-grok-login': 'terminal',
  'diagnose-grok': 'diagnose',
  'open-grok-install-guide': 'install',
  'open-grok-usage': 'external-link',
  'copy-grok-usage': 'copy',
  'enable-grok-experimental': 'enable',
  'disable-grok-experimental': 'disable',
};

export function getDashboardActionIconId(actionId: DashboardActionId): DashboardIconId {
  return DASHBOARD_ACTION_ICON_IDS[actionId];
}
