import * as fs from 'node:fs';
import * as path from 'node:path';

export class CodexExecutableResolver {
  resolve(configured: string): string | undefined {
    if (configured && configured !== 'auto')
      return path.isAbsolute(configured) && fs.existsSync(configured) ? configured : undefined;
    return this.findOnPath() ?? this.findStandardInstall();
  }
  private findOnPath(): string | undefined {
    const executableNames = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
    for (const directory of (process.env.PATH ?? '').split(path.delimiter))
      for (const name of executableNames) {
        const candidate = path.join(directory, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    return undefined;
  }
  private findStandardInstall(): string | undefined {
    if (process.platform !== 'win32') return undefined;
    const extensions = path.join(process.env.USERPROFILE ?? '', '.vscode', 'extensions');
    try {
      for (const entry of fs.readdirSync(extensions, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('openai.chatgpt-')) continue;
        const candidate = path.join(extensions, entry.name, 'bin', 'windows-x86_64', 'codex.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
