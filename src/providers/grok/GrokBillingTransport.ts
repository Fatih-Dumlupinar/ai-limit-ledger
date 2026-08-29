import { GrokAcpClient } from './GrokAcpClient';
import { parseGrokBilling } from './GrokUsageParser';
import type { GrokBillingTransport } from './types';

export class AcpGrokBillingTransport implements GrokBillingTransport {
  constructor(private readonly client: GrokAcpClient) {}

  async getBilling() {
    return parseGrokBilling(await this.client.getBilling());
  }

  dispose(): void {
    this.client.dispose();
  }
}
