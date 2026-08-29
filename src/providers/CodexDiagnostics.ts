import type { CodexIntegrationDiagnostics } from './CodexProvider';

function redactUserPath(value: string): string {
  const userRoots = [process.env.USERPROFILE, process.env.HOME].filter((root): root is string =>
    Boolean(root),
  );
  return userRoots
    .reduce((redacted, root) => redacted.replaceAll(root, '<USER_HOME>'), value)
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, '<USER_HOME>');
}

/** Formats only the safe, structured Codex diagnostic fields for the output channel. */
export function formatCodexDiagnostics(report: CodexIntegrationDiagnostics): string {
  const lines = [
    `providerId: codex`,
    `selected: ${report.selected}`,
    `enabled: ${report.enabled}`,
    `resolvedExecutablePath: ${report.resolvedExecutablePath ? redactUserPath(report.resolvedExecutablePath) : 'not configured'}`,
    `executableExists: ${report.executableExists}`,
    `cliVersion: ${report.cliVersion ?? 'not available'}`,
    `processState: ${report.processState}`,
    `processStartedAt: ${report.processStartedAt ? new Date(report.processStartedAt).toISOString() : 'not started'}`,
    `processExitCode: ${report.processExitCode ?? 'not available'}`,
    `initialized: ${report.initialized}`,
    `protocolVersion: ${report.protocolVersion ?? 'not available'}`,
    `lastSuccessfulSnapshotTime: ${report.lastSuccessfulSnapshotTime ? new Date(report.lastSuccessfulSnapshotTime).toISOString() : 'not available'}`,
    `lastSafeErrorCategory: ${report.lastSafeErrorCategory ?? 'none'}`,
    `stale: ${report.stale}`,
    `nextRetryAt: ${report.nextRetryAt ? new Date(report.nextRetryAt).toISOString() : 'not scheduled'}`,
    `recommendedAction: ${report.recommendedAction}`,
    `rateLimitsSubscriptionActive: ${report.rateLimitsSubscriptionActive}`,
    `lastNotificationTime: ${report.lastNotificationTime ? new Date(report.lastNotificationTime).toISOString() : 'none received'}`,
    `fallbackIntervalMs: ${report.fallbackIntervalMs}`,
    `singleFlightActive: ${report.singleFlightActive}`,
    `consecutiveFailures: ${report.consecutiveFailures}`,
    `parsedWindowCount: ${report.parsedWindowCount}`,
    'requestStatus:',
  ];
  for (const [method, status] of Object.entries(report.requestStatus ?? {}))
    lines.push(`  ${method}: ${status}`);
  return lines.join('\n');
}
