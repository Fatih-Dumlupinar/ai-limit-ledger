import { deriveAccessMode } from './ClaudeAccessMode';
import { classifyOwnership } from './ClaudeOwnership';
import { resolveEffectiveStatusLine } from './ClaudeConfigPrecedence';
import type { ClaudeHostKind } from './ClaudeHostDetection';
import type { ClaudeProviderClassification } from '../ClaudeCodeProvider';

export interface ClassifierInputs {
  userStatusLine: unknown;
  projectSharedStatusLine: unknown;
  projectLocalStatusLine: unknown;
  ownershipWrapperPath: string | null;
  chainedPath: string;
  standalonePath: string;
  wrapperFileExists: boolean;
  cliVersionCompatible: boolean | null;
  awaitingSessionRestart: boolean;
  /** ISO timestamp the integration was last (re-)enabled, or null when unknown. */
  enabledAt: string | null;
  /** True only after an explicit successful Disable command. */
  explicitlyDisabled?: boolean;
  /** Current time in ms, for computing msSinceEnabled. */
  now: number;
  hostKind: ClaudeHostKind;
  extensionVersion: string | null;
}

/** Pure composition of precedence resolution + structural ownership recognition into the flat shape ClaudeCodeProvider needs. */
export function computeClassification(inputs: ClassifierInputs): ClaudeProviderClassification {
  const { effectiveStatusLine, winningScope } = resolveEffectiveStatusLine(
    inputs.userStatusLine,
    inputs.projectSharedStatusLine,
    inputs.projectLocalStatusLine,
  );
  const effective = classifyOwnership(
    effectiveStatusLine,
    inputs.ownershipWrapperPath,
    inputs.chainedPath,
    inputs.standalonePath,
  );
  const userOwned = classifyOwnership(
    inputs.userStatusLine,
    inputs.ownershipWrapperPath,
    inputs.chainedPath,
    inputs.standalonePath,
  ).owned;
  const shadowedByProject = winningScope !== 'user' && userOwned && !effective.owned;
  const enabledAtMs = inputs.enabledAt ? Date.parse(inputs.enabledAt) : NaN;
  const msSinceEnabled = Number.isNaN(enabledAtMs) ? null : Math.max(0, inputs.now - enabledAtMs);
  return {
    ownedEffective: effective.owned,
    effectiveStatusLinePresent: winningScope !== 'none',
    shadowedByProject,
    wrapperExists: inputs.wrapperFileExists,
    cliVersionCompatible: inputs.cliVersionCompatible,
    awaitingSessionRestart: inputs.awaitingSessionRestart,
    explicitlyDisabled: inputs.explicitlyDisabled,
    msSinceEnabled,
    hostKind: inputs.hostKind,
    accessMode: deriveAccessMode(inputs.hostKind),
    extensionVersion: inputs.extensionVersion,
  };
}
