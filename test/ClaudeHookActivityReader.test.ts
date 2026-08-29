import { describe, expect, it } from 'vitest';
import {
  lastEventOfType,
  readLatestHookActivity,
  type ActivityFsLike,
} from '../src/providers/claude/hooks/ClaudeHookActivityReader';

function fixtureFs(content: string): ActivityFsLike {
  return { readFile: async () => content };
}

describe('readLatestHookActivity', () => {
  it('parses only the allowlisted fields from each line', async () => {
    const line = JSON.stringify({
      schemaVersion: 1,
      eventType: 'Stop',
      observedAt: '2026-01-01T00:00:00.000Z',
      safeErrorCategory: 'none',
      transcript_path: 'must-not-appear',
      prompt: 'must-not-appear',
    });
    const events = await readLatestHookActivity(fixtureFs(line + '\n'), '/fixture/activity.jsonl');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      schemaVersion: 1,
      eventType: 'Stop',
      observedAt: '2026-01-01T00:00:00.000Z',
      safeErrorCategory: 'none',
    });
  });

  it('never surfaces a disallowed field even if present in the raw line', async () => {
    const line = JSON.stringify({
      eventType: 'Stop',
      observedAt: '2026-01-01T00:00:00.000Z',
      safeErrorCategory: 'none',
      cwd: '/secret/project/path',
    });
    const events = await readLatestHookActivity(fixtureFs(line), '/fixture/activity.jsonl');
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('skips malformed lines without throwing', async () => {
    const good = JSON.stringify({
      eventType: 'SessionStart',
      observedAt: '2026-01-01T00:00:00.000Z',
      safeErrorCategory: 'none',
    });
    const events = await readLatestHookActivity(
      fixtureFs(`not json\n${good}\n{"missing":"fields"}`),
      '/fixture/activity.jsonl',
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('SessionStart');
  });

  it('returns an empty list when the activity file does not exist yet', async () => {
    const events = await readLatestHookActivity(
      {
        readFile: async () => {
          throw new Error('ENOENT');
        },
      },
      '/fixture/activity.jsonl',
    );
    expect(events).toEqual([]);
  });
});

describe('lastEventOfType', () => {
  it('returns the most recent event matching the given type', () => {
    const events = [
      { schemaVersion: 1, eventType: 'Stop', observedAt: 'a', safeErrorCategory: 'none' as const },
      {
        schemaVersion: 1,
        eventType: 'StopFailure',
        observedAt: 'b',
        safeErrorCategory: 'rate_limit' as const,
      },
      { schemaVersion: 1, eventType: 'Stop', observedAt: 'c', safeErrorCategory: 'none' as const },
    ];
    expect(lastEventOfType(events, 'Stop')?.observedAt).toBe('c');
    expect(lastEventOfType(events, 'StopFailure')?.safeErrorCategory).toBe('rate_limit');
    expect(lastEventOfType(events, 'SessionStart')).toBeUndefined();
  });
});
