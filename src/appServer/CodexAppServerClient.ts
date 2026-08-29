import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { JsonRpcClient } from './JsonRpcClient';
import type { AccountResult, RateLimitsResult, UsageResult } from './types';
import type { Logger } from '../infrastructure/Logger';
import {
  diagnosticForError,
  formatDiagnostic,
  SafeDiagnosticError,
  safeCategoryOf,
  type ProviderDiagnostic,
  type SafeErrorCategory,
} from '../infrastructure/ProviderDiagnostics';

export type CodexRpcMethod =
  'initialize' | 'account/read' | 'account/rateLimits/read' | 'account/usage/read';
export type CodexRequestStatus = 'success' | 'failure' | 'not-run';
export type CodexProcessState =
  'not-started' | 'starting' | 'running' | 'exited' | 'failed' | 'stopped';

export interface CodexClientDiagnostics {
  executablePath: string;
  executableExists: boolean;
  cliVersion: string | null;
  processState: CodexProcessState;
  processStartedAt: number | null;
  processExitCode: number | null;
  initialized: boolean;
  protocolVersion: string | null;
  requestStatus: Record<CodexRpcMethod, CodexRequestStatus>;
  lastDiagnostic: ProviderDiagnostic | null;
}

const REQUEST_METHODS: CodexRpcMethod[] = [
  'initialize',
  'account/read',
  'account/rateLimits/read',
  'account/usage/read',
];

export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private rpc: JsonRpcClient | undefined;
  private stopping = false;
  private readonly diagnostics: CodexClientDiagnostics;
  constructor(
    private readonly executable: string,
    private readonly logger: Logger,
  ) {
    super();
    this.diagnostics = {
      executablePath: executable,
      executableExists: fs.existsSync(executable),
      cliVersion: null,
      processState: 'not-started',
      processStartedAt: null,
      processExitCode: null,
      initialized: false,
      protocolVersion: null,
      requestStatus: this.emptyRequestStatus(),
      lastDiagnostic: null,
    };
  }
  async start(): Promise<void> {
    if (this.rpc) return;
    this.stopping = false;
    this.diagnostics.processState = 'starting';
    this.diagnostics.processStartedAt = Date.now();
    this.diagnostics.processExitCode = null;
    this.diagnostics.initialized = false;
    this.diagnostics.protocolVersion = null;
    this.diagnostics.requestStatus = this.emptyRequestStatus();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executable, ['app-server', '--stdio'], {
        stdio: 'pipe',
        windowsHide: true,
        shell: process.platform === 'win32' && this.executable.toLowerCase().endsWith('.cmd'),
      });
    } catch (error) {
      this.diagnostics.processState = 'failed';
      this.recordDiagnostic(
        diagnosticForError('codex', 'start', error, {
          category: 'process-start-failed',
          retryAvailable: true,
        }),
      );
      throw new SafeDiagnosticError('process-start-failed');
    }
    this.process = child;
    const rpc = new JsonRpcClient(child.stdin);
    this.rpc = rpc;
    child.stdout.on('data', (data) => rpc.handleData(data));
    child.stderr.on('data', () => {
      this.recordDiagnostic(
        diagnosticForError('codex', 'process', new SafeDiagnosticError('protocol-error'), {
          retryAvailable: true,
        }),
      );
    });
    child.once('error', (error) => this.handleClose('process-start-failed', null, error));
    child.once('close', (code) => this.handleClose('process-exited', code, undefined));
    rpc.on('invalidJson', () => {
      this.recordDiagnostic(
        diagnosticForError('codex', 'protocol', new SafeDiagnosticError('protocol-error'), {
          retryAvailable: true,
        }),
      );
    });
    rpc.on('notification', (method, params) => this.emit('notification', method, params));
    try {
      const initialize = await this.request<unknown>('initialize', {
        clientInfo: { name: 'ai_limit_ledger', title: 'AI Limit Ledger', version: '0.6.0' },
      });
      this.diagnostics.protocolVersion = this.readProtocolVersion(initialize);
      rpc.notify('initialized');
      this.diagnostics.initialized = true;
      this.diagnostics.processState = 'running';
    } catch (error) {
      const category = safeCategoryOf(error, 'initialize-failed');
      this.diagnostics.processState = 'failed';
      this.recordDiagnostic(
        diagnosticForError('codex', 'initialize', error, {
          category: category === 'unknown' ? 'initialize-failed' : category,
          retryAvailable: true,
        }),
      );
      this.rpc?.close(new SafeDiagnosticError('initialize-failed'));
      this.rpc = undefined;
      this.process = undefined;
      if (!child.killed) child.kill();
      throw error;
    }
  }
  async readRateLimits(): Promise<RateLimitsResult> {
    await this.start();
    return this.request<RateLimitsResult>('account/rateLimits/read');
  }
  async readAccount(): Promise<AccountResult> {
    await this.start();
    return this.request<AccountResult>('account/read', { refreshToken: false });
  }
  async readUsage(): Promise<UsageResult> {
    await this.start();
    return this.request<UsageResult>('account/usage/read');
  }
  version(): Promise<string | null> {
    return new Promise((resolve) =>
      execFile(
        this.executable,
        ['--version'],
        { windowsHide: true, timeout: 5_000 },
        (error, stdout) => {
          if (error) {
            this.diagnostics.cliVersion = null;
            return resolve(null);
          }
          this.diagnostics.cliVersion =
            stdout.match(/(?:codex(?:-cli)?\s+)?v?\d+\.\d+(?:\.\d+)?(?:[-+][^\s]+)?/i)?.[0] ?? null;
          resolve(this.diagnostics.cliVersion);
        },
      ),
    );
  }
  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }
  stop(): void {
    this.stopping = true;
    this.rpc?.close(new SafeDiagnosticError('cancelled'));
    this.rpc = undefined;
    const child = this.process;
    this.process = undefined;
    this.diagnostics.processState = child ? 'stopped' : this.diagnostics.processState;
    this.diagnostics.initialized = false;
    if (child && !child.killed) child.kill();
  }
  getDiagnostics(): CodexClientDiagnostics {
    return {
      ...this.diagnostics,
      requestStatus: { ...this.diagnostics.requestStatus },
      lastDiagnostic: this.diagnostics.lastDiagnostic
        ? { ...this.diagnostics.lastDiagnostic }
        : null,
    };
  }
  private async request<T>(method: CodexRpcMethod, params?: unknown): Promise<T> {
    if (!this.rpc)
      throw new SafeDiagnosticError(
        'transport-error',
        'App Server is not connected.',
        method,
        undefined,
        'transport',
      );
    try {
      const result = await this.rpc.request<T>(method, params);
      this.diagnostics.requestStatus[method] = 'success';
      return result;
    } catch (error) {
      this.diagnostics.requestStatus[method] = 'failure';
      this.recordDiagnostic(
        diagnosticForError('codex', 'request', error, {
          method,
          retryAvailable: true,
        }),
      );
      throw error;
    }
  }
  private handleClose(category: SafeErrorCategory, exitCode: number | null, error: unknown): void {
    const diagnosticError = new SafeDiagnosticError(
      this.stopping ? 'cancelled' : category,
      this.stopping ? 'Codex App Server stopped' : category,
      undefined,
      exitCode,
      'process',
    );
    this.rpc?.close(diagnosticError);
    this.rpc = undefined;
    this.process = undefined;
    this.diagnostics.processState = this.stopping
      ? 'stopped'
      : category === 'process-start-failed'
        ? 'failed'
        : 'exited';
    this.diagnostics.processExitCode = exitCode;
    this.diagnostics.initialized = false;
    if (!this.stopping) {
      this.recordDiagnostic(
        diagnosticForError('codex', 'process', error ?? diagnosticError, {
          category: category === 'process-start-failed' ? category : 'process-exited',
          retryAvailable: true,
        }),
      );
      this.emit('closed', category);
    }
  }
  private recordDiagnostic(diagnostic: ProviderDiagnostic): void {
    this.diagnostics.lastDiagnostic = diagnostic;
    this.logger.error(`Codex diagnostic ${formatDiagnostic(diagnostic)}`);
  }
  private emptyRequestStatus(): Record<CodexRpcMethod, CodexRequestStatus> {
    return Object.fromEntries(REQUEST_METHODS.map((method) => [method, 'not-run'])) as Record<
      CodexRpcMethod,
      CodexRequestStatus
    >;
  }
  private readProtocolVersion(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    const direct = (value as { protocolVersion?: unknown }).protocolVersion;
    return typeof direct === 'string' ? direct : null;
  }
}
