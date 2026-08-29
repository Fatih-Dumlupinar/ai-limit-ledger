/** Centralized shell-quoting helpers for the generated wrapper scripts. */

/** Escapes a string for use inside a PowerShell single-quoted literal: '' escapes a single quote. */
export function powerShellSingleQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escapes a string for use inside a POSIX single-quoted shell literal: close, escaped quote, reopen. */
export function posixSingleQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escapes a string for embedding inside a JavaScript single-quoted string literal in a generated .js wrapper. */
export function jsSingleQuoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}
