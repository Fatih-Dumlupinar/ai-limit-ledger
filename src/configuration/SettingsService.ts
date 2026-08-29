import * as vscode from 'vscode';
import {
  normalizeSettings,
  redactEffectiveSettings,
  type EffectiveSettings,
  type RawSettings,
} from './EffectiveSettings';
import { SETTINGS_BY_KEY, SETTINGS_SCHEMA, type SettingCategory } from './SettingsSchema';
import { fullSettingKey, SETTINGS_SECTION, type SettingKey } from './SettingsKeys';
import { diagnostic, type SettingsDiagnostic } from './SettingsDiagnostics';

export interface ConfigurationInspection<T = unknown> {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  defaultValue?: T;
}

export interface ConfigurationLike {
  get<T>(key: string, defaultValue?: T): T;
  inspect?<T>(key: string): ConfigurationInspection<T> | undefined;
  update?(key: string, value: unknown, target?: unknown): PromiseLike<void>;
}

export interface SettingsChangeEvent {
  changedKeys: SettingKey[];
  categories: SettingCategory[];
  requiresReload: boolean;
  requiresTimerReschedule: boolean;
  requiresProviderReconcile: boolean;
  providerRedetection: SettingKey[];
  diagnostics: SettingsDiagnostic[];
  previousSettings: EffectiveSettings;
  languageChanged: boolean;
  settings: EffectiveSettings;
}

export interface SettingsServiceOptions {
  configuration?: ConfigurationLike;
  debounceMs?: number;
}

function defaultConfiguration(): ConfigurationLike {
  return vscode.workspace.getConfiguration(SETTINGS_SECTION);
}

function changedKeysFor(event: { affectsConfiguration(key: string): boolean }): SettingKey[] {
  return SETTINGS_SCHEMA.filter((setting) =>
    event.affectsConfiguration(fullSettingKey(setting.key)),
  ).map((setting) => setting.key);
}

/** The only runtime reader for user-facing extension settings. */
export class SettingsService implements vscode.Disposable {
  private readonly config: ConfigurationLike;
  private readonly debounceMs: number;
  private readonly emitter = new vscode.EventEmitter<SettingsChangeEvent>();
  private pendingKeys = new Set<SettingKey>();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private snapshot: EffectiveSettings;
  readonly onDidChange = this.emitter.event;

  constructor(options: SettingsServiceOptions = {}) {
    this.config = options.configuration ?? defaultConfiguration();
    this.debounceMs = options.debounceMs ?? 25;
    this.snapshot = this.readSnapshot();
  }

  get settings(): EffectiveSettings {
    return this.snapshot;
  }

  getSnapshot(): EffectiveSettings {
    return this.snapshot;
  }

  getDiagnostics(): SettingsDiagnostic[] {
    return this.snapshot.diagnostics.map((entry) => ({ ...entry }));
  }

  /** Raw lookup kept for the small number of provider-owned legacy helpers. */
  get<T>(key: SettingKey): T {
    return this.rawValue(key) as T;
  }

  redactedSnapshot(): Record<string, unknown> {
    return redactEffectiveSettings(this.snapshot);
  }

  reload(): EffectiveSettings {
    this.snapshot = this.readSnapshot();
    return this.snapshot;
  }

  /** Debounced configuration event entry point; no setting is written or removed. */
  handleConfigurationChange(event: { affectsConfiguration(key: string): boolean }): void {
    if (this.disposed) return;
    changedKeysFor(event).forEach((key) => this.pendingKeys.add(key));
    if (!this.pendingKeys.size || this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.flush();
    }, this.debounceMs);
  }

  flush(): void {
    if (this.disposed || !this.pendingKeys.size) return;
    const changedKeys = [...this.pendingKeys];
    this.pendingKeys.clear();
    const previousSettings = this.snapshot;
    this.snapshot = this.readSnapshot();
    const categories = [
      ...new Set(
        changedKeys
          .map((key) => SETTINGS_BY_KEY.get(key)?.category)
          .filter((value): value is SettingCategory => Boolean(value)),
      ),
    ];
    const definitions = changedKeys
      .map((key) => SETTINGS_BY_KEY.get(key))
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
    this.emitter.fire({
      changedKeys,
      categories,
      requiresReload: false,
      requiresTimerReschedule: definitions.some((definition) => definition.requiresTimerReschedule),
      requiresProviderReconcile: changedKeys.includes('providers'),
      providerRedetection: definitions
        .filter((definition) => definition.requiresProviderDetection)
        .map((definition) => definition.key),
      diagnostics: this.getDiagnostics(),
      previousSettings,
      languageChanged: previousSettings.display.language !== this.snapshot.display.language,
      settings: this.snapshot,
    });
  }

  async update(key: SettingKey, value: unknown, target?: unknown): Promise<void> {
    if (!this.config.update) throw new Error('Settings updates are unavailable in this host.');
    await this.config.update(key, value, target);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingKeys.clear();
    this.emitter.dispose();
  }

  private rawValue(key: SettingKey): unknown {
    const definition = SETTINGS_BY_KEY.get(key);
    const inspection = this.config.inspect?.(key);
    if (definition?.scope === 'machine' && inspection) {
      // A machine setting must never fall back to a workspace value.
      return inspection.globalValue !== undefined
        ? inspection.globalValue
        : (inspection.defaultValue ?? this.config.get(key, definition.default));
    }
    return this.config.get(key, definition?.default);
  }

  private readSnapshot(): EffectiveSettings {
    const raw: RawSettings = {};
    for (const setting of SETTINGS_SCHEMA) raw[setting.key] = this.rawValue(setting.key);
    const normalized = normalizeSettings(raw);
    const ignoredWorkspaceSettings = SETTINGS_SCHEMA.filter((setting) => {
      if (setting.scope !== 'machine' || !this.config.inspect) return false;
      const inspection = this.config.inspect(setting.key);
      return (
        inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined
      );
    });
    const workspaceDiagnostics = ignoredWorkspaceSettings.map((setting) =>
      diagnostic('workspace-value-ignored', setting.key),
    );
    return {
      ...normalized,
      diagnostics: [...normalized.diagnostics, ...workspaceDiagnostics],
    };
  }
}

export function createSettingsService(options: SettingsServiceOptions = {}): SettingsService {
  return new SettingsService(options);
}
