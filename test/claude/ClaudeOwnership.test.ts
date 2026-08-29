import { describe, expect, it } from 'vitest';
import {
  buildMarker,
  hashStatusLine,
  readMarker,
} from '../../src/providers/claude/ClaudeOwnership';

describe('ClaudeOwnership', () => {
  it('reports not-owned for a third-party statusLine', () => {
    const info = readMarker({ type: 'command', command: 'echo hi' });
    expect(info.owned).toBe(false);
  });

  it('detects the legacy 0.3.1 bare-string marker and migrates it to standalone/v1', () => {
    const info = readMarker({
      type: 'command',
      command: 'x',
      _aiLimitLedger: 'ai-limit-ledger-status-line-v1',
    });
    expect(info).toEqual({ owned: true, legacy: true, mode: 'standalone', schemaVersion: 1 });
  });

  it('reads the current versioned marker', () => {
    const info = readMarker({
      type: 'command',
      command: 'x',
      _aiLimitLedger: buildMarker('chained'),
    });
    expect(info.owned).toBe(true);
    expect(info.legacy).toBe(false);
    expect(info.mode).toBe('chained');
  });

  it('is undefined-safe', () => {
    expect(readMarker(undefined).owned).toBe(false);
    expect(readMarker(null).owned).toBe(false);
    expect(readMarker('not an object').owned).toBe(false);
  });

  it('hashes deterministically for identical input and differently for different input', () => {
    const a = { type: 'command', command: 'echo hi' };
    const b = { type: 'command', command: 'echo hi' };
    const c = { type: 'command', command: 'echo bye' };
    expect(hashStatusLine(a)).toBe(hashStatusLine(b));
    expect(hashStatusLine(a)).not.toBe(hashStatusLine(c));
  });
});
