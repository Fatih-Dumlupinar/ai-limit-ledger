import * as vscode from 'vscode';
import type { SafeErrorCategory } from './ProviderDiagnostics';
import { localization } from '../localization/LocalizationService';

export interface SafeErrorPresentationInput {
  providerName: string;
  action: string;
  category: SafeErrorCategory;
  retry?: () => void | Promise<void>;
  diagnose?: () => void | Promise<void>;
  automatic?: boolean;
}

export type SafeErrorAction = string;

export function safeActionMessage(
  input: Pick<SafeErrorPresentationInput, 'providerName' | 'action' | 'category'>,
): string {
  const provider = input.providerName || 'Provider';
  const action = input.action || 'complete this action';
  const signIn = localization.t('signInRequired').toLowerCase();
  const unavailable = localization.t('unavailable').toLowerCase();
  const rateLimited = localization.t('rateLimited').toLowerCase();
  switch (input.category) {
    case 'authentication-required':
    case 'not-authenticated':
      return `${provider} ${signIn} before it can ${action}.`;
    case 'authorization-failed':
    case 'permission-denied':
      return `${provider} did not authorize this ${action}. Check the provider account or permissions.`;
    case 'rate-limited':
    case 'throttled':
      return `${provider} is temporarily ${rateLimited}. It will retry when allowed.`;
    case 'network-unavailable':
    case 'upstream-unavailable':
    case 'timeout':
      return `${provider} could not ${action} because the provider is temporarily ${unavailable}.`;
    case 'process-not-found':
    case 'executable-not-found':
      return `${provider} could not ${action} because its CLI was not found.`;
    case 'process-start-failed':
      return `${provider} could not start its local integration.`;
    case 'security-validation-failed':
      return `${provider} was rejected by a security validation check. Review the safe logs.`;
    case 'configuration-error':
      return `${provider} needs a configuration change before it can ${action}.`;
    case 'cancelled':
      return '';
    default:
      return `${provider} could not ${action}. Review the safe logs for details.`;
  }
}

interface PresenterOptions {
  cooldownMs?: number;
  now?: () => number;
  notify?: (
    message: string,
  ) => PromiseLike<SafeErrorAction | undefined> | Promise<SafeErrorAction | undefined>;
  showLogs?: () => void;
  level?: 'off' | 'errors' | 'warnings-and-errors';
  showRecoveryActions?: boolean;
}

/** Turns provider failures into bounded, action-oriented UI without exposing exceptions. */
export class SafeErrorPresenter {
  private readonly lastShown = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly notify: NonNullable<PresenterOptions['notify']>;
  private level: 'off' | 'errors' | 'warnings-and-errors';
  private showRecoveryActions: boolean;

  constructor(options: PresenterOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.notify =
      options.notify ??
      ((message) =>
        vscode.window.showErrorMessage(
          message,
          localization.t('showLogs'),
          localization.t('retry'),
          localization.t('diagnose'),
        ));
    this.showLogs = options.showLogs ?? (() => undefined);
    this.level = options.level ?? 'errors';
    this.showRecoveryActions = options.showRecoveryActions ?? true;
  }

  readonly showLogs: () => void;

  setPolicy(level: 'off' | 'errors' | 'warnings-and-errors', showRecoveryActions = true): void {
    this.level = level;
    this.showRecoveryActions = showRecoveryActions;
  }

  shouldNotify(input: SafeErrorPresentationInput): boolean {
    if (this.level === 'off') return false;
    if (this.level === 'errors' && isWarningCategory(input.category)) return false;
    if (
      input.category === 'cancelled' ||
      input.category === 'rate-limited' ||
      input.category === 'throttled'
    ) {
      return false;
    }
    const key = `${input.providerName}:${input.action}:${input.category}`;
    const previous = this.lastShown.get(key) ?? -Infinity;
    const current = this.now();
    if (current - previous < this.cooldownMs) return false;
    this.lastShown.set(key, current);
    return true;
  }

  async present(input: SafeErrorPresentationInput): Promise<void> {
    const message = safeActionMessage(input);
    if (!message || !this.shouldNotify(input)) return;
    const choice = this.showRecoveryActions
      ? await this.notify(message)
      : await vscode.window.showErrorMessage(message);
    if (!this.showRecoveryActions) return;
    if (choice === localization.t('showLogs')) this.showLogs();
    if (choice === localization.t('retry')) await input.retry?.();
    if (choice === localization.t('diagnose')) await input.diagnose?.();
  }
}

function isWarningCategory(category: SafeErrorCategory): boolean {
  return (
    category === 'rate-limited' ||
    category === 'throttled' ||
    category === 'network-unavailable' ||
    category === 'upstream-unavailable' ||
    category === 'timeout'
  );
}
