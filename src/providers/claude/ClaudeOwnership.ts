import { createHash } from 'node:crypto';
import {
  CURRENT_SCHEMA_VERSION,
  LEGACY_MARKER_STRING,
  OWNER_MARKER,
  type IntegrationMode,
} from './types';

export interface MarkerInfo {
  owned: boolean;
  legacy: boolean;
  mode: IntegrationMode | null;
  schemaVersion: number | null;
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

/** Hashes a statusLine value for tamper/drift detection between what we wrote and what is now on disk. */
export function hashStatusLine(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}

/** Hashes arbitrary text content (e.g. a generated wrapper script) for staleness/tamper detection. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Reads and normalizes both the current (object) and legacy (bare string) AI Limit Ledger markers. */
export function readMarker(statusLine: unknown): MarkerInfo {
  const status = asObject(statusLine);
  if (!status) return { owned: false, legacy: false, mode: null, schemaVersion: null };
  const raw = status._aiLimitLedger;
  if (raw === LEGACY_MARKER_STRING) {
    return { owned: true, legacy: true, mode: 'standalone', schemaVersion: 1 };
  }
  const markerObject = asObject(raw);
  if (markerObject && markerObject.marker === OWNER_MARKER) {
    const mode = markerObject.mode === 'chained' ? 'chained' : 'standalone';
    const schemaVersion =
      typeof markerObject.schemaVersion === 'number' ? markerObject.schemaVersion : 1;
    return { owned: true, legacy: false, mode, schemaVersion };
  }
  return { owned: false, legacy: false, mode: null, schemaVersion: null };
}

export function buildMarker(mode: IntegrationMode): Json {
  return { marker: OWNER_MARKER, mode, schemaVersion: CURRENT_SCHEMA_VERSION };
}

/**
 * Normalized comparison of a statusLine command against one of our known wrapper paths.
 * Case-insensitive and slash-insensitive so Windows path casing/separator differences don't
 * cause false negatives.
 */
export function commandTargetsPath(
  command: unknown,
  targetPath: string | null | undefined,
): boolean {
  if (typeof command !== 'string' || !command || !targetPath) return false;
  const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
  return norm(command).includes(norm(targetPath));
}

export interface OwnershipClassification {
  owned: boolean;
  mode: IntegrationMode | null;
  matchedPath: string | null;
}

/**
 * Classifies whether a statusLine is ours by structural command/path recognition — never by the
 * undocumented `_aiLimitLedger` marker alone, since Claude Code silently strips unrecognized
 * statusLine properties on any settings rewrite (its statusLine schema has no passthrough).
 *
 * Recognition order: previously recorded ownership metadata's wrapper path (covers a wrapper
 * that was moved/renamed across versions), then the current chained wrapper path, then the
 * current standalone wrapper path. The legacy string marker is checked last, purely as a
 * best-effort signal for pre-0.3.2 installs where the command shape itself may not be
 * recognizable.
 */
export function classifyOwnership(
  statusLine: unknown,
  ownershipWrapperPath: string | null | undefined,
  chainedPath: string,
  standalonePath: string,
): OwnershipClassification {
  const status = asObject(statusLine);
  const command = status?.command;
  if (commandTargetsPath(command, ownershipWrapperPath)) {
    return { owned: true, mode: null, matchedPath: ownershipWrapperPath ?? null };
  }
  if (commandTargetsPath(command, chainedPath)) {
    return { owned: true, mode: 'chained', matchedPath: chainedPath };
  }
  if (commandTargetsPath(command, standalonePath)) {
    return { owned: true, mode: 'standalone', matchedPath: standalonePath };
  }
  const legacyMarker = readMarker(statusLine);
  if (legacyMarker.owned) {
    return { owned: true, mode: legacyMarker.mode, matchedPath: null };
  }
  return { owned: false, mode: null, matchedPath: null };
}

export { CURRENT_SCHEMA_VERSION };
