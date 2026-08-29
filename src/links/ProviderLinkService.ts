import * as vscode from 'vscode';
import type { CommandInvocationContext } from '../commands/CommandExecution';
import { safeCategoryOf, type SafeErrorCategory } from '../infrastructure/ProviderDiagnostics';
import type { Logger } from '../infrastructure/Logger';
import {
  getProviderLink,
  isAllowedProviderLinkUrl,
  PROVIDER_LINK_REGISTRY,
  validateProviderLinkDefinitions,
  type ProviderLinkCategory,
  type ProviderLinkId,
} from './ProviderLinkRegistry';

export interface ProviderLinkOpenResult {
  readonly status: 'success' | 'error';
  readonly linkId: ProviderLinkId;
  readonly safeErrorCategory?: SafeErrorCategory;
}

export interface ProviderLinkDiagnosticsSnapshot {
  readonly registryVersion: string;
  readonly definitionCount: number;
  readonly validation: 'passed' | 'failed';
  readonly invalidLinkIds: readonly string[];
  readonly lastOpenedLinkId: string | null;
  readonly lastLinkOpenResult: 'success' | 'error' | null;
}

const registryValidation = validateProviderLinkDefinitions(PROVIDER_LINK_REGISTRY);
let linkDiagnostics: ProviderLinkDiagnosticsSnapshot = {
  registryVersion: '1',
  definitionCount: PROVIDER_LINK_REGISTRY.length,
  validation: registryValidation.valid ? 'passed' : 'failed',
  invalidLinkIds: registryValidation.issues
    .filter((issue) => issue.startsWith('invalid-url:'))
    .map((issue) => issue.split(':')[1] ?? 'unknown'),
  lastOpenedLinkId: null,
  lastLinkOpenResult: null,
};

export function getProviderLinkDiagnosticsSnapshot(): ProviderLinkDiagnosticsSnapshot {
  return { ...linkDiagnostics, invalidLinkIds: [...linkDiagnostics.invalidLinkIds] };
}

export interface ProviderLinkLogger {
  createCorrelationId(): string;
  logRecord(
    level: 'info' | 'error',
    fields: {
      correlationId?: string;
      providerId?: string;
      action?: string;
      stage?: string;
      category?: SafeErrorCategory;
      durationMs?: number;
      message: string;
    },
  ): void;
}

function fallbackCorrelationId(): string {
  return `provider-link-${Date.now().toString(36)}`;
}

const noopLogger: ProviderLinkLogger = {
  createCorrelationId: fallbackCorrelationId,
  logRecord: () => undefined,
};

function logStage(category: ProviderLinkCategory): string {
  return `provider-link.${category}`;
}

/** Opens only immutable URLs from ProviderLinkRegistry after a second runtime validation. */
export class ProviderLinkService {
  private readonly logger: ProviderLinkLogger;
  private readonly openExternal: typeof vscode.env.openExternal;

  constructor(
    logger: Pick<Logger, 'createCorrelationId' | 'logRecord'> = noopLogger,
    openExternal: typeof vscode.env.openExternal = vscode.env.openExternal,
  ) {
    this.logger = logger;
    this.openExternal = openExternal;
  }

  async open(
    linkId: ProviderLinkId,
    context: CommandInvocationContext,
  ): Promise<ProviderLinkOpenResult> {
    const startedAt = Date.now();
    const correlationId = context.correlationId ?? this.logger.createCorrelationId();
    const definition = getProviderLinkSafely(linkId);
    if (!definition || !isAllowedProviderLinkUrl(definition.url)) {
      linkDiagnostics = {
        ...linkDiagnostics,
        lastOpenedLinkId: String(linkId),
        lastLinkOpenResult: 'error',
      };
      this.log(
        'error',
        correlationId,
        startedAt,
        definition?.providerId,
        linkId,
        'security-validation-failed',
        'Provider link validation failed.',
      );
      return { status: 'error', linkId, safeErrorCategory: 'security-validation-failed' };
    }

    try {
      const opened = await this.openExternal(vscode.Uri.parse(definition.url));
      if (!opened) {
        linkDiagnostics = {
          ...linkDiagnostics,
          lastOpenedLinkId: definition.id,
          lastLinkOpenResult: 'error',
        };
        this.log(
          'error',
          correlationId,
          startedAt,
          definition.providerId,
          definition.id,
          'upstream-unavailable',
          'Provider link was not accepted by the external opener.',
        );
        return { status: 'error', linkId, safeErrorCategory: 'upstream-unavailable' };
      }
      linkDiagnostics = {
        ...linkDiagnostics,
        lastOpenedLinkId: definition.id,
        lastLinkOpenResult: 'success',
      };
      this.log(
        'info',
        correlationId,
        startedAt,
        definition.providerId,
        definition.id,
        undefined,
        'Provider link was handed to the default browser.',
      );
      return { status: 'success', linkId };
    } catch (error) {
      linkDiagnostics = {
        ...linkDiagnostics,
        lastOpenedLinkId: definition.id,
        lastLinkOpenResult: 'error',
      };
      const category = safeCategoryOf(error, 'upstream-unavailable');
      this.log(
        'error',
        correlationId,
        startedAt,
        definition.providerId,
        definition.id,
        category,
        'Provider link open failed.',
      );
      return { status: 'error', linkId, safeErrorCategory: category };
    }
  }

  private log(
    level: 'info' | 'error',
    correlationId: string,
    startedAt: number,
    providerId: string | undefined,
    linkId: ProviderLinkId,
    category: SafeErrorCategory | undefined,
    message: string,
  ): void {
    this.logger.logRecord(level, {
      correlationId,
      ...(providerId ? { providerId } : {}),
      action: 'provider-link.open',
      stage: providerId ? logStage(getProviderLink(linkId).category) : 'provider-link.validation',
      ...(category ? { category } : {}),
      durationMs: Date.now() - startedAt,
      message: `${message} Link ID: ${linkId}.`,
    });
  }
}

function getProviderLinkSafely(id: ProviderLinkId) {
  try {
    return getProviderLink(id);
  } catch {
    return undefined;
  }
}
