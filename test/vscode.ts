export class EventEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(value: T): void {
    this.listeners.forEach((listener) => listener(value));
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

export const Uri = {
  parse(value: string) {
    return { toString: () => value, value };
  },
  file(value: string) {
    return { fsPath: value, toString: () => value };
  },
  joinPath(base: { fsPath?: string; toString(): string }, ...segments: string[]) {
    const value = [base.toString(), ...segments].join('/');
    return { fsPath: value, toString: () => value };
  },
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;

class MockWebview {
  html = '';
  readonly cspSource = "'self'";
  private readonly messageEmitter = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.messageEmitter.event;
  readonly postedMessages: unknown[] = [];
  async postMessage(message: unknown): Promise<boolean> {
    this.postedMessages.push(message);
    return true;
  }
  asWebviewUri(uri: { toString(): string }): { toString(): string } {
    return { toString: () => `vscode-webview://mock/${uri.toString()}` };
  }
  /** Test-only: simulates the webview posting a message back to the extension host. */
  __receiveMessage(message: unknown): void {
    this.messageEmitter.fire(message);
  }
}

class MockWebviewPanel {
  readonly webview = new MockWebview();
  visible = true;
  disposed = false;
  private readonly disposeEmitter = new EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  constructor(
    readonly viewType: string,
    public title: string,
  ) {
    createdWebviewPanels.push(this as unknown as MockWebviewPanel);
  }
  reveal(): void {
    this.visible = true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeEmitter.fire();
  }
}
const createdWebviewPanels: MockWebviewPanel[] = [];
export function __createdWebviewPanels(): readonly MockWebviewPanel[] {
  return createdWebviewPanels;
}
export function __resetWebviewPanelMocks(): void {
  createdWebviewPanels.length = 0;
}

class MockTextDocument {
  readonly isDirty = false;
  readonly isUntitled = false;
  readonly languageId = 'markdown';
  readonly version = 1;
  constructor(
    readonly uri: ReturnType<typeof Uri.parse>,
    public readonly text: string,
  ) {}
  getText(): string {
    return this.text;
  }
}

class MockTextEditor {
  constructor(readonly document: MockTextDocument) {}
}

const contentProviders = new Map<string, { provideTextDocumentContent(uri: unknown): string }>();
const textDocuments = new Map<string, MockTextDocument>();
const visibleTextEditorsEmitter = new EventEmitter<readonly MockTextEditor[]>();
let visibleTextEditors: MockTextEditor[] = [];

export function __registeredTextDocumentContentProviders(): ReadonlyMap<
  string,
  { provideTextDocumentContent(uri: unknown): string }
> {
  return contentProviders;
}

export function __visibleTextEditors(): readonly MockTextEditor[] {
  return visibleTextEditors;
}

export function __closeTextEditors(): void {
  visibleTextEditors = [];
  visibleTextEditorsEmitter.fire(visibleTextEditors);
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

export const env = {
  openExternal: async (): Promise<boolean> => true,
  clipboard: {
    writeText: async (value: string): Promise<void> => {
      clipboardText = value;
    },
    readText: async (): Promise<string> => clipboardText,
  },
};

let warningResponse: string | undefined;
let warningCalls: Array<{ message: string; options: unknown; items: string[] }> = [];
let infoMessages: string[] = [];
let quickPickResponse: unknown;
let clipboardText = '';
let saveDialogResponse: { fsPath: string; toString: () => string } | undefined;
const outputChannels: MockOutputChannel[] = [];
const statusBarItems: MockStatusBarItem[] = [];

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  isTrusted = false;
  supportHtml = false;
  constructor(readonly value = '') {}
}

class MockOutputChannel {
  readonly lines: string[] = [];
  shown = false;
  disposed = false;
  constructor(readonly name: string) {}
  appendLine(value: string): void {
    this.lines.push(value);
  }
  show(): void {
    this.shown = true;
  }
  dispose(): void {
    this.disposed = true;
  }
}

class MockStatusBarItem {
  text = '';
  tooltip: unknown;
  command: string | undefined;
  backgroundColor: unknown;
  visible = false;
  disposed = false;
  constructor(readonly priority: number) {}
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export const window = {
  showErrorMessage: async (): Promise<undefined> => undefined,
  showInformationMessage: async (message?: string): Promise<undefined> => {
    if (typeof message === 'string') infoMessages.push(message);
    return undefined;
  },
  showWarningMessage: async (
    message: string,
    options: unknown,
    ...items: string[]
  ): Promise<string | undefined> => {
    warningCalls.push({ message, options, items });
    return warningResponse;
  },
  showQuickPick: async <T>(items: readonly T[]): Promise<T | undefined> => {
    void items;
    return quickPickResponse === undefined ? undefined : (quickPickResponse as T);
  },
  createOutputChannel(name: string): MockOutputChannel {
    const channel = new MockOutputChannel(name);
    outputChannels.push(channel);
    return channel;
  },
  createStatusBarItem(_alignment: unknown, priority = 0): MockStatusBarItem {
    const item = new MockStatusBarItem(priority);
    statusBarItems.push(item);
    return item;
  },
  showSaveDialog: async (): Promise<typeof saveDialogResponse> => saveDialogResponse,
  createWebviewPanel(viewType: string, title: string): MockWebviewPanel {
    return new MockWebviewPanel(viewType, title);
  },
  onDidChangeVisibleTextEditors: visibleTextEditorsEmitter.event,
  async showTextDocument(document: MockTextDocument): Promise<MockTextEditor> {
    const editor = new MockTextEditor(document);
    visibleTextEditors = [editor];
    visibleTextEditorsEmitter.fire(visibleTextEditors);
    return editor;
  },
};

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const version = '1.95.0';
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
export const commands = {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown) {
    registeredCommands.set(command, callback);
    return { dispose: () => registeredCommands.delete(command) };
  },
  executeCommand: async (command: string, ...args: unknown[]) =>
    registeredCommands.get(command)?.(...args),
};

/** Test-only control surface for `window.showWarningMessage`/`showInformationMessage` — not part of the real vscode API. */
export function __setWarningResponse(value: string | undefined): void {
  warningResponse = value;
}
export function __setQuickPickResponse(value: unknown): void {
  quickPickResponse = value;
}
export function __warningCalls(): typeof warningCalls {
  return warningCalls;
}
export function __infoMessages(): string[] {
  return infoMessages;
}
export function __resetWindowMocks(): void {
  warningResponse = undefined;
  warningCalls = [];
  infoMessages = [];
  quickPickResponse = undefined;
  clipboardText = '';
  saveDialogResponse = undefined;
  outputChannels.length = 0;
  statusBarItems.length = 0;
  createdWebviewPanels.length = 0;
  contentProviders.clear();
  textDocuments.clear();
  visibleTextEditors = [];
}
export function __setSaveDialogResponse(value: string | undefined): void {
  saveDialogResponse = value ? Uri.file(value) : undefined;
}
export function __clipboardText(): string {
  return clipboardText;
}
export function __outputChannels(): readonly MockOutputChannel[] {
  return outputChannels;
}
export function __statusBarItems(): readonly MockStatusBarItem[] {
  return statusBarItems;
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

interface ConfigStore {
  values: Map<string, unknown>;
  rejectKeys: Set<string>;
}
const configStores = new Map<string, ConfigStore>();
const configChangeEmitter = new EventEmitter<{ affectsConfiguration(key: string): boolean }>();

function storeFor(section: string): ConfigStore {
  let store = configStores.get(section);
  if (!store) {
    store = { values: new Map(), rejectKeys: new Set() };
    configStores.set(section, store);
  }
  return store;
}

/** Test-only: makes the next `update()` for this exact `section.key` fail, as VS Code does for an unregistered configuration key. */
export function __rejectConfigWrite(section: string, key: string): void {
  storeFor(section).rejectKeys.add(key);
}
export function __resetConfigMocks(): void {
  configStores.clear();
}
export function __fireConfigurationChange(...changedKeys: string[]): void {
  configChangeEmitter.fire({
    affectsConfiguration: (key: string) =>
      changedKeys.some((changed) => changed === key || key.startsWith(`${changed}.`)),
  });
}

export const workspace = {
  getConfiguration(section = '') {
    const store = storeFor(section);
    return {
      get<T>(key: string, defaultValue?: T): T {
        return store.values.has(key) ? (store.values.get(key) as T) : (defaultValue as T);
      },
      inspect<T>(key: string): { globalValue?: T; defaultValue?: T } | undefined {
        return store.values.has(key) ? { globalValue: store.values.get(key) as T } : undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        if (store.rejectKeys.has(key)) {
          throw new Error(
            `Unable to write to User Settings because ${section}.${key} is not a registered configuration.`,
          );
        }
        store.values.set(key, value);
      },
    };
  },
  onDidChangeConfiguration: configChangeEmitter.event,
  registerTextDocumentContentProvider(
    scheme: string,
    provider: { provideTextDocumentContent(uri: unknown): string },
  ) {
    contentProviders.set(scheme, provider);
    return { dispose: () => contentProviders.delete(scheme) };
  },
  async openTextDocument(uri: ReturnType<typeof Uri.parse>): Promise<MockTextDocument> {
    const key = uri.toString();
    const existing = textDocuments.get(key);
    if (existing) return existing;
    const provider = contentProviders.get('ai-limit-ledger');
    const document = new MockTextDocument(uri, provider?.provideTextDocumentContent(uri) ?? '');
    textDocuments.set(key, document);
    return document;
  },
};
