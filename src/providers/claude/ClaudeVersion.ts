/** Minimal numeric-triplet version compare — enough for "x.y.z" style CLI/extension versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The first Claude Code release documented to provide the extended statusLine rate-limit contract. */
export const MIN_STATUSLINE_CONTRACT_VERSION = '2.1.80';

/** Returns null (unknown — never treated as incompatible) when the version string can't be parsed. */
export function isVersionAtLeast(
  version: string | null | undefined,
  minimum: string,
): boolean | null {
  if (!version || !/^\d+(\.\d+)*/.test(version)) return null;
  return compareVersions(version, minimum) >= 0;
}
