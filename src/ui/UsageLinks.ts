import * as vscode from 'vscode';
import type {
  CommandExecutionResult,
  CommandInvocationContext,
} from '../commands/CommandExecution';
import { ProviderLinkService } from '../links/ProviderLinkService';
import {
  getProviderLink,
  isAllowedProviderLinkUrl,
  type ProviderLinkId,
} from '../links/ProviderLinkRegistry';
import { localization } from '../localization/LocalizationService';

export const CODEX_USAGE_PAGE_URL = getProviderLink('codex-usage').url;
export const CLAUDE_USAGE_PAGE_URL = getProviderLink('claude-usage').url;
export const COPILOT_USAGE_PAGE_URL = getProviderLink('copilot-billing').url;
export const GROK_USAGE_PAGE_URL = getProviderLink('grok-billing').url;
export const GROK_INSTALL_GUIDE_URL = getProviderLink('grok-install').url;

export interface UsageLinkOptions {
  notify?: boolean;
  context?: CommandInvocationContext;
}

let configuredService: ProviderLinkService | undefined;

/** Installs the activation-scoped service used by Command Palette and Dashboard commands. */
export function setProviderLinkService(service: ProviderLinkService): void {
  configuredService = service;
}

export function clearProviderLinkService(): void {
  configuredService = undefined;
}

export function isAllowedUsagePageUrl(url: string, hostname: string): boolean {
  try {
    const parsed = new globalThis.URL(url);
    return isAllowedProviderLinkUrl(url) && parsed.hostname === hostname && parsed.href === url;
  } catch {
    return false;
  }
}

async function openRegisteredLink(
  linkId: ProviderLinkId,
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  const definition = getProviderLink(linkId);
  const service = configuredService ?? new ProviderLinkService();
  const result = await service.open(linkId, options.context ?? { source: 'command-palette' });
  if (result.status === 'success') return { status: 'success', retryable: true };
  if (options.notify ?? true)
    void vscode.window.showErrorMessage(
      localization.t('linkOpenFailed', { provider: definition.label.toLowerCase() }),
    );
  return {
    status: 'error',
    safeMessage: localization.t('officialProviderPageOpenFailed'),
    safeErrorCategory: result.safeErrorCategory,
    retryable: true,
  };
}

export function openProviderLink(
  linkId: ProviderLinkId,
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  return openRegisteredLink(linkId, options);
}

/** Opens an official provider link only after an explicit user command/button action. */
export function openCodexUsagePage(
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  return openRegisteredLink('codex-usage', options);
}

/** Opens an authenticated Claude usage settings page only after an explicit user action. */
export function openClaudeUsagePage(
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  return openRegisteredLink('claude-usage', options);
}

export function openCopilotUsagePage(
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  return openRegisteredLink('copilot-billing', options);
}

/** Grok billing is a product/account route; the Grok home page is deliberately not called usage. */
export function openGrokUsagePage(options: UsageLinkOptions = {}): Promise<CommandExecutionResult> {
  return openRegisteredLink('grok-billing', options);
}

export function openGrokInstallGuide(
  options: UsageLinkOptions = {},
): Promise<CommandExecutionResult> {
  return openRegisteredLink('grok-install', options);
}

// Compatibility aliases for callers from the first 0.3.7 implementation.
export const openCodexUsage = openCodexUsagePage;
export const openClaudeUsage = openClaudeUsagePage;
