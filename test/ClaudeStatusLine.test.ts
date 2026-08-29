import { describe, expect, it } from 'vitest';
import { MAX_INPUT_BYTES, parseClaudeStatusLine } from '../src/providers/ClaudeStatusLine';
describe('Claude status-line parser', () => {
  it('keeps only allowlisted fields and supports a single five-hour window', () => {
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({
        version: '1.2',
        cwd: 'secret',
        session_id: 'secret',
        model: { id: 'x', display_name: 'X' },
        rate_limits: { five_hour: { used_percentage: 41, resets_at: 1_798_761_600 } },
      }),
    );
    expect(snapshot.usageWindows).toHaveLength(1);
    expect(snapshot.usageWindows[0].remainingPercent).toBe(59);
    expect(snapshot.usageWindows[0].resetsAt).toBe(1_798_761_600);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
  it('handles missing limits and rejects unsafe input', () => {
    expect(parseClaudeStatusLine('{}').availability).toBe('waiting-for-first-response');
    expect(() => parseClaudeStatusLine('{')).toThrow('invalid');
    expect(() => parseClaudeStatusLine('x'.repeat(MAX_INPUT_BYTES + 1))).toThrow('size');
  });
  it('a snapshot with explicit null rate-limit fields is not treated as successful limit data', () => {
    // Matches the real-world regression: the wrapper ran and wrote a schema-valid snapshot, but
    // the CLI's own payload had not yet populated rate_limits (e.g. captured before any response
    // completed). This must stay "waiting", never "ready" with zero windows.
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({
        schemaVersion: 1,
        version: '2.1.241',
        model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' },
        rate_limits: { five_hour: null, seven_day: null },
      }),
    );
    expect(snapshot.usageWindows).toHaveLength(0);
    expect(snapshot.connected).toBe(false);
    expect(snapshot.availability).toBe('waiting-for-first-response');
    expect(snapshot.warning).toBe(
      'Waiting for the first completed Claude CLI response containing rate-limit data.',
    );
  });
  it('supports both the five-hour and seven-day windows together', () => {
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 27, resets_at: 1_798_000_000 },
          seven_day: { used_percentage: 41, resets_at: 1_798_500_000 },
        },
      }),
    );
    expect(snapshot.usageWindows).toHaveLength(2);
    expect(snapshot.usageWindows.map((w) => w.id)).toEqual(['five-hour', 'seven-day']);
  });
  it('supports the seven-day window alone', () => {
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({
        rate_limits: { seven_day: { used_percentage: 10, resets_at: 1_798_000_000 } },
      }),
    );
    expect(snapshot.usageWindows).toHaveLength(1);
    expect(snapshot.usageWindows[0].id).toBe('seven-day');
  });
  it('parses the wrapper-stamped observedAt into a distinct sourceUpdatedAt/lastProviderEventAt', () => {
    const wrapperWriteTime = '2026-08-23T09:30:00.000Z';
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({
        schemaVersion: 1,
        observedAt: wrapperWriteTime,
        rate_limits: { five_hour: { used_percentage: 5 } },
      }),
      Date.parse('2026-08-23T09:35:00.000Z'), // AI Limit Ledger's own read time, 5 minutes later
    );
    expect(snapshot.sourceUpdatedAt).toBe(Date.parse(wrapperWriteTime));
    expect(snapshot.lastProviderEventAt).toBe(Date.parse(wrapperWriteTime));
    expect(snapshot.observedAt).toBe(Date.parse('2026-08-23T09:35:00.000Z'));
    expect(snapshot.observedAt).not.toBe(snapshot.sourceUpdatedAt);
  });

  it('falls back to null sourceUpdatedAt when the snapshot has no embedded observedAt', () => {
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5 } } }),
    );
    expect(snapshot.sourceUpdatedAt).toBeNull();
  });

  it('tolerates null/absent optional fields without throwing', () => {
    const snapshot = parseClaudeStatusLine(
      JSON.stringify({
        version: null,
        model: null,
        context_window: null,
        cost: null,
        effort: null,
        thinking: null,
        rate_limits: { five_hour: { used_percentage: 5 } },
      }),
    );
    expect(snapshot.usageWindows[0].resetsAt).toBeNull();
    expect(snapshot.cliVersion).toBeNull();
    expect(snapshot.metadata?.modelId).toBeNull();
    expect(snapshot.tokens?.contextUsedPercent).toBeNull();
  });
});
