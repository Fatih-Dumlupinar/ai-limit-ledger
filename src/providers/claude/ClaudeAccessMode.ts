import type { ClaudeHostKind } from './ClaudeHostDetection';

/**
 * How the user is actually using Claude Code — distinct from whether automatic usage-data
 * collection works. `vscode-extension` is fully implemented in 0.3.5; `standalone-cli` and
 * `hybrid` reuse the same detection today but gain no new CLI-dependent behavior until the
 * user opts into installing the CLI in a later release.
 */
export type ClaudeAccessMode = 'vscode-extension' | 'standalone-cli' | 'hybrid' | 'unavailable';

export function deriveAccessMode(hostKind: ClaudeHostKind): ClaudeAccessMode {
  switch (hostKind) {
    case 'standalone-cli':
      return 'standalone-cli';
    case 'vscode-sidebar':
      return 'vscode-extension';
    case 'both':
      return 'hybrid';
    default:
      return 'unavailable';
  }
}
