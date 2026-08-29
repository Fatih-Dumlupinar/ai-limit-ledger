export interface GitHubAuthenticationSession {
  accessToken: string;
  account?: { id: string; label: string };
}

export interface GitHubAuthenticationApi {
  getSession(
    providerId: string,
    scopes: readonly string[],
    options?: { createIfNone?: boolean; silent?: boolean },
  ): PromiseLike<GitHubAuthenticationSession | undefined>;
}

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface GitHubPrompt {
  choose(
    items: Array<'Sign in with GitHub' | 'Use fine-grained PAT' | 'Cancel'>,
  ): PromiseLike<'Sign in with GitHub' | 'Use fine-grained PAT' | 'Cancel' | undefined>;
  input(prompt: string): PromiseLike<string | undefined>;
}

export const COPILOT_PAT_SECRET_KEY = 'aiLimitLedger.copilot.githubPlanReadPat';
export const GITHUB_AUTH_SCOPES = ['user:email'] as const;

/**
 * Authentication order is deliberately VS Code's public GitHub auth API, then an explicitly
 * entered fine-grained PAT. No Copilot cache, CLI credential, globalState, or workspaceState is
 * read or written here.
 */
export class GitHubAuthenticationService {
  constructor(
    private readonly authentication: GitHubAuthenticationApi,
    private readonly secrets: SecretStorageLike,
    private readonly prompt?: GitHubPrompt,
  ) {}

  async getToken(interactive = false): Promise<string | undefined> {
    const session = await this.authentication.getSession('github', GITHUB_AUTH_SCOPES, {
      createIfNone: interactive,
      silent: !interactive,
    });
    if (session?.accessToken) return session.accessToken;
    return this.secrets.get(COPILOT_PAT_SECRET_KEY);
  }

  async connect(): Promise<'connected' | 'cancelled'> {
    if (!this.prompt) return 'cancelled';
    const choice = await this.prompt.choose([
      'Sign in with GitHub',
      'Use fine-grained PAT',
      'Cancel',
    ]);
    if (!choice || choice === 'Cancel') return 'cancelled';
    if (choice === 'Sign in with GitHub') {
      const session = await this.authentication.getSession('github', GITHUB_AUTH_SCOPES, {
        createIfNone: true,
      });
      return session?.accessToken ? 'connected' : 'cancelled';
    }
    const token = (
      await this.prompt.input(
        'Paste a fine-grained GitHub PAT with only Plan: read permission. It is stored in VS Code SecretStorage and never logged.',
      )
    )?.trim();
    if (!token) return 'cancelled';
    await this.secrets.store(COPILOT_PAT_SECRET_KEY, token);
    return 'connected';
  }

  async disconnect(): Promise<void> {
    await this.secrets.delete(COPILOT_PAT_SECRET_KEY);
  }
}
