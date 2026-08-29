import * as path from 'node:path';

/**
 * Minimal filesystem surface needed to read the credential file. Deliberately narrower than
 * `FsLike` in `ClaudeSettingsFile.ts` — this reader never writes, renames, or deletes anything.
 */
export interface CredentialFsLike {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
}

export type CredentialReadResult =
  | { kind: 'ok'; accessToken: string }
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'invalid' };

/**
 * `~/.claude/.credentials.json` (`%USERPROFILE%\.claude\.credentials.json` on Windows) — the same
 * file Claude Code's own CLI/VS Code extension read and write. This function only ever reads it.
 */
export function credentialsPathFor(homeDir: string): string {
  return path.join(homeDir, '.claude', '.credentials.json');
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Reads the credential file and extracts *only* the allowlisted `claudeAiOauth.accessToken` (and
 * `expiresAt`, used solely to decide whether the token is expired) field. Every other property in
 * the file — refresh token, scopes, subscription type, account id, or anything else — is
 * discarded the instant the file is parsed and never held, logged, or returned to any caller.
 * Never refreshes, rewrites, or deletes the credential file.
 */
export async function readClaudeAccessToken(
  fs: CredentialFsLike,
  credentialsPath: string,
  now: () => number = Date.now,
): Promise<CredentialReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(credentialsPath, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  const root = asObject(parsed);
  const oauth = asObject(root?.claudeAiOauth);
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken.trim()) return { kind: 'invalid' };
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now()) {
    return { kind: 'expired' };
  }
  return { kind: 'ok', accessToken };
}
