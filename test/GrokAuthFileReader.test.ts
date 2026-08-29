import { describe, expect, it } from 'vitest';
import {
  grokAuthFilePath,
  readGrokAuthToken,
  GROK_FIRST_PARTY_OIDC_ISSUER,
  type GrokAuthFile,
} from '../src/providers/grok/experimental/GrokAuthFileReader';

function fileOf(store: unknown): GrokAuthFile {
  return { readFile: async () => JSON.stringify(store) };
}

const oidcEntry = (overrides: Record<string, unknown> = {}) => ({
  key: 'secret-token',
  user_id: 'user-1',
  auth_mode: 'oidc',
  oidc_issuer: GROK_FIRST_PARTY_OIDC_ISSUER,
  create_time: 1_700_000_000,
  ...overrides,
});

describe('grokAuthFilePath', () => {
  it('points at %USERPROFILE%\\.grok\\auth.json', () => {
    expect(grokAuthFilePath('C:\\Users\\me')).toBe('C:\\Users\\me\\.grok\\auth.json');
  });
});

describe('readGrokAuthToken — official AuthStore map format', () => {
  it('reads the top-level scope key -> nested GrokAuth entry and extracts key + user_id', async () => {
    const fs = fileOf({ 'https://auth.x.ai::11111111-1111-1111-1111-111111111111': oidcEntry() });
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
      kind: 'ok',
      token: 'secret-token',
      userId: 'user-1',
    });
  });

  it('reports missing when the file does not exist', async () => {
    const fs: GrokAuthFile = {
      readFile: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({ kind: 'missing' });
  });

  it('reports invalid-structure on malformed JSON', async () => {
    const fs: GrokAuthFile = { readFile: async () => '{not json' };
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({ kind: 'invalid-structure' });
  });

  it('reports invalid-structure when the top level is not an object map', async () => {
    const fs = fileOf(['not', 'a', 'map']);
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({ kind: 'invalid-structure' });
  });

  it('reports no-compatible-session for an empty store', async () => {
    const fs = fileOf({});
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
      kind: 'no-compatible-session',
    });
  });

  it('reports no-compatible-session when entries are missing key/user_id', async () => {
    const fs = fileOf({ scope1: { auth_mode: 'oidc' } });
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
      kind: 'no-compatible-session',
    });
  });

  it('rejects a generic nested "key" field anywhere in the document as a token candidate', async () => {
    const fs = fileOf({ settings: { nested: { key: 'not-a-credential' } } });
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
      kind: 'no-compatible-session',
    });
  });

  it('reports unsupported-auth-mode when no entry has a recognized auth_mode', async () => {
    const fs = fileOf({ scope1: oidcEntry({ auth_mode: 'legacy-cookie' }) });
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
      kind: 'unsupported-auth-mode',
    });
  });

  it('reports session-expired when every supported-mode entry has an expires_at in the past', async () => {
    const fs = fileOf({
      scope1: oidcEntry({ expires_at: Math.floor(Date.now() / 1000) - 3600 }),
    });
    expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({ kind: 'session-expired' });
  });

  it('accepts an entry with no expires_at field as not expired', async () => {
    const fs = fileOf({ scope1: oidcEntry({ expires_at: undefined }) });
    const result = await readGrokAuthToken(fs, 'C:\\Users\\me');
    expect(result.kind).toBe('ok');
  });

  it('never returns refresh_token, email, or team fields', async () => {
    const fs = fileOf({
      scope1: oidcEntry({
        refresh_token: 'must-not-return',
        email: 'user@example.com',
        team_name: 'Acme',
      }),
    });
    const result = await readGrokAuthToken(fs, 'C:\\Users\\me');
    expect(JSON.stringify(result)).not.toContain('must-not-return');
    expect(JSON.stringify(result)).not.toContain('user@example.com');
    expect(JSON.stringify(result)).not.toContain('Acme');
  });

  describe('deterministic selection among multiple candidates', () => {
    it('prefers a first-party OIDC credential over an api_key credential', async () => {
      const fs = fileOf({
        apiKeyScope: oidcEntry({
          key: 'api-key-token',
          user_id: 'user-api',
          auth_mode: 'api_key',
          oidc_issuer: undefined,
        }),
        oidcScope: oidcEntry({ key: 'oidc-token', user_id: 'user-oidc' }),
      });
      expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
        kind: 'ok',
        token: 'oidc-token',
        userId: 'user-oidc',
      });
    });

    it('deprioritizes a non-first-party OIDC issuer behind a first-party one', async () => {
      const fs = fileOf({
        thirdParty: oidcEntry({
          key: 'third-party-token',
          user_id: 'user-3p',
          oidc_issuer: 'https://not-xai.example.com',
        }),
        firstParty: oidcEntry({ key: 'first-party-token', user_id: 'user-1p' }),
      });
      expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
        kind: 'ok',
        token: 'first-party-token',
        userId: 'user-1p',
      });
    });

    it('prefers the newest create_time among equally first-party candidates', async () => {
      const fs = fileOf({
        older: oidcEntry({ key: 'older-token', user_id: 'user-old', create_time: 1_000 }),
        newer: oidcEntry({ key: 'newer-token', user_id: 'user-new', create_time: 2_000 }),
      });
      expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
        kind: 'ok',
        token: 'newer-token',
        userId: 'user-new',
      });
    });

    it('excludes an expired candidate even when another candidate is a lower preference tier', async () => {
      const fs = fileOf({
        expiredFirstParty: oidcEntry({
          key: 'expired-token',
          user_id: 'user-expired',
          expires_at: Math.floor(Date.now() / 1000) - 60,
        }),
        liveApiKey: oidcEntry({
          key: 'live-token',
          user_id: 'user-live',
          auth_mode: 'api_key',
          oidc_issuer: undefined,
        }),
      });
      expect(await readGrokAuthToken(fs, 'C:\\Users\\me')).toEqual({
        kind: 'ok',
        token: 'live-token',
        userId: 'user-live',
      });
    });

    it('is deterministic (stable scope-key tie-break) across repeated calls', async () => {
      const store = {
        b: oidcEntry({ key: 'b-token', user_id: 'user-b', create_time: 1_000 }),
        a: oidcEntry({ key: 'a-token', user_id: 'user-a', create_time: 1_000 }),
      };
      const first = await readGrokAuthToken(fileOf(store), 'C:\\Users\\me');
      const second = await readGrokAuthToken(fileOf(store), 'C:\\Users\\me');
      expect(first).toEqual(second);
      expect(first).toEqual({ kind: 'ok', token: 'a-token', userId: 'user-a' });
    });
  });
});
