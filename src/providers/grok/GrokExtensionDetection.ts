import type { GrokExtensionInfo } from './types';

export interface GrokExtensionLike {
  id: string;
  packageJSON?: { version?: unknown; publisher?: unknown; name?: unknown };
}

/** The known community extension is surfaced as community-only, never as an official xAI integration. */
export function detectGrokExtension(extensions: readonly GrokExtensionLike[]): GrokExtensionInfo {
  const extension = extensions.find(
    (item) => item.id.toLowerCase() === 'pawelhuryn.grok-vscode-phuryn',
  );
  return {
    installed: Boolean(extension),
    id: extension?.id ?? null,
    version:
      typeof extension?.packageJSON?.version === 'string' ? extension.packageJSON.version : null,
    official: false,
  };
}
