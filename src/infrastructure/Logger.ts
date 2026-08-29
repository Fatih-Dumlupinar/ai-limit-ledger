import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  CANONICAL_PROVIDER_IDS,
  normalizeProviderId,
} from '../providers/ProviderCapabilityContract';
import type { ProviderId } from '../providers/types';
import {
  SAFE_ERROR_CATEGORIES,
  type DiagnosticLogger,
  type LogLevel,
  type SafeErrorCategory,
  type SafeLogFields,
} from './ProviderDiagnostics';
import { SafeLogRedactor, redactSensitive, safeErrorMessage } from './redact';

export interface SafeLogRecord {
  timestamp: string;
  level: LogLevel;
  correlationId?: string;
  providerId?: ProviderId;
  action: string;
  stage?: string;
  category?: SafeErrorCategory;
  durationMs?: number;
  attempt?: number;
  retryAt?: string;
  availability?: string;
  message: string;
}

const MEMORY_LOG_LIMIT = 200;

function safeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeText(redactor: SafeLogRedactor, value: unknown): string | undefined {
  return typeof value === 'string' ? redactor.redact(value).slice(0, 500) : undefined;
}

function safeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[a-z0-9-]{8,80}$/i.test(trimmed) ? trimmed : undefined;
}

function safeProviderId(value: unknown): ProviderId | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeProviderId(value);
  return (CANONICAL_PROVIDER_IDS as readonly string[]).includes(normalized)
    ? (normalized as ProviderId)
    : undefined;
}

function safeRetryAt(redactor: SafeLogRedactor, value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return safeText(redactor, value);
}

/**
 * A bounded, structured, memory-only logger. The VS Code log output channel is
 * the sole durable sink; this class never creates or appends to a custom file.
 */
export class Logger implements vscode.Disposable, DiagnosticLogger {
  readonly channel = vscode.window.createOutputChannel('AI Limit Ledger', { log: true });
  private readonly redactor = new SafeLogRedactor();
  private readonly memory: SafeLogRecord[] = [];
  private minimumLevel: 'error' | 'warn' | 'info' | 'debug' = 'info';

  setLevel(level: 'error' | 'warn' | 'info' | 'debug'): void {
    this.minimumLevel = level;
  }

  get level(): 'error' | 'warn' | 'info' | 'debug' {
    return this.minimumLevel;
  }

  trace(message: string): void {
    this.logRecord('trace', { message });
  }

  debug(message: string): void {
    this.logRecord('debug', { message });
  }

  info(message: string): void {
    this.logRecord('info', { message });
  }

  warn(message: string): void {
    this.logRecord('warn', { message });
  }

  error(message: string): void {
    this.logRecord('error', { message });
  }

  logError(error: unknown, fields: Omit<SafeLogFields, 'message'> = {}): void {
    this.logRecord('error', { ...fields, message: safeErrorMessage(error) });
  }

  logRecord(level: LogLevel, fields: SafeLogFields): void {
    if (!shouldLog(level, this.minimumLevel)) return;
    try {
      const record: SafeLogRecord = {
        timestamp: new Date().toISOString(),
        level,
        action: safeText(this.redactor, fields.action) ?? 'log',
        ...(safeProviderId(fields.providerId)
          ? { providerId: safeProviderId(fields.providerId) }
          : {}),
        ...(safeCorrelationId(fields.correlationId)
          ? { correlationId: safeCorrelationId(fields.correlationId) }
          : {}),
        ...(safeText(this.redactor, fields.stage)
          ? { stage: safeText(this.redactor, fields.stage) }
          : {}),
        ...(typeof fields.category === 'string' &&
        (SAFE_ERROR_CATEGORIES as readonly string[]).includes(fields.category)
          ? { category: fields.category as SafeErrorCategory }
          : {}),
        ...(safeFiniteNumber(fields.durationMs) !== undefined
          ? { durationMs: safeFiniteNumber(fields.durationMs) }
          : {}),
        ...(safeFiniteNumber(fields.attempt) !== undefined
          ? { attempt: safeFiniteNumber(fields.attempt) }
          : {}),
        ...(safeRetryAt(this.redactor, fields.retryAt)
          ? { retryAt: safeRetryAt(this.redactor, fields.retryAt) }
          : {}),
        ...(safeText(this.redactor, fields.availability)
          ? { availability: safeText(this.redactor, fields.availability) }
          : {}),
        message: this.redactor.redact(fields.message).slice(0, 1000),
      };

      this.memory.push(record);
      if (this.memory.length > MEMORY_LOG_LIMIT)
        this.memory.splice(0, this.memory.length - MEMORY_LOG_LIMIT);
      this.channel.appendLine(JSON.stringify(record));
    } catch {
      // The fallback is deliberately non-diagnostic: an error in sanitisation
      // must not make the original value observable.
      const fallback: SafeLogRecord = {
        timestamp: new Date().toISOString(),
        level: 'error',
        action: 'log-failure',
        message: '[redacted log failure]',
      };
      this.memory.push(fallback);
      if (this.memory.length > MEMORY_LOG_LIMIT) this.memory.shift();
      try {
        this.channel.appendLine(JSON.stringify(fallback));
      } catch {
        // VS Code may already be disposing the channel.
      }
    }
  }

  createCorrelationId(): string {
    try {
      return randomUUID();
    } catch {
      return `correlation-${Date.now().toString(36)}`;
    }
  }

  getRecentRecords(): readonly SafeLogRecord[] {
    return this.memory.slice();
  }

  get records(): readonly SafeLogRecord[] {
    return this.getRecentRecords();
  }

  clearMemoryBuffer(): void {
    this.memory.length = 0;
  }

  clearBuffer(): void {
    this.clearMemoryBuffer();
  }

  show(): void {
    this.channel.show(true);
  }

  redact(value: string): string {
    return redactSensitive(value);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

function shouldLog(level: LogLevel, minimum: 'error' | 'warn' | 'info' | 'debug'): boolean {
  const rank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 3 };
  return rank[level] <= rank[minimum];
}
