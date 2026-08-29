import type { CopilotExtensionInfo } from './types';

export interface ExtensionLike {
  id: string;
  packageJSON?: { version?: unknown };
}

const KNOWN_COPILOT_EXTENSION_IDS = ['GitHub.copilot', 'GitHub.copilot-chat'];

export function detectCopilotExtensions(
  extensions: readonly ExtensionLike[],
): CopilotExtensionInfo {
  const matches = extensions.filter((extension) =>
    KNOWN_COPILOT_EXTENSION_IDS.some((id) => id.toLowerCase() === extension.id.toLowerCase()),
  );
  const versions = matches
    .map((extension) => extension.packageJSON?.version)
    .filter((version): version is string => typeof version === 'string');
  return {
    installed: matches.length > 0,
    version: versions[0] ?? null,
    ids: matches.map((extension) => extension.id),
  };
}

export const COPILOT_EXTENSION_IDS = [...KNOWN_COPILOT_EXTENSION_IDS];
