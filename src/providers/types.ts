import type { Event } from 'vscode';
import type { ProviderDiagnostic, SafeErrorCategory } from '../infrastructure/ProviderDiagnostics';
import type { ProviderUsageInsights } from './UsageInsights';

export type ProviderId = 'codex' | 'claude' | 'copilot' | 'grok';

export type ProviderAvailability =
  | 'initializing'
  | 'startup-error'
  | 'not-selected'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'integration-required'
  | 'integration-disabled'
  | 'restart-required'
  | 'configuration-shadowed'
  | 'repair-required'
  | 'waiting-for-first-response'
  | 'manual-only'
  | 'upstream-statusline-not-invoked'
  | 'unsupported-surface'
  | 'stale'
  | 'incompatible-cli'
  | 'external-change'
  | 'warning'
  | 'critical'
  | 'rate-limited'
  | 'error'
  | 'ready-experimental'
  | 'stale-experimental'
  | 'rate-limited-experimental'
  | 'authentication-required'
  | 'consent-required'
  | 'ready-calculated'
  | 'plan-configuration-required'
  | 'organization-managed'
  | 'cli-detected'
  | 'extension-detected'
  | 'cli-not-installed'
  | 'connected-no-billing-method'
  | 'method-not-supported'
  | 'manual-only'
  | 'disabled';
export type ProviderSource =
  | 'Official Codex App Server'
  | 'Official Claude Code status-line'
  | 'Experimental — undocumented Anthropic usage endpoint'
  | 'Official GitHub Billing REST API'
  | 'Experimental — GitHub Copilot entitlement endpoint'
  | 'Official Grok Build billing capability (x.ai/billing)'
  | 'Experimental — Grok Build billing extension'
  | 'Not connected';
export interface ProviderCapabilities {
  rateLimits: boolean;
  usage: boolean;
  statusLine: boolean;
}
export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
  windowDurationMinutes: number | null;
}
export interface ProviderHealth {
  state: ProviderAvailability;
  warning?: string;
  error?: string;
  errorCategory?: SafeErrorCategory;
  safeErrorCategory?: SafeErrorCategory;
  retryAt?: number;
  diagnostics?: ProviderDiagnostic[];
}
export interface ProviderSnapshot {
  providerId: string;
  providerName: string;
  availability: ProviderAvailability;
  connected: boolean;
  plan: string | null;
  cliVersion: string | null;
  extensionVersion?: string | null;
  usageWindows: UsageWindow[];
  /** Provider-specific allowance/cost summary. It is intentionally optional for legacy providers. */
  credits?: ProviderCredits;
  tokens?: Record<string, number | null>;
  source: ProviderSource;
  /** When the underlying real data (if any) was captured/observed. */
  observedAt: number;
  /** When AI Limit Ledger last checked this provider, whether or not that check produced real data. Falls back to `observedAt` in the UI when absent. */
  checkedAt?: number;
  /** When any valid provider data was last observed. */
  lastSuccessfulDataUpdate?: number;
  /** Version-neutral alias used by the 0.4 provider contract. */
  lastSuccessfulUpdateAt?: number;
  /**
   * When the upstream data itself was produced by the provider (Claude: the wrapper's own
   * embedded write time; Codex: not distinct from `observedAt`, omitted). Distinct from
   * `checkedAt`/`observedAt`, which are AI Limit Ledger's own read/parse times.
   */
  sourceUpdatedAt?: number | null;
  /** Human-readable provenance, kept separate from the short source label. */
  provenance?: string;
  /** When the last provider-pushed event was received (Codex: `account/rateLimits/updated`; Claude: the wrapper's own invocation). */
  lastProviderEventAt?: number | null;
  /** Estimated time of the next unconditional fallback refresh, when the provider polls on a timer. Null when refresh is purely event/watcher-driven. */
  nextFallbackRefreshAt?: number | null;
  stale: boolean;
  warning?: string;
  error?: string;
  errorCategory?: SafeErrorCategory;
  safeErrorCategory?: SafeErrorCategory;
  retryAt?: number;
  diagnostics?: ProviderDiagnostic[];
  capabilities: ProviderCapabilities;
  /** Typed, provider-scoped usage details. Never contains raw provider responses. */
  usageInsights?: ProviderUsageInsights;
  metadata?: Record<string, string | boolean | number | null>;
}

export interface ProviderCredits {
  used: number | null;
  included?: number | null;
  additional?: number | null;
  remaining?: number | null;
  cost?: number | null;
  currency?: string | null;
  allowance?: number | null;
  allowanceSource?: string | null;
}
export interface RefreshPolicy {
  minimumIntervalMs: number;
  automaticIntervalMs: number;
}
export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  detect(): Promise<boolean>;
  start(): Promise<void>;
  stop(): void;
  refresh(force?: boolean): Promise<ProviderSnapshot | undefined>;
  getSnapshot(): ProviderSnapshot | undefined;
  onDidChange: Event<ProviderSnapshot>;
  getDiagnostics(): ProviderHealth;
}
