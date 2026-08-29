import { safeErrorMessage } from './redact';

export const SAFE_ERROR_CATEGORIES = [
  'authentication-required',
  'authorization-failed',
  'rate-limited',
  'network-unavailable',
  'process-not-found',
  'process-start-failed',
  'protocol-error',
  'method-not-supported',
  'invalid-response',
  'configuration-error',
  'external-change',
  'security-validation-failed',
  'cancelled',
  'throttled',
  'executable-not-found',
  'process-exited',
  'initialize-failed',
  'transport-error',
  'account-read-failed',
  'rate-limits-read-failed',
  'usage-read-failed',
  'timeout',
  'not-authenticated',
  'permission-denied',
  'upstream-unavailable',
  'unknown',
] as const;

export type SafeErrorCategory = (typeof SAFE_ERROR_CATEGORIES)[number];
export type DiagnosticTransport = 'timeout' | 'cancelled' | 'protocol' | 'transport' | 'process';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface SafeLogFields {
  correlationId?: string;
  providerId?: string;
  action?: string;
  stage?: string;
  category?: SafeErrorCategory | string;
  durationMs?: number;
  attempt?: number;
  retryAt?: number | string;
  availability?: string;
  message: string;
}

export interface ProviderDiagnostic {
  providerId: string;
  stage: string;
  method?: string;
  category: SafeErrorCategory;
  transport?: DiagnosticTransport;
  exitCode?: number | null;
  checkedAt: number;
  retryAvailable: boolean;
}

export interface DiagnosticLogger {
  error(message: string): void;
  logRecord?(level: LogLevel, fields: SafeLogFields): void;
  createCorrelationId?(): string;
}

export class SafeDiagnosticError extends Error {
  constructor(
    readonly category: SafeErrorCategory,
    message: string = category,
    readonly method?: string,
    readonly exitCode?: number | null,
    readonly transport?: DiagnosticTransport,
  ) {
    super(message);
    this.name = 'SafeDiagnosticError';
  }
}

function statusOf(error: object): number | undefined {
  const value =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

export function safeCategoryOf(
  error: unknown,
  fallback: SafeErrorCategory = 'unknown',
): SafeErrorCategory {
  if (error instanceof SafeDiagnosticError) return error.category;
  if (typeof error === 'object' && error !== null) {
    const category = (error as { category?: unknown }).category;
    if (
      typeof category === 'string' &&
      SAFE_ERROR_CATEGORIES.includes(category as SafeErrorCategory)
    ) {
      return category as SafeErrorCategory;
    }

    const status = statusOf(error);
    if (status === 401) return 'authentication-required';
    if (status === 403) return 'authorization-failed';
    if (status === 404) return 'method-not-supported';
    if (status === 408) return 'timeout';
    if (status === 429) return 'rate-limited';
    if (status !== undefined && status >= 500 && status <= 599) return 'network-unavailable';
  }

  const text = safeErrorMessage(error).toLowerCase();
  if (text.includes('401') || text.includes('authentication required'))
    return 'authentication-required';
  if (text.includes('403') || text.includes('authorization failed') || text.includes('forbidden'))
    return 'authorization-failed';
  if (
    text.includes('404') ||
    text.includes('method not supported') ||
    text.includes('not implemented')
  )
    return 'method-not-supported';
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests'))
    return 'rate-limited';
  if (text.includes('throttl')) return 'throttled';
  if (text.includes('timeout')) return 'timeout';
  if (text.includes('cancel')) return 'cancelled';
  if (text.includes('not authenticated') || text.includes('unauthenticated'))
    return 'not-authenticated';
  if (text.includes('redirect') && (text.includes('reject') || text.includes('invalid')))
    return 'security-validation-failed';
  if (
    text.includes('security') ||
    text.includes('certificate') ||
    text.includes('credential validation')
  )
    return 'security-validation-failed';
  if (
    text.includes('invalid response') ||
    text.includes('response validation') ||
    text.includes('content-type') ||
    text.includes('response too large') ||
    text.includes('response size')
  )
    return 'invalid-response';
  if (text.includes('network') || text.includes('unavailable') || /\b5\d{2}\b/.test(text))
    return 'network-unavailable';
  if (text.includes('enoent')) return 'process-not-found';
  if (text.includes('spawn')) return 'process-start-failed';
  if (text.includes('exited') || text.includes('connection closed')) return 'process-exited';
  if (text.includes('json') || text.includes('protocol')) return 'protocol-error';
  return fallback;
}

export const classifyErrorCategory = safeCategoryOf;
export const classifySafeError = safeCategoryOf;

export function diagnosticForError(
  providerId: string,
  stage: string,
  error: unknown,
  options: {
    method?: string;
    category?: SafeErrorCategory;
    retryAvailable?: boolean;
    checkedAt?: number;
  } = {},
): ProviderDiagnostic {
  const category = safeCategoryOf(error, options.category ?? 'unknown');
  const safeError = error instanceof SafeDiagnosticError ? error : undefined;
  return {
    providerId,
    stage,
    ...((options.method ?? safeError?.method)
      ? { method: options.method ?? safeError?.method }
      : {}),
    category,
    ...(safeError?.transport ? { transport: safeError.transport } : {}),
    ...(safeError?.exitCode !== undefined ? { exitCode: safeError.exitCode } : {}),
    checkedAt: options.checkedAt ?? Date.now(),
    retryAvailable: options.retryAvailable ?? true,
  };
}

export function formatDiagnostic(diagnostic: ProviderDiagnostic): string {
  return JSON.stringify(diagnostic);
}
