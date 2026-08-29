export type StatusLineScope = 'project-local' | 'project-shared' | 'user' | 'none';

export interface EffectiveStatusLineResult {
  effectiveStatusLine: unknown;
  winningScope: StatusLineScope;
}

/**
 * Resolves which statusLine value actually takes effect, following Claude Code's documented
 * precedence for the sources AI Limit Ledger can read without elevated access: project local
 * (`.claude/settings.local.json`) outranks project shared (`.claude/settings.json`), which
 * outranks user (`~/.claude/settings.json`). Managed/policy and `--settings` CLI overrides are
 * outside what a VS Code extension can observe and are not modeled here.
 */
export function resolveEffectiveStatusLine(
  userStatusLine: unknown,
  projectSharedStatusLine: unknown,
  projectLocalStatusLine: unknown,
): EffectiveStatusLineResult {
  if (projectLocalStatusLine !== undefined) {
    return { effectiveStatusLine: projectLocalStatusLine, winningScope: 'project-local' };
  }
  if (projectSharedStatusLine !== undefined) {
    return { effectiveStatusLine: projectSharedStatusLine, winningScope: 'project-shared' };
  }
  if (userStatusLine !== undefined) {
    return { effectiveStatusLine: userStatusLine, winningScope: 'user' };
  }
  return { effectiveStatusLine: undefined, winningScope: 'none' };
}
