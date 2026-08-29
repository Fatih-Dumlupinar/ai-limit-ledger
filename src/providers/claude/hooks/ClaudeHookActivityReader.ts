const MAX_READ_BYTES = 256 * 1024;

export interface ActivityFsLike {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
}

export type SafeHookErrorCategory = 'none' | 'rate_limit' | 'other';

export interface HookActivityEvent {
  schemaVersion: number;
  eventType: string;
  observedAt: string;
  safeErrorCategory: SafeHookErrorCategory;
}

const isCategory = (value: unknown): value is SafeHookErrorCategory =>
  value === 'none' || value === 'rate_limit' || value === 'other';

function parseLine(line: string): HookActivityEvent | undefined {
  if (!line.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.eventType !== 'string' ||
    typeof record.observedAt !== 'string' ||
    !isCategory(record.safeErrorCategory)
  ) {
    return undefined;
  }
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
    eventType: record.eventType,
    observedAt: record.observedAt,
    safeErrorCategory: record.safeErrorCategory,
  };
}

/**
 * Reads only the allowlisted fields the hook bridge itself already restricted itself to writing
 * (`schemaVersion`/`eventType`/`observedAt`/`safeErrorCategory`) — never a prompt, response,
 * transcript path, cwd, tool input/output, token, or account identity, because none of those were
 * ever written to this file in the first place. Reads at most the last `MAX_READ_BYTES` of the
 * file so an unbounded activity log can never cause an unbounded read.
 */
export async function readLatestHookActivity(
  fs: ActivityFsLike,
  activityPath: string,
): Promise<HookActivityEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(activityPath, 'utf8');
  } catch {
    return [];
  }
  const truncated =
    Buffer.byteLength(raw, 'utf8') > MAX_READ_BYTES ? raw.slice(raw.length - MAX_READ_BYTES) : raw;
  return truncated
    .split('\n')
    .map(parseLine)
    .filter((event): event is HookActivityEvent => Boolean(event));
}

/** The most recent event of a given type, or undefined if none is present in the (possibly truncated) tail read. */
export function lastEventOfType(
  events: HookActivityEvent[],
  eventType: string,
): HookActivityEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].eventType === eventType) return events[i];
  }
  return undefined;
}
