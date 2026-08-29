import { describe, expect, it } from 'vitest';
import {
  credentialsPathFor,
  readClaudeAccessToken,
  type CredentialFsLike,
} from '../src/providers/claude/oauth/ClaudeCredentialReader';

function fixtureFs(content: string | undefined): CredentialFsLike {
  return {
    readFile: async () => {
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
  };
}

describe('credentialsPathFor', () => {
  it('resolves to .claude/.credentials.json under the given home directory', () => {
    expect(credentialsPathFor('C:\\Users\\fixture')).toContain('.claude');
    expect(credentialsPathFor('C:\\Users\\fixture')).toContain('.credentials.json');
  });
});

describe('readClaudeAccessToken', () => {
  it('extracts only the access token from a well-formed fixture credential file', async () => {
    const fs = fixtureFs(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fixture-access-token',
          refreshToken: 'fixture-refresh-token-must-never-be-read',
          expiresAt: Date.now() + 60_000,
          scopes: ['user:inference'],
        },
      }),
    );
    const result = await readClaudeAccessToken(fs, '/fixture/.credentials.json');
    expect(result).toEqual({ kind: 'ok', accessToken: 'fixture-access-token' });
  });

  it('never surfaces the refresh token or any other field, even though the file contains one', async () => {
    const fs = fixtureFs(
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'must-not-leak' } }),
    );
    const result = await readClaudeAccessToken(fs, '/fixture/.credentials.json');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('reports "missing" when the file does not exist', async () => {
    const result = await readClaudeAccessToken(fixtureFs(undefined), '/fixture/.credentials.json');
    expect(result).toEqual({ kind: 'missing' });
  });

  it('reports "invalid" for malformed JSON', async () => {
    const result = await readClaudeAccessToken(
      fixtureFs('{not json'),
      '/fixture/.credentials.json',
    );
    expect(result).toEqual({ kind: 'invalid' });
  });

  it('reports "invalid" when claudeAiOauth.accessToken is missing', async () => {
    const result = await readClaudeAccessToken(
      fixtureFs(JSON.stringify({ claudeAiOauth: {} })),
      '/fixture/.credentials.json',
    );
    expect(result).toEqual({ kind: 'invalid' });
  });

  it('reports "expired" when expiresAt is in the past — never rejects a token without a timestamp as expired', async () => {
    const fs = fixtureFs(JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: 1_000 } }));
    const result = await readClaudeAccessToken(fs, '/fixture/.credentials.json', () => 2_000);
    expect(result).toEqual({ kind: 'expired' });
  });

  it('treats a token with no expiresAt field as valid rather than expired', async () => {
    const fs = fixtureFs(JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
    const result = await readClaudeAccessToken(fs, '/fixture/.credentials.json');
    expect(result).toEqual({ kind: 'ok', accessToken: 'a' });
  });
});
