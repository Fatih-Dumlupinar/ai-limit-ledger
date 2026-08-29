export type SettingsDiagnosticCode =
  | 'invalid-type'
  | 'invalid-enum'
  | 'invalid-number'
  | 'below-minimum'
  | 'above-maximum'
  | 'unknown-provider'
  | 'duplicate-provider'
  | 'invalid-threshold-order'
  | 'workspace-value-ignored'
  | 'cache-expired';

export interface SettingsDiagnostic {
  code: SettingsDiagnosticCode;
  key?: string;
  /** Safe, bounded detail. Raw values are deliberately not retained. */
  detail?: string;
}

export class SettingsDiagnostics {
  private readonly entries: SettingsDiagnostic[] = [];

  add(entry: SettingsDiagnostic): void {
    if (
      this.entries.some(
        (existing) =>
          existing.code === entry.code &&
          existing.key === entry.key &&
          existing.detail === entry.detail,
      )
    )
      return;
    this.entries.push({ ...entry });
  }

  addAll(entries: readonly SettingsDiagnostic[]): void {
    entries.forEach((entry) => this.add(entry));
  }

  toArray(): SettingsDiagnostic[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  get size(): number {
    return this.entries.length;
  }
}

export function diagnostic(
  code: SettingsDiagnosticCode,
  key?: string,
  detail?: string,
): SettingsDiagnostic {
  return { code, ...(key ? { key } : {}), ...(detail ? { detail } : {}) };
}
