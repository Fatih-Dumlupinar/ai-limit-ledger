/**
 * Deliberately small allowlist for the user-facing cache-clear command.
 * SecretStorage, consent, provider selection, recovery ownership and settings
 * are intentionally absent from this list.
 */
export const CACHE_CLEAR_ALLOWLIST = [
  'aiLimitLedger.claude.experimentalOAuthUsage.lastKnownGood',
  'aiLimitLedger.claude.oauthUsageLastFetchAt',
  'aiLimitLedger.claude.oauthUsageBackoff',
  'aiLimitLedger.claude.oauthUsageRefreshLease',
  'aiLimitLedger.copilot.billingRefreshLease',
  'aiLimitLedger.grok.billingRefreshLease',
  'aiLimitLedger.refreshLease',
] as const;

export interface CacheGlobalState {
  update(key: string, value: undefined): PromiseLike<void> | Promise<void>;
}

export async function clearAllowedCaches(globalState: CacheGlobalState): Promise<void> {
  for (const key of CACHE_CLEAR_ALLOWLIST) await globalState.update(key, undefined);
}
