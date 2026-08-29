import { spawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { redactSensitive } from '../../infrastructure/redact';
import { GROK_BILLING_METHOD } from './types';

export const MAX_GROK_RESPONSE_BYTES = 512 * 1024;
export const DEFAULT_GROK_REQUEST_TIMEOUT_MS = 15_000;

export interface GrokProcessLike {
  stdin: { write(data: string): boolean; end(): void };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: string, listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
  pid?: number;
}

export type GrokSpawner = (file: string, args: string[]) => GrokProcessLike;

export class GrokAcpError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
  ) {
    super(message);
    this.name = 'GrokAcpError';
  }
}

export class GrokMethodNotSupportedError extends GrokAcpError {
  constructor() {
    super(-32601, 'Grok billing capability is not available in this CLI version.');
    this.name = 'GrokMethodNotSupportedError';
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal ACP JSON-RPC client. It ignores notifications and never writes stderr to a log. */
export class GrokAcpClient {
  private process?: GrokProcessLike;
  private lines?: Interface;
  private nextId = 1;
  private initialized = false;
  private buffer = '';
  private bytesRead = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly executablePath: string,
    private readonly options: {
      spawn?: GrokSpawner;
      timeoutMs?: number;
      onRedactedStderr?: (line: string) => void;
    } = {},
  ) {}

  async initialize(): Promise<unknown> {
    if (this.initialized) return undefined;
    const result = await this.request('initialize', {
      protocolVersion: '1',
      clientCapabilities: {},
      clientInfo: { name: 'AI Limit Ledger', version: '0.6.0' },
    });
    this.initialized = true;
    return result;
  }

  async getBilling(): Promise<unknown> {
    await this.initialize();
    try {
      return await this.request(GROK_BILLING_METHOD, {});
    } catch (error) {
      if (error instanceof GrokAcpError && error.code === -32601)
        throw new GrokMethodNotSupportedError();
      throw error;
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.ensureProcess();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GrokAcpError('timeout', `Grok ACP request timed out: ${method}`));
      }, this.options.timeoutMs ?? DEFAULT_GROK_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process?.stdin.write(`${payload}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new GrokAcpError('transport', 'Grok ACP stdin is unavailable.'));
      }
    });
  }

  dispose(): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new GrokAcpError('cancelled', 'Grok ACP process stopped.'));
    });
    this.pending.clear();
    this.lines?.close();
    this.lines = undefined;
    const process = this.process;
    this.process = undefined;
    this.initialized = false;
    if (process) {
      try {
        process.stdin.end();
      } catch {
        // Best effort graceful shutdown.
      }
      try {
        process.kill();
      } catch {
        // Best effort forced cleanup.
      }
    }
  }

  private ensureProcess(): void {
    if (this.process) return;
    const factory =
      this.options.spawn ??
      ((file, args) => spawn(file, args, { stdio: 'pipe', windowsHide: true }));
    this.process = factory(this.executablePath, ['agent', 'stdio']);
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', (line) => this.onLine(line));
    this.process.stderr.on('data', (chunk: Buffer | string) => {
      const redacted = redactSensitive(String(chunk));
      this.options.onRedactedStderr?.(redacted.slice(0, 2_000));
    });
    this.process.once('error', () =>
      this.failAll(new GrokAcpError('transport', 'Grok ACP process failed.')),
    );
    this.process.once('exit', () =>
      this.failAll(new GrokAcpError('process-exited', 'Grok ACP process exited.')),
    );
  }

  private onLine(line: string): void {
    if (this.bytesRead + Buffer.byteLength(line) > MAX_GROK_RESPONSE_BYTES) {
      this.failAll(
        new GrokAcpError('response-too-large', 'Grok ACP response exceeded its size limit.'),
      );
      this.dispose();
      return;
    }
    this.bytesRead += Buffer.byteLength(line);
    const value = parseJsonRpcFrame(line);
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    if (typeof message.id !== 'number') return; // Unknown notifications are intentionally ignored.
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as { code?: unknown; message?: unknown };
      const code =
        typeof error.code === 'number' || typeof error.code === 'string' ? error.code : 'protocol';
      pending.reject(
        new GrokAcpError(
          code,
          typeof error.message === 'string' ? error.message : 'Grok ACP request failed.',
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: GrokAcpError): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
  }
}

export function parseJsonRpcFrame(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('Content-Length:')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}
