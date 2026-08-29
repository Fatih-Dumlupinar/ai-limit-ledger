/**
 * Reads and selects a single credential out of the Grok Build CLI's own auth file
 * (`%USERPROFILE%\.grok\auth.json`), for the experimental CLI-proxy billing fallback.
 *
 * The file is a `BTreeMap<String, GrokAuth>` ("AuthStore"): the top-level key is an auth-scope
 * identifier, and each value is a `GrokAuth` entry. Only six fields are ever read out of a
 * candidate entry — `key` (bearer token), `user_id`, `auth_mode`, `create_time`, `expires_at`,
 * `oidc_issuer` — and only `key`/`user_id` are ever returned. `refresh_token`, `email`, name,
 * profile image, team/organization names, session history, and any other field are never read.
 *
 * The file is only ever read once "Experimental Grok Usage" has been explicitly enabled by the
 * user.
 */
export interface GrokAuthFile {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

export interface GrokAuthEntry {
  key?: unknown;
  auth_mode?: unknown;
  create_time?: unknown;
  user_id?: unknown;
  expires_at?: unknown;
  oidc_issuer?: unknown;
}

export type GrokAuthStore = Record<string, GrokAuthEntry>;

/** Recognized `auth_mode` values. Any other (or missing) value makes an entry unusable. */
export const GROK_SUPPORTED_AUTH_MODES = ['oidc', 'api_key'] as const;

/** The only `oidc_issuer` value treated as a first-party xAI credential. */
export const GROK_FIRST_PARTY_OIDC_ISSUER = 'https://auth.x.ai';

export type GrokAuthReadResult =
  | { kind: 'ok'; token: string; userId: string }
  | { kind: 'missing' }
  | { kind: 'invalid-structure' }
  | { kind: 'no-compatible-session' }
  | { kind: 'unsupported-auth-mode' }
  | { kind: 'session-expired' };

const obj = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;

const nonEmptyString = (x: unknown): string | null =>
  typeof x === 'string' && x.length > 0 ? x : null;

function isSupportedAuthMode(x: unknown): x is (typeof GROK_SUPPORTED_AUTH_MODES)[number] {
  return typeof x === 'string' && (GROK_SUPPORTED_AUTH_MODES as readonly string[]).includes(x);
}

function parseEpochSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  return null;
}

interface Candidate {
  scopeKey: string;
  token: string;
  userId: string;
  isFirstPartyOidc: boolean;
  createTime: number;
}

export function grokAuthFilePath(homeDir: string): string {
  return `${homeDir}\\.grok\\auth.json`;
}

/**
 * Structural, read-only AuthStore selection. Never returns `refresh_token` or any field other
 * than `key`/`user_id` of the winning candidate. Deterministic: prefers a first-party OIDC entry,
 * then a not-yet-expired entry, then the newest `create_time`, then the scope key sorted
 * lexicographically (as a final, stable tie-break).
 */
export async function readGrokAuthToken(
  fs: GrokAuthFile,
  homeDir: string,
): Promise<GrokAuthReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(grokAuthFilePath(homeDir), 'utf8');
  } catch {
    return { kind: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid-structure' };
  }

  const store = obj(parsed);
  if (!store) return { kind: 'invalid-structure' };

  const scopeKeys = Object.keys(store);
  if (scopeKeys.length === 0) return { kind: 'no-compatible-session' };

  // Structural candidates: entries shaped like a GrokAuth object with a non-empty key + user_id.
  const structural: Array<{ scopeKey: string; entry: GrokAuthEntry }> = [];
  for (const scopeKey of scopeKeys) {
    const entry = obj(store[scopeKey]);
    if (!entry) continue;
    if (!nonEmptyString(entry.key) || !nonEmptyString(entry.user_id)) continue;
    structural.push({ scopeKey, entry });
  }
  if (structural.length === 0) return { kind: 'no-compatible-session' };

  const supported = structural.filter(({ entry }) => isSupportedAuthMode(entry.auth_mode));
  if (supported.length === 0) return { kind: 'unsupported-auth-mode' };

  const now = Math.floor(Date.now() / 1000);
  const live = supported.filter(({ entry }) => {
    const expiresAt = parseEpochSeconds(entry.expires_at);
    return expiresAt === null || expiresAt > now;
  });
  if (live.length === 0) return { kind: 'session-expired' };

  const candidates: Candidate[] = live.map(({ scopeKey, entry }) => ({
    scopeKey,
    token: nonEmptyString(entry.key) as string,
    userId: nonEmptyString(entry.user_id) as string,
    isFirstPartyOidc:
      entry.auth_mode === 'oidc' && entry.oidc_issuer === GROK_FIRST_PARTY_OIDC_ISSUER,
    createTime: parseEpochSeconds(entry.create_time) ?? 0,
  }));

  candidates.sort((a, b) => {
    if (a.isFirstPartyOidc !== b.isFirstPartyOidc) return a.isFirstPartyOidc ? -1 : 1;
    if (a.createTime !== b.createTime) return b.createTime - a.createTime;
    return a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0;
  });

  const winner = candidates[0];
  return { kind: 'ok', token: winner.token, userId: winner.userId };
}
