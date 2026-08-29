import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { CopilotCliInfo } from './types';

const execFileAsync = promisify(execFile);

export interface CopilotCommandRunner {
  (file: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface CopilotFileSystem {
  stat(file: string): Promise<{ isFile(): boolean }>;
}

const defaultRunner: CopilotCommandRunner = async (file, args) => {
  const result = await execFileAsync(file, args, { windowsHide: true, timeout: 5_000 });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};
const defaultFs: CopilotFileSystem = { stat: async (file) => stat(file) };

async function isFile(fsApi: CopilotFileSystem, file: string): Promise<boolean> {
  try {
    return (await fsApi.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function versionFor(file: string, runner: CopilotCommandRunner): Promise<CopilotCliInfo> {
  const result = await runner(file, ['--version']);
  return {
    installed: true,
    executablePath: file,
    version: parseCopilotVersion(`${result.stdout}\n${result.stderr}`),
  };
}

/** `%APPDATA%\npm\copilot.cmd` — the real observed location of the npm-global Copilot CLI install. */
export function standardCopilotPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') {
    const home = env.HOME ?? '';
    return [`${home}/.local/bin/copilot`, '/usr/local/bin/copilot', '/opt/homebrew/bin/copilot'];
  }
  return env.APPDATA
    ? [path.join(env.APPDATA, 'npm', 'copilot.cmd'), path.join(env.APPDATA, 'npm', 'copilot.exe')]
    : [];
}

/** Parses the first non-empty line of `where.exe copilot` output into a candidate executable path. */
export function parseWhereOutput(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? null;
}

export interface CopilotCliResolveOptions {
  explicitPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fs?: CopilotFileSystem;
  runVersion?: CopilotCommandRunner;
}

/**
 * Detection only: this never starts an interactive Copilot session or sends a model request.
 * Layered resolution — PATH, then `where.exe`/known npm install location, then an explicit
 * machine-scoped override — because the extension host's inherited PATH can differ from a
 * manually tested shell even when the CLI is genuinely installed.
 */
export async function detectCopilotCli(
  options: CopilotCliResolveOptions = {},
): Promise<CopilotCliInfo> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fsApi = options.fs ?? defaultFs;
  const runner = options.runVersion ?? defaultRunner;

  if (options.explicitPath) {
    const resolved = path.normalize(options.explicitPath);
    const validExplicitPath =
      path.isAbsolute(resolved) && (platform !== 'win32' || /\.(?:exe|cmd|bat)$/i.test(resolved));
    if (validExplicitPath && (await isFile(fsApi, resolved))) {
      try {
        return await versionFor(resolved, runner);
      } catch {
        // Fall through to auto-detection below.
      }
    }
    // An invalid or unresolvable explicit override is not itself a hard failure — auto-detection
    // below may still find the CLI on PATH or in a known install location.
  }

  for (const candidate of platform === 'win32'
    ? ['copilot.cmd', 'copilot.exe', 'copilot']
    : ['copilot']) {
    try {
      return await versionFor(candidate, runner);
    } catch {
      // PATH-based lookup failed; continue to layered fallbacks.
    }
  }

  if (platform === 'win32') {
    try {
      const whereResult = await runner('where.exe', ['copilot']);
      const found = parseWhereOutput(`${whereResult.stdout}\n${whereResult.stderr}`);
      if (found && (await isFile(fsApi, found))) {
        try {
          return await versionFor(found, runner);
        } catch {
          return { installed: true, executablePath: found, version: null };
        }
      }
    } catch {
      // where.exe unavailable or copilot not found on PATH; continue to known install locations.
    }
  }

  for (const candidate of standardCopilotPaths(platform, env)) {
    if (await isFile(fsApi, candidate)) {
      try {
        return await versionFor(candidate, runner);
      } catch {
        return { installed: true, executablePath: candidate, version: null };
      }
    }
  }

  return { installed: false, executablePath: null, version: null };
}

export function parseCopilotVersion(output: string): string | null {
  const match = /(?:copilot\s+)?v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/i.exec(output);
  return match?.[1] ?? null;
}
