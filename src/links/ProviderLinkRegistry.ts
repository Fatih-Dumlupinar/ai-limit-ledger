import { isIP } from 'node:net';
import type { ProviderId } from '../providers/types';

export type ProviderLinkCategory =
  | 'usage'
  | 'billing'
  | 'settings'
  | 'installation'
  | 'documentation'
  | 'marketplace'
  | 'repository'
  | 'support';

export type ProviderLinkStability =
  'official-documented' | 'official-product-route' | 'official-repository';

export type ProviderLinkId =
  | 'codex-usage'
  | 'codex-cli-docs'
  | 'codex-limits-docs'
  | 'codex-ide-docs'
  | 'claude-usage'
  | 'claude-install'
  | 'claude-vscode-docs'
  | 'claude-cost-docs'
  | 'claude-errors-docs'
  | 'copilot-billing'
  | 'copilot-usage-docs'
  | 'copilot-cli-install'
  | 'copilot-cli-quickstart'
  | 'copilot-settings'
  | 'copilot-vscode-extension'
  | 'copilot-plans-docs'
  | 'grok-home'
  | 'grok-billing'
  | 'grok-install'
  | 'grok-cli-reference'
  | 'grok-usage-docs'
  | 'grok-official-repository';

export interface ProviderLinkDefinition {
  readonly id: ProviderLinkId;
  readonly providerId: ProviderId;
  readonly category: ProviderLinkCategory;
  readonly label: string;
  readonly url: string;
  readonly stability: ProviderLinkStability;
  readonly requiresAuthentication: boolean;
  readonly description: string;
}

export interface ProviderInstallGuidance {
  readonly providerId: ProviderId;
  readonly requiredForAutomaticUsage: boolean;
  readonly summary: string;
  readonly installLinkId?: ProviderLinkId;
  readonly documentationLinkId?: ProviderLinkId;
  readonly cliUsageInstruction?: string;
}

/** Exact hosts only. Do not replace this with a suffix or wildcard check. */
export const ALLOWED_PROVIDER_LINK_HOSTS = [
  'chatgpt.com',
  'learn.chatgpt.com',
  'claude.ai',
  'code.claude.com',
  'github.com',
  'docs.github.com',
  'marketplace.visualstudio.com',
  'docs.x.ai',
  'grok.com',
] as const;

const allowedHosts = new Set<string>(ALLOWED_PROVIDER_LINK_HOSTS);
const allowedQueryKeys = new Set(['_s', 'itemname']);
const allowedQueryValues: Readonly<Record<string, ReadonlySet<string>>> = {
  _s: new Set(['billing']),
  itemname: new Set(['GitHub.copilot-chat']),
};
const blockedQueryKeys = new Set([
  'token',
  'access_token',
  'auth',
  'key',
  'api_key',
  'session',
  'code',
  'state',
  'email',
  'user',
  'account',
  'redirect',
  'returnurl',
]);
const blockedShortenerHosts = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
]);
const allowedFragments = new Set(['', 'usage']);
const MAX_PROVIDER_LINK_URL_LENGTH = 2048;

export interface ProviderLinkUrlValidation {
  readonly valid: boolean;
  readonly reason?:
    | 'empty'
    | 'too-long'
    | 'invalid-url'
    | 'invalid-protocol'
    | 'host-not-allowed'
    | 'userinfo-not-allowed'
    | 'port-not-allowed'
    | 'ip-not-allowed'
    | 'shortener-not-allowed'
    | 'query-key-not-allowed'
    | 'query-value-not-allowed'
    | 'fragment-not-allowed';
}

function invalid(reason: ProviderLinkUrlValidation['reason']): ProviderLinkUrlValidation {
  return { valid: false, reason };
}

/** Validates a fixed registry URL without making a network request. */
export function validateProviderLinkUrl(url: string): ProviderLinkUrlValidation {
  if (!url) return invalid('empty');
  if (url.length > MAX_PROVIDER_LINK_URL_LENGTH) return invalid('too-long');

  let parsed: globalThis.URL;
  try {
    parsed = new globalThis.URL(url);
  } catch {
    return invalid('invalid-url');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:') return invalid('invalid-protocol');
  if (!allowedHosts.has(hostname) || hostname.includes('xn--')) return invalid('host-not-allowed');
  if (parsed.username || parsed.password) return invalid('userinfo-not-allowed');
  if (parsed.port && parsed.port !== '443') return invalid('port-not-allowed');
  if (isIP(hostname) !== 0 || hostname === 'localhost') return invalid('ip-not-allowed');
  if (blockedShortenerHosts.has(hostname)) return invalid('shortener-not-allowed');

  for (const [key, value] of parsed.searchParams.entries()) {
    const normalizedKey = key.toLowerCase();
    if (blockedQueryKeys.has(normalizedKey) || !allowedQueryKeys.has(normalizedKey))
      return invalid('query-key-not-allowed');
    const values = allowedQueryValues[normalizedKey];
    if (!values?.has(value)) return invalid('query-value-not-allowed');
  }
  if (!allowedFragments.has(parsed.hash.slice(1))) return invalid('fragment-not-allowed');
  return { valid: true };
}

export function isAllowedProviderLinkUrl(url: string): boolean {
  return validateProviderLinkUrl(url).valid;
}

const definitions: readonly ProviderLinkDefinition[] = [
  {
    id: 'codex-usage',
    providerId: 'codex',
    category: 'usage',
    label: 'Open Codex usage dashboard',
    url: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
    stability: 'official-product-route',
    requiresAuthentication: true,
    description: 'Authenticated ChatGPT Codex usage dashboard.',
  },
  {
    id: 'codex-cli-docs',
    providerId: 'codex',
    category: 'installation',
    label: 'Open Codex CLI documentation',
    url: 'https://learn.chatgpt.com/docs/codex/cli',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Codex CLI installation and usage documentation.',
  },
  {
    id: 'codex-limits-docs',
    providerId: 'codex',
    category: 'documentation',
    label: 'Open Codex limits and pricing documentation',
    url: 'https://learn.chatgpt.com/docs/pricing',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official ChatGPT pricing and limits documentation.',
  },
  {
    id: 'codex-ide-docs',
    providerId: 'codex',
    category: 'documentation',
    label: 'Open Codex IDE documentation',
    url: 'https://learn.chatgpt.com/docs/codex/ide',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Codex IDE integration documentation.',
  },
  {
    id: 'claude-usage',
    providerId: 'claude',
    category: 'usage',
    label: 'Open Claude usage settings',
    url: 'https://claude.ai/settings/usage',
    stability: 'official-product-route',
    requiresAuthentication: true,
    description: 'Authenticated Claude account usage settings.',
  },
  {
    id: 'claude-install',
    providerId: 'claude',
    category: 'installation',
    label: 'Open Claude Code installation guide',
    url: 'https://code.claude.com/docs/en/setup',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Claude Code setup and installation guide.',
  },
  {
    id: 'claude-vscode-docs',
    providerId: 'claude',
    category: 'documentation',
    label: 'Open Claude Code VS Code documentation',
    url: 'https://code.claude.com/docs/en/vs-code',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Claude Code VS Code integration documentation.',
  },
  {
    id: 'claude-cost-docs',
    providerId: 'claude',
    category: 'documentation',
    label: 'Open Claude Code usage and costs documentation',
    url: 'https://code.claude.com/docs/en/costs',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Claude Code usage and cost documentation.',
  },
  {
    id: 'claude-errors-docs',
    providerId: 'claude',
    category: 'support',
    label: 'Open Claude Code errors documentation',
    url: 'https://code.claude.com/docs/en/errors',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Claude Code error and troubleshooting reference.',
  },
  {
    id: 'copilot-billing',
    providerId: 'copilot',
    category: 'billing',
    label: 'Open GitHub billing',
    url: 'https://github.com/settings/billing',
    stability: 'official-product-route',
    requiresAuthentication: true,
    description: 'Authenticated GitHub billing overview for Copilot usage.',
  },
  {
    id: 'copilot-usage-docs',
    providerId: 'copilot',
    category: 'documentation',
    label: 'Open Copilot usage documentation',
    url: 'https://docs.github.com/en/billing/concepts/product-billing/github-copilot-billing',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official GitHub Copilot AI credit and billing documentation.',
  },
  {
    id: 'copilot-cli-install',
    providerId: 'copilot',
    category: 'installation',
    label: 'Install Copilot CLI — optional',
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Optional official Copilot CLI installation guide; not required for usage data.',
  },
  {
    id: 'copilot-cli-quickstart',
    providerId: 'copilot',
    category: 'documentation',
    label: 'Open Copilot CLI quickstart',
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Copilot CLI getting-started guide.',
  },
  {
    id: 'copilot-settings',
    providerId: 'copilot',
    category: 'settings',
    label: 'Open Copilot settings',
    url: 'https://github.com/settings/copilot',
    stability: 'official-product-route',
    requiresAuthentication: true,
    description: 'Authenticated GitHub Copilot account settings.',
  },
  {
    id: 'copilot-vscode-extension',
    providerId: 'copilot',
    category: 'marketplace',
    label: 'Open the official Copilot VS Code extension',
    url: 'https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official GitHub Copilot Chat VS Code Marketplace listing.',
  },
  {
    id: 'copilot-plans-docs',
    providerId: 'copilot',
    category: 'documentation',
    label: 'Open Copilot plans documentation',
    url: 'https://github.com/features/copilot/plans',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official GitHub Copilot plans and allowance documentation.',
  },
  {
    id: 'grok-home',
    providerId: 'grok',
    category: 'support',
    label: 'Open Grok',
    url: 'https://grok.com/',
    stability: 'official-product-route',
    requiresAuthentication: false,
    description: 'Grok product home; not a numeric usage page.',
  },
  {
    id: 'grok-billing',
    providerId: 'grok',
    category: 'billing',
    label: 'Open Grok billing',
    url: 'https://grok.com/?_s=billing',
    stability: 'official-product-route',
    requiresAuthentication: true,
    description: 'Authenticated Grok billing/manage route referenced by Grok account material.',
  },
  {
    id: 'grok-install',
    providerId: 'grok',
    category: 'installation',
    label: 'Open Grok Build installation guide',
    url: 'https://docs.x.ai/build/overview',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Grok Build installation and getting-started documentation.',
  },
  {
    id: 'grok-cli-reference',
    providerId: 'grok',
    category: 'documentation',
    label: 'Open Grok Build CLI reference',
    url: 'https://docs.x.ai/build/cli/reference',
    stability: 'official-documented',
    requiresAuthentication: false,
    description: 'Official Grok Build CLI command reference.',
  },
  {
    id: 'grok-usage-docs',
    providerId: 'grok',
    category: 'documentation',
    label: 'Open the official Grok Build /usage guide',
    url: 'https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md',
    stability: 'official-repository',
    requiresAuthentication: false,
    description: 'Official Grok Build repository guide documenting /usage and /usage manage.',
  },
  {
    id: 'grok-official-repository',
    providerId: 'grok',
    category: 'repository',
    label: 'Open official Grok Build repository',
    url: 'https://github.com/xai-org/grok-build',
    stability: 'official-repository',
    requiresAuthentication: false,
    description: 'Verified first-party xai-org Grok Build repository.',
  },
];

export interface ProviderLinkRegistryValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export function validateProviderLinkDefinitions(
  values: readonly ProviderLinkDefinition[],
): ProviderLinkRegistryValidation {
  const issues: string[] = [];
  const ids = new Set<string>();
  const duplicatePurpose = new Set<string>();
  for (const definition of values) {
    if (ids.has(definition.id)) issues.push(`duplicate-link-id:${definition.id}`);
    ids.add(definition.id);
    const urlResult = validateProviderLinkUrl(definition.url);
    if (!urlResult.valid) issues.push(`invalid-url:${definition.id}:${urlResult.reason}`);
    if (!definition.providerId) issues.push(`missing-provider-id:${definition.id}`);
    if (!definition.category) issues.push(`missing-category:${definition.id}`);
    if (!definition.stability) issues.push(`missing-stability:${definition.id}`);
    const purpose = `${definition.providerId}:${definition.category}:${definition.url}`;
    if (duplicatePurpose.has(purpose)) issues.push(`duplicate-purpose:${purpose}`);
    duplicatePurpose.add(purpose);
  }
  return { valid: issues.length === 0, issues };
}

function freezeDefinition(definition: ProviderLinkDefinition): ProviderLinkDefinition {
  return Object.freeze({ ...definition });
}

export class ProviderLinkRegistry {
  readonly version = '1';
  readonly definitions: readonly ProviderLinkDefinition[];
  private readonly byId: ReadonlyMap<ProviderLinkId, ProviderLinkDefinition>;

  constructor(values: readonly ProviderLinkDefinition[] = definitions) {
    const validation = validateProviderLinkDefinitions(values);
    if (!validation.valid)
      throw new Error(`Invalid provider link registry: ${validation.issues.join(', ')}`);
    this.definitions = Object.freeze(values.map(freezeDefinition));
    this.byId = new Map(this.definitions.map((definition) => [definition.id, definition]));
  }

  get(id: string): ProviderLinkDefinition | undefined {
    return this.byId.get(id as ProviderLinkId);
  }

  forProvider(providerId: ProviderId): readonly ProviderLinkDefinition[] {
    return this.definitions.filter((definition) => definition.providerId === providerId);
  }
}

export const providerLinkRegistry = new ProviderLinkRegistry();
export const PROVIDER_LINK_REGISTRY = providerLinkRegistry.definitions;

export function getProviderLink(id: ProviderLinkId): ProviderLinkDefinition {
  const definition = providerLinkRegistry.get(id);
  if (!definition) throw new Error(`Unknown provider link ID: ${id}`);
  return definition;
}

export function getProviderLinks(providerId: ProviderId): readonly ProviderLinkDefinition[] {
  return providerLinkRegistry.forProvider(providerId);
}

const installGuidance: Readonly<Record<ProviderId, ProviderInstallGuidance>> = Object.freeze({
  codex: Object.freeze({
    providerId: 'codex',
    requiredForAutomaticUsage: true,
    summary: 'Codex CLI/App Server is required for automatic usage.',
    installLinkId: 'codex-cli-docs',
    documentationLinkId: 'codex-cli-docs',
  }),
  claude: Object.freeze({
    providerId: 'claude',
    requiredForAutomaticUsage: true,
    summary:
      'Claude CLI provides official status-line metrics. CLI-free account usage is experimental and requires explicit opt-in.',
    installLinkId: 'claude-install',
    documentationLinkId: 'claude-vscode-docs',
    cliUsageInstruction: 'Use /usage inside Claude Code for the official CLI usage view.',
  }),
  copilot: Object.freeze({
    providerId: 'copilot',
    requiredForAutomaticUsage: false,
    summary: 'Copilot CLI is optional and is not required for usage data.',
    installLinkId: 'copilot-cli-install',
    documentationLinkId: 'copilot-usage-docs',
  }),
  grok: Object.freeze({
    providerId: 'grok',
    requiredForAutomaticUsage: true,
    summary: 'Grok Build CLI and login are required for automatic usage.',
    installLinkId: 'grok-install',
    documentationLinkId: 'grok-cli-reference',
    cliUsageInstruction: 'Use /usage inside Grok Build for the official account view.',
  }),
});

export function getProviderInstallGuidance(providerId: ProviderId): ProviderInstallGuidance {
  return installGuidance[providerId];
}
