import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { SafeDiagnosticError, type SafeErrorCategory } from '../infrastructure/ProviderDiagnostics';

export interface RpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export class JsonRpcError extends SafeDiagnosticError {
  constructor(
    category: SafeErrorCategory,
    readonly method?: string,
    readonly rpcCode?: number,
  ) {
    super(category, category, method, undefined, category === 'timeout' ? 'timeout' : 'protocol');
    this.name = 'JsonRpcError';
  }
}

export class JsonRpcClient extends EventEmitter {
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private buffer = '';
  constructor(
    private readonly input: Writable,
    private readonly timeoutMs = 10_000,
  ) {
    super();
  }
  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcError('timeout', method));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.send({ method, id, ...(params === undefined ? {} : { params }) });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new JsonRpcError('transport-error', method));
      }
    });
  }
  notify(method: string, params: unknown = {}): void {
    this.send({ method, params });
  }
  handleData(chunk: string | Buffer): void {
    this.buffer += chunk.toString();
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
    }
  }
  handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as {
        id?: unknown;
        result?: unknown;
        error?: RpcError;
        method?: string;
        params?: unknown;
      };
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new JsonRpcError('protocol-error', undefined, message.error.code));
        else pending.resolve(message.result);
      } else if (typeof message.method === 'string')
        this.emit('notification', message.method, message.params);
    } catch {
      this.emit('invalidJson', line);
    }
  }
  close(reason: SafeDiagnosticError = new SafeDiagnosticError('process-exited')): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new SafeDiagnosticError(
          reason.category,
          reason.category,
          undefined,
          reason.exitCode,
          reason.transport,
        ),
      );
      this.pending.delete(id);
    }
  }
  private send(message: unknown): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }
}
