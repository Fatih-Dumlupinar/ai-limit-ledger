/**
 * Whether documented usage data is actually flowing, independent of whether Claude Code itself
 * is available. A user can have a perfectly valid, connected Claude integration while automatic
 * account-limit tracking is unavailable on their current host.
 */
export type ClaudeUsageCapability =
  'automatic-live' | 'automatic-checking' | 'manual-only' | 'not-available';
