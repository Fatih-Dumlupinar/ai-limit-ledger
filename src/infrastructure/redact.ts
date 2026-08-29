const SENSITIVE_FIELD =
  /((?:access[_-]?token|refresh[_-]?token|api[_-]?(?:key|token)|auth(?:orization)?|cookie|password|passwd|secret|private[_-]?key|client[_-]?secret|credential|token|pat|scope|email|account(?:id|[_-]?id)?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\x5d]+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const GITHUB_TOKEN = /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]+\b|\bgithub_pat_[A-Za-z0-9_]+\b/gi;
const JWT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const QUERY_SECRET =
  /([?&](?:access_token|refresh_token|token|api_key|apikey|authorization|code|state|scope)=)[^&#\s]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const WINDOWS_HOME = /\b[A-Z]:[\\/]Users[\\/][^\\/\s]+(?:[\\/][^\s"']*)?/gi;
const POSIX_HOME = /(?:^|[\s=(\x5b{])((?:\/Users|\/home|\/root)\/[^\s"'<>;,)}\x5d]+)/gi;
const HIGH_ENTROPY =
  /\b(?=[A-Za-z0-9_./~+-]*[A-Z])(?=[A-Za-z0-9_./~+-]*[a-z])(?=[A-Za-z0-9_./~+-]*\d)[A-Za-z0-9_./~+-]{32,}\b/g;

export interface SafeLogRedactorOptions {
  homeDirectories?: readonly string[];
  workspaceRoots?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathPatterns(values: readonly string[], fallback: RegExp): RegExp[] {
  const patterns = values
    .filter(Boolean)
    .map((value) => new RegExp(escapeRegExp(value).replace(/[\\/]$/, ''), 'gi'));
  return patterns.length > 0 ? patterns : [fallback];
}

function defaultHomeDirectories(): string[] {
  const environment = globalThis.process?.env;
  return [
    environment?.USERPROFILE,
    environment?.HOME,
    environment?.HOMEDRIVE && environment?.HOMEPATH
      ? `${environment.HOMEDRIVE}${environment.HOMEPATH}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
}

/**
 * Sanitises text before it can reach an output channel, clipboard, or support
 * bundle. This class intentionally has no permissive serialisation fallback.
 */
export class SafeLogRedactor {
  private readonly homePatterns: RegExp[];
  private readonly workspacePatterns: RegExp[];

  constructor(options: SafeLogRedactorOptions = {}) {
    this.homePatterns = pathPatterns(
      options.homeDirectories ?? defaultHomeDirectories(),
      WINDOWS_HOME,
    );
    this.workspacePatterns = pathPatterns(options.workspaceRoots ?? [], POSIX_HOME);
  }

  redact(value: string): string {
    try {
      if (typeof value !== 'string') return '[redacted]';
      let result = value;
      result = result.replace(BEARER, 'Bearer [redacted]');
      result = result.replace(GITHUB_TOKEN, '[redacted]');
      result = result.replace(JWT, '[redacted]');
      result = result.replace(SENSITIVE_FIELD, '$1[redacted]');
      result = result.replace(QUERY_SECRET, '$1[redacted]');
      result = result.replace(EMAIL, '[redacted-email]');
      result = result.replace(UUID, '[redacted-id]');
      for (const pattern of this.homePatterns) result = result.replace(pattern, '[redacted-path]');
      for (const pattern of this.workspacePatterns)
        result = result.replace(pattern, '[redacted-path]');
      result = result.replace(POSIX_HOME, '$1[redacted-path]');
      result = result.replace(HIGH_ENTROPY, '[redacted]');
      return result;
    } catch {
      return '[redacted]';
    }
  }
}

const defaultRedactor = new SafeLogRedactor();

export function redactSensitive(value: string): string {
  return defaultRedactor.redact(value);
}

export function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return redactSensitive(error.message || error.name);
    if (typeof error === 'string') return redactSensitive(error);
    return '[unknown error]';
  } catch {
    return '[unknown error]';
  }
}
