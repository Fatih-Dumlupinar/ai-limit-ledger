import * as vscode from 'vscode';
import type { LanguagePreference, TimeFormat } from '../configuration/EffectiveSettings';
import { EN } from './locales/en';
import { TR } from './locales/tr';
import type { LocalizationKey, TranslationParams } from './LocalizationKeys';

export type RuntimeLanguage = 'en' | 'tr';

export type TimestampRole = 'past-event' | 'future-target' | 'deadline' | 'snapshot-age';

export interface LocalizationChangeEvent {
  language: RuntimeLanguage;
  previousLanguage: RuntimeLanguage;
  preference: LanguagePreference;
}

/** Pure resolver used by both the runtime service and unit tests. */
export function resolveRuntimeLanguage(
  preference: LanguagePreference = 'auto',
  vscodeLanguage = 'en',
): RuntimeLanguage {
  if (preference === 'tr' || preference === 'en') return preference;
  return /^tr(?:[-_]|$)/i.test(String(vscodeLanguage).trim()) ? 'tr' : 'en';
}

function interpolate(template: string, params?: TranslationParams): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = params?.[name];
    return value === undefined ? '' : String(value).replace(/[\r\n]/g, ' ');
  });
}

function finiteTimestamp(timestamp: number): boolean {
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8640000000000000;
}

function compactDuration(
  milliseconds: number,
  language: RuntimeLanguage,
  allowJustNow: boolean,
): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) {
    if (allowJustNow) return language === 'tr' ? 'az önce' : 'just now';
    return language === 'tr' ? `${seconds} sn` : `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return language === 'tr' ? `${minutes} dk` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return language === 'tr'
      ? `${hours} sa${rest ? ` ${rest} dk` : ''}`
      : `${hours}h${rest ? ` ${rest}m` : ''}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return language === 'tr'
    ? `${days} gün${rest ? ` ${rest} sa` : ''}`
    : `${days}d${rest ? ` ${rest}h` : ''}`;
}

function magnitude(delta: number): number {
  return delta < 0 ? -delta : delta;
}

export class LocalizationService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<LocalizationChangeEvent>();
  private preference: LanguagePreference;
  private _language: RuntimeLanguage;
  readonly onDidChange = this.emitter.event;

  constructor(preference: LanguagePreference = 'auto', vscodeLanguage?: string) {
    this.preference = preference;
    this._language = resolveRuntimeLanguage(
      preference,
      vscodeLanguage ?? vscode.env?.language ?? 'en',
    );
    this.vscodeLanguage = vscodeLanguage ?? vscode.env?.language ?? 'en';
  }

  private vscodeLanguage: string;

  get language(): RuntimeLanguage {
    return this._language;
  }

  get locale(): 'en-US' | 'tr-TR' {
    return this._language === 'tr' ? 'tr-TR' : 'en-US';
  }

  setLanguage(preference: LanguagePreference, vscodeLanguage = this.vscodeLanguage): boolean {
    const next = resolveRuntimeLanguage(preference, vscodeLanguage);
    const previous = this._language;
    this.preference = preference;
    this.vscodeLanguage = vscodeLanguage;
    this._language = next;
    if (next === previous) return false;
    this.emitter.fire({ language: next, previousLanguage: previous, preference });
    return true;
  }

  t(key: LocalizationKey, params?: TranslationParams): string {
    const localized = (this._language === 'tr' ? TR[key] : EN[key]) || EN[key];
    const safe = localized || EN[key] || 'Text unavailable';
    return interpolate(safe, params);
  }

  formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value))
      return this.t('notProvided');
    const clamped = Math.min(100, Math.max(0, value));
    return new Intl.NumberFormat(this.locale, {
      maximumFractionDigits: clamped < 10 ? 1 : 0,
    }).format(clamped);
  }

  formatRelativeTime(
    timestamp: number,
    now = Date.now(),
    role: TimestampRole = 'snapshot-age',
  ): string {
    if (!finiteTimestamp(timestamp)) return this.t('notProvided');
    const delta = timestamp - now;
    const duration = compactDuration(magnitude(delta), this._language, role === 'snapshot-age');
    if (role === 'snapshot-age') return duration;
    if (role === 'past-event') {
      if (delta >= 0) return this.t('inTime', { value: duration });
      if (magnitude(delta) < 15_000) return this.t('justNow');
      return this.t('agoTime', { value: duration });
    }
    if (delta > 0) return this.t('inTime', { value: duration });
    if (role === 'deadline' && magnitude(delta) < 15_000) return this.t('dueNow');
    return this.t('overdueBy', { value: duration });
  }

  formatDate(
    timestamp: number | undefined,
    format: TimeFormat = 'both',
    now = Date.now(),
    role: TimestampRole = 'snapshot-age',
  ): string {
    if (timestamp === undefined || !finiteTimestamp(timestamp)) return this.t('notProvided');
    const absolute = new Intl.DateTimeFormat(this.locale, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(timestamp);
    const relative = this.formatRelativeTime(timestamp, now, role);
    if (format === 'locale' || format === 'absolute') return absolute;
    if (format === 'relative') return relative;
    return `${absolute} (${relative})`;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export const localization = new LocalizationService();
