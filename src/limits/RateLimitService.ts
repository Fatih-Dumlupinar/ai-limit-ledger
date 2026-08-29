import { EventEmitter } from 'node:events';
import type { CodexAppServerClient } from '../appServer/CodexAppServerClient';
import { parseRateLimits } from './RateLimitParser';
import type { LimitSnapshot } from '../appServer/types';
export class RateLimitService extends EventEmitter {
  private refreshing: Promise<LimitSnapshot> | undefined;
  private snapshot: LimitSnapshot | undefined;
  constructor(private readonly client: CodexAppServerClient) {
    super();
    client.on('notification', (method) => {
      if (method === 'account/rateLimits/updated') void this.refresh();
    });
  }
  get current(): LimitSnapshot | undefined {
    return this.snapshot;
  }
  refresh(): Promise<LimitSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.all([
      this.client.readRateLimits(),
      this.client.readAccount(),
      this.client.readUsage(),
      this.client.version(),
    ])
      .then(([limits, account, usage, version]) => {
        const next = parseRateLimits(limits, account.account?.planType, usage, version);
        this.snapshot = next;
        this.emit('updated', next);
        return next;
      })
      .catch((error: unknown) => {
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, stale: true, connected: false };
          this.emit('updated', this.snapshot);
        }
        throw error;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
}
