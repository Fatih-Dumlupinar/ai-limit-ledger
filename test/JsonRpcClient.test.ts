import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { JsonRpcClient } from '../src/appServer/JsonRpcClient';
class FakeInput extends EventEmitter {
  writes: string[] = [];
  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }
}
describe('JsonRpcClient', () => {
  it('correlates concurrent requests', async () => {
    const input = new FakeInput();
    const client = new JsonRpcClient(input as never, 100);
    const first = client.request('one');
    const second = client.request('two');
    client.handleData('{"id":2,"result":"second"}\n{"id":1,"result":"first"}\n');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });
  it('rejects timed-out and closes requests', async () => {
    const client = new JsonRpcClient(new FakeInput() as never, 1);
    await expect(client.request('slow')).rejects.toThrow('timeout');
  });
  it('does not crash on malformed JSON', () => {
    const client = new JsonRpcClient(new FakeInput() as never);
    expect(() => client.handleData('bad json\n')).not.toThrow();
  });

  it('does not copy raw RPC error responses into the rejected error', async () => {
    const client = new JsonRpcClient(new FakeInput() as never, 100);
    const request = client.request('account/read');
    client.handleData('{"id":1,"error":{"code":-32000,"message":"RAW_RPC_SECRET token=secret"}}\n');

    await expect(request).rejects.toThrow('protocol-error');
    await expect(request).rejects.not.toThrow('RAW_RPC_SECRET');
  });
});
