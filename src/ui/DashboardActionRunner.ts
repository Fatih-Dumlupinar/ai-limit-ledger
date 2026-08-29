import type { Logger } from '../infrastructure/Logger';
import {
  SAFE_ERROR_CATEGORIES,
  safeCategoryOf,
  type SafeErrorCategory,
} from '../infrastructure/ProviderDiagnostics';
import {
  type CommandExecutionResult,
  type CommandInvocationContext,
} from '../commands/CommandExecution';
import {
  isDashboardActionRequest,
  type DashboardActionAccepted,
  type DashboardActionId,
  type DashboardActionRequest,
  type DashboardActionResult,
} from './DashboardActionProtocol';
import {
  getDashboardActionDefinition,
  type DashboardActionDefinition,
} from './DashboardActionRegistry';
import { localization } from '../localization/LocalizationService';
import { EN } from '../localization/locales/en';
import { TR } from '../localization/locales/tr';
import type { RuntimeLanguage } from '../localization/LocalizationService';

export type ActionVisualState =
  'idle' | 'submitting' | 'working' | 'success' | 'error' | 'cancelled' | 'throttled';

export interface DashboardActionState {
  actionId: DashboardActionId;
  requestId: string;
  correlationId: string;
  state: ActionVisualState;
  message: string;
  retryable: boolean;
  safeErrorCategory?: SafeErrorCategory;
  completedAt?: string;
}

export interface DashboardActionRunnerOptions {
  logger: Pick<Logger, 'createCorrelationId' | 'logRecord' | 'redact'>;
  execute: (commandId: string, context: CommandInvocationContext) => Promise<unknown>;
  postMessage?: (message: DashboardActionAccepted | DashboardActionResult) => void | Promise<void>;
  now?: () => Date;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

interface ActiveRequest {
  request: DashboardActionRequest;
  definition: DashboardActionDefinition;
  correlationId: string;
  startedAt: number;
  mutexGroup?: string;
  sequence: number;
}

const MAX_REQUEST_HISTORY = 128;
const MAX_ACTION_STATES = 64;
const SUCCESS_STATE_TTL_MS = 2_000;

function isSafeErrorCategory(value: unknown): value is SafeErrorCategory {
  return typeof value === 'string' && SAFE_ERROR_CATEGORIES.includes(value as SafeErrorCategory);
}

function isCommandExecutionResult(value: unknown): value is CommandExecutionResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    ['success', 'cancelled', 'throttled', 'error'].includes(String(candidate.status)) &&
    (candidate.safeMessage === undefined || typeof candidate.safeMessage === 'string') &&
    (candidate.safeErrorCategory === undefined ||
      isSafeErrorCategory(candidate.safeErrorCategory)) &&
    (candidate.retryable === undefined || typeof candidate.retryable === 'boolean')
  );
}

function safeResultMessage(
  definition: DashboardActionDefinition,
  status: DashboardActionResult['status'],
  category: SafeErrorCategory | undefined,
  candidateMessage: unknown,
  redact: (value: string) => string,
): string {
  if (status === 'success') return definition.successMessage;
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'throttled') return 'Try again later';
  if (typeof candidateMessage === 'string' && candidateMessage.length > 0) {
    const redacted = redact(candidateMessage).slice(0, 200);
    if (redacted.length > 0) return redacted;
  }
  if (category === 'authentication-required' || category === 'not-authenticated')
    return 'Sign-in is required.';
  if (category === 'security-validation-failed') return 'Security validation failed.';
  return 'Failed';
}

function normalizeResult(
  definition: DashboardActionDefinition,
  value: unknown,
  redact: (value: string) => string,
): Omit<
  DashboardActionResult,
  'type' | 'requestId' | 'actionId' | 'correlationId' | 'completedAt'
> {
  const commandResult = isCommandExecutionResult(value) ? value : { status: 'success' as const };
  const category = isSafeErrorCategory(commandResult.safeErrorCategory)
    ? commandResult.safeErrorCategory
    : undefined;
  const status: DashboardActionResult['status'] =
    commandResult.status === 'cancelled'
      ? 'cancelled'
      : commandResult.status === 'throttled' ||
          category === 'throttled' ||
          category === 'rate-limited'
        ? 'throttled'
        : commandResult.status === 'error'
          ? 'error'
          : 'success';
  return {
    status,
    message: safeResultMessage(definition, status, category, commandResult.safeMessage, redact),
    ...(category ? { safeErrorCategory: category } : {}),
    retryable:
      status === 'cancelled' || category === 'security-validation-failed'
        ? false
        : (commandResult.retryable ?? definition.retryable),
  };
}

/** Host-owned action protocol, replay protection and single-flight runner for Dashboard actions. */
export class DashboardActionRunner {
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<DashboardActionRunnerOptions['setTimeout']>;
  private readonly clearTimer: NonNullable<DashboardActionRunnerOptions['clearTimeout']>;
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly completedRequests = new Set<string>();
  private readonly requestOrder: string[] = [];
  private readonly actionLocks = new Map<DashboardActionId, string>();
  private readonly mutexes = new Map<string, string>();
  private readonly states = new Map<DashboardActionId, DashboardActionState>();
  private readonly sequences = new Map<DashboardActionId, number>();
  private readonly timers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  private sink?: DashboardActionRunnerOptions['postMessage'];
  private readonly localizationSubscription: { dispose(): void };

  constructor(private readonly options: DashboardActionRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
    this.sink = options.postMessage;
    this.localizationSubscription = localization.onDidChange((event) =>
      this.relocalizeStates(event.previousLanguage),
    );
  }

  attachSink(postMessage: DashboardActionRunnerOptions['postMessage']): void {
    this.sink = postMessage;
  }

  detachSink(): void {
    this.sink = undefined;
  }

  getActionStates(): readonly DashboardActionState[] {
    return [...this.states.values()];
  }

  isActionActive(actionId: DashboardActionId): boolean {
    return [...this.activeRequests.values()].some(
      (request) => request.request.actionId === actionId,
    );
  }

  handleRequest(message: unknown): void {
    if (!isDashboardActionRequest(message)) {
      this.options.logger.logRecord('warn', {
        action: 'dashboard.message.rejected',
        message: 'Rejected invalid Dashboard action message.',
      });
      return;
    }
    const definition = getDashboardActionDefinition(message.actionId);
    if (!definition) {
      this.options.logger.logRecord('warn', {
        action: 'dashboard.action.rejected',
        message: 'Rejected unregistered Dashboard action.',
      });
      return;
    }
    if (
      this.activeRequests.has(message.requestId) ||
      this.completedRequests.has(message.requestId)
    ) {
      this.options.logger.logRecord('warn', {
        action: 'dashboard.action.replay',
        message: 'Ignored duplicate Dashboard request.',
      });
      return;
    }

    const correlationId = this.options.logger.createCorrelationId();
    const active: ActiveRequest = {
      request: message,
      definition,
      correlationId,
      startedAt: this.now().getTime(),
      mutexGroup: definition.mutexGroup,
      sequence: (this.sequences.get(message.actionId) ?? 0) + 1,
    };
    this.sequences.set(message.actionId, active.sequence);
    this.activeRequests.set(message.requestId, active);
    this.setState({
      actionId: message.actionId,
      requestId: message.requestId,
      correlationId,
      state: 'submitting',
      message: localizeDashboardMessage('Starting…'),
      retryable: definition.retryable,
    });

    const accepted: DashboardActionAccepted = {
      type: 'dashboard.action.accepted',
      requestId: message.requestId,
      actionId: message.actionId,
      correlationId,
      acceptedAt: this.now().toISOString(),
    };
    this.send(accepted);
    void this.execute(active);
  }

  dispose(): void {
    this.localizationSubscription.dispose();
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
    this.detachSink();
    this.activeRequests.clear();
    this.actionLocks.clear();
    this.mutexes.clear();
    this.states.clear();
  }

  private async execute(active: ActiveRequest): Promise<void> {
    const { request, definition, correlationId } = active;
    if (this.actionLocks.has(request.actionId) || this.conflicts(definition.mutexGroup)) {
      await this.finish(active, {
        status: 'throttled',
        message: localizeDashboardMessage('Try again later'),
        retryable: definition.retryable,
        safeErrorCategory: 'throttled',
      });
      this.releaseRequest(active);
      return;
    }
    this.actionLocks.set(request.actionId, request.requestId);
    if (definition.mutexGroup) this.mutexes.set(definition.mutexGroup, request.requestId);
    this.setState({
      actionId: request.actionId,
      requestId: request.requestId,
      correlationId,
      state: 'working',
      message: localizeDashboardMessage(definition.workingMessage),
      retryable: definition.retryable,
    });
    this.options.logger.logRecord('info', {
      correlationId,
      providerId: definition.providerId,
      action: 'operation.started',
      stage: `dashboard.${request.actionId}`,
      message: 'Dashboard action started.',
    });
    try {
      const value = await this.options.execute(definition.commandId, {
        source: 'dashboard',
        correlationId,
      });
      await this.finish(active, normalizeResult(definition, value, this.options.logger.redact));
    } catch (error) {
      const category = safeCategoryOf(error);
      const status: DashboardActionResult['status'] =
        category === 'cancelled'
          ? 'cancelled'
          : category === 'throttled' || category === 'rate-limited'
            ? 'throttled'
            : 'error';
      await this.finish(active, {
        status,
        message: safeResultMessage(
          definition,
          status,
          category,
          undefined,
          this.options.logger.redact,
        ),
        safeErrorCategory: category,
        retryable: status === 'error' ? definition.retryable : false,
      });
    } finally {
      this.releaseRequest(active);
    }
  }

  private async finish(
    active: ActiveRequest,
    outcome: Omit<
      DashboardActionResult,
      'type' | 'requestId' | 'actionId' | 'correlationId' | 'completedAt'
    >,
  ): Promise<void> {
    const completedAt = this.now().toISOString();
    const message = localizeDashboardMessage(outcome.message, 'en');
    const result: DashboardActionResult = {
      type: 'dashboard.action.result',
      requestId: active.request.requestId,
      actionId: active.request.actionId,
      correlationId: active.correlationId,
      ...outcome,
      message,
      completedAt,
    };
    const logAction =
      outcome.status === 'success'
        ? 'operation.completed'
        : outcome.status === 'cancelled'
          ? 'operation.cancelled'
          : outcome.status === 'throttled'
            ? 'operation.throttled'
            : 'operation.failed';
    this.options.logger.logRecord(outcome.status === 'error' ? 'error' : 'info', {
      correlationId: active.correlationId,
      providerId: active.definition.providerId,
      action: logAction,
      stage: `dashboard.${active.request.actionId}`,
      category: outcome.safeErrorCategory,
      durationMs: Math.max(0, this.now().getTime() - active.startedAt),
      message: 'Dashboard action completed.',
    });
    this.rememberCompleted(active.request.requestId);
    this.setState({
      actionId: active.request.actionId,
      requestId: active.request.requestId,
      correlationId: active.correlationId,
      state:
        outcome.status === 'success'
          ? 'success'
          : outcome.status === 'cancelled'
            ? 'cancelled'
            : outcome.status,
      message,
      retryable: outcome.retryable,
      ...(outcome.safeErrorCategory ? { safeErrorCategory: outcome.safeErrorCategory } : {}),
      completedAt,
    });
    this.send(result);
    if (outcome.status === 'success' || outcome.status === 'cancelled') {
      const timer = this.setTimer(() => {
        this.timers.delete(timer);
        const current = this.states.get(active.request.actionId);
        if (current?.requestId !== active.request.requestId) return;
        this.states.delete(active.request.actionId);
      }, SUCCESS_STATE_TTL_MS);
      this.timers.add(timer);
    }
  }

  private conflicts(group: string | undefined): boolean {
    if (!group) return false;
    for (const activeGroup of this.mutexes.keys()) {
      if (activeGroup === group || activeGroup === 'refresh:all' || group === 'refresh:all')
        return true;
    }
    return false;
  }

  private releaseRequest(active: ActiveRequest): void {
    this.activeRequests.delete(active.request.requestId);
    if (this.actionLocks.get(active.request.actionId) === active.request.requestId)
      this.actionLocks.delete(active.request.actionId);
    if (active.mutexGroup && this.mutexes.get(active.mutexGroup) === active.request.requestId)
      this.mutexes.delete(active.mutexGroup);
  }

  private rememberCompleted(requestId: string): void {
    this.completedRequests.add(requestId);
    this.requestOrder.push(requestId);
    while (this.requestOrder.length > MAX_REQUEST_HISTORY) {
      const oldest = this.requestOrder.shift();
      if (oldest) this.completedRequests.delete(oldest);
    }
  }

  private setState(state: DashboardActionState): void {
    this.states.set(state.actionId, state);
    while (this.states.size > MAX_ACTION_STATES) {
      const oldest = this.states.keys().next().value as DashboardActionId | undefined;
      if (!oldest) break;
      this.states.delete(oldest);
    }
  }

  private send(message: DashboardActionAccepted | DashboardActionResult): void {
    try {
      const result = this.sink?.(message);
      if (result && typeof (result as Promise<void>).catch === 'function')
        void (result as Promise<void>).catch(() => undefined);
    } catch {
      // A closed/disposed Webview must not affect the host operation.
    }
  }

  private relocalizeStates(previousLanguage: RuntimeLanguage): void {
    for (const [actionId, state] of this.states) {
      this.states.set(actionId, {
        ...state,
        message: localizeDashboardMessage(state.message, previousLanguage),
      });
    }
  }
}

/** Translate only stable action-state messages; provider error details remain untouched. */
function localizeDashboardMessage(
  message: string,
  sourceLanguage: RuntimeLanguage = localization.language,
): string {
  const source = sourceLanguage === 'tr' ? TR : EN;
  const target = localization.language === 'tr' ? TR : EN;
  const exact: Record<string, string> = {
    [`${source.starting}`]: target.starting,
    [`${source.stillWaiting}`]: target.stillWaiting,
    [`${source.working}…`]: `${target.working}…`,
    [source.updated]: target.updated,
    [source.opened]: target.opened,
    [source.copied]: target.copied,
    [source.exported]: target.exported,
    [source.saved]: target.saved,
    [source.enabled]: target.enabled,
    [source.disabledAction]: target.disabledAction,
    [source.connectedAction]: target.connectedAction,
    [source.disconnectedAction]: target.disconnectedAction,
    [source.checked]: target.checked,
    [source.refreshing]: target.refreshing,
    [`${source.refresh} Codex`]: `${target.refresh} Codex`,
    [`${source.refresh} Claude`]: `${target.refresh} Claude`,
    [source.opening]: target.opening,
    [source.copying]: target.copying,
    [source.exporting]: target.exporting,
    [source.restarting]: target.restarting,
    [source.checking]: target.checking,
    [source.enabling]: target.enabling,
    [source.disabling]: target.disabling,
    [`${source.repairIntegration}…`]: `${target.repairIntegration}…`,
    [source.repaired]: target.repaired,
    [source.connecting]: target.connecting,
    [source.disconnecting]: target.disconnecting,
    [source.saving]: target.saving,
    [source.cancelled]: target.cancelled,
    [source.tryAgainLater]: target.tryAgainLater,
    [source.failed]: target.failed,
    [source.securityValidationFailed]: target.securityValidationFailed,
    [source.dashboardNoResponse]: target.dashboardNoResponse,
  };
  return exact[message] ?? message;
}
