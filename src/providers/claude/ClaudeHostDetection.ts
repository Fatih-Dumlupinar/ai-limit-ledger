/**
 * Which surface Claude Code is being used through. Only the standalone CLI on PATH and the
 * official `anthropic.claude-code` VS Code extension are detectable without reading credentials,
 * transcripts, or undocumented APIs — anything else (a third-party host, a cloud-hosted agent
 * surface, etc.) is reported as 'unknown' rather than guessed at.
 */
export type ClaudeHostKind = 'standalone-cli' | 'vscode-sidebar' | 'both' | 'unknown';

export function detectHostKind(cliFound: boolean, vscodeExtensionFound: boolean): ClaudeHostKind {
  if (cliFound && vscodeExtensionFound) return 'both';
  if (cliFound) return 'standalone-cli';
  if (vscodeExtensionFound) return 'vscode-sidebar';
  return 'unknown';
}
