import type { SafeErrorCategory } from '../infrastructure/ProviderDiagnostics';

export type CommandInvocationSource = 'command-palette' | 'dashboard' | 'internal';

export interface CommandInvocationContext {
  source: CommandInvocationSource;
  correlationId?: string;
}

export interface CommandExecutionResult {
  status: 'success' | 'cancelled' | 'throttled' | 'error';
  safeMessage?: string;
  safeErrorCategory?: SafeErrorCategory;
  retryable?: boolean;
}

export function commandInvocationOf(value: unknown): CommandInvocationContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { source?: unknown; correlationId?: unknown };
  if (
    candidate.source !== 'command-palette' &&
    candidate.source !== 'dashboard' &&
    candidate.source !== 'internal'
  ) {
    return undefined;
  }
  if (
    candidate.correlationId !== undefined &&
    (typeof candidate.correlationId !== 'string' ||
      !/^[a-z0-9-]{8,80}$/i.test(candidate.correlationId))
  ) {
    return undefined;
  }
  return {
    source: candidate.source,
    ...(typeof candidate.correlationId === 'string'
      ? { correlationId: candidate.correlationId }
      : {}),
  };
}

export function isDashboardInvocation(value: unknown): value is CommandInvocationContext {
  return commandInvocationOf(value)?.source === 'dashboard';
}
