import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { GrokCliInfo } from './types';

const execFileAsync = promisify(execFile);

export interface GrokFileSystem {
  stat(file: string): Promise<{ isFile(): boolean }>;
}

export interface GrokVersionRunner {
  (file: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultFs: GrokFileSystem = { stat: async (file) => stat(file) };
const defaultRunner: GrokVersionRunner = async (file, args) => {
  const result = await execFileAsync(file, args, { windowsHide: true, timeout: 5_000 });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export function validateExplicitGrokPath(
  executablePath: string,
  workspaceRoot?: string,
  platform: NodeJS.Platform = process.platform,
): { valid: boolean; reason?: GrokCliInfo['reason']; path?: string } {
  if (!executablePath || !path.isAbsolute(executablePath)) {
    return { valid: false, reason: 'invalid-explicit-path' };
  }
  const resolved = path.normalize(executablePath);
  if (workspaceRoot) {
    const relative = path.relative(path.normalize(workspaceRoot), resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return { valid: false, reason: 'workspace-path-rejected' };
    }
  }
  if (platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(resolved)) {
    return { valid: false, reason: 'invalid-explicit-path' };
  }
  return { valid: true, path: resolved };
}

export function parseGrokVersion(output: string): string | null {
  const match = /(?:grok\s*)?v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/i.exec(output);
  return match?.[1] ?? null;
}

/** Resolves only a machine-scoped explicit file, PATH, or known system install location. */
export async function resolveGrokCli(
  options: {
    executablePath?: string;
    workspaceRoot?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    fs?: GrokFileSystem;
    runVersion?: GrokVersionRunner;
  } = {},
): Promise<GrokCliInfo> {
  const platform = options.platform ?? process.platform;
  const fsApi = options.fs ?? defaultFs;
  const runner = options.runVersion ?? defaultRunner;
  if (options.executablePath) {
    const validation = validateExplicitGrokPath(
      options.executablePath,
      options.workspaceRoot,
      platform,
    );
    if (!validation.valid || !validation.path)
      return { installed: false, executablePath: null, version: null, reason: validation.reason };
    if (!(await isFile(fsApi, validation.path))) {
      return {
        installed: false,
        executablePath: null,
        version: null,
        reason: 'invalid-explicit-path',
      };
    }
    try {
      return await versionFor(validation.path, runner);
    } catch {
      return {
        installed: false,
        executablePath: null,
        version: null,
        reason: 'invalid-explicit-path',
      };
    }
  }

  for (const candidate of platform === 'win32' ? ['grok.exe', 'grok.cmd', 'grok'] : ['grok']) {
    try {
      return await versionFor(candidate, runner);
    } catch {
      // Continue to known machine locations.
    }
  }
  for (const candidate of standardGrokPaths(platform, options.env ?? process.env)) {
    if (await isFile(fsApi, candidate)) {
      try {
        return await versionFor(candidate, runner);
      } catch {
        return { installed: true, executablePath: candidate, version: null };
      }
    }
  }
  return { installed: false, executablePath: null, version: null, reason: 'not-found' };
}

export function standardGrokPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') {
    const user = env.HOME ?? '';
    return [`${user}/.local/bin/grok`, '/usr/local/bin/grok', '/opt/homebrew/bin/grok'];
  }
  const candidates = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Grok', 'grok.exe') : '',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Grok', 'grok.exe') : '',
    env.USERPROFILE ? path.join(env.USERPROFILE, '.local', 'bin', 'grok.exe') : '',
  ];
  return candidates.filter(Boolean);
}

async function isFile(fsApi: GrokFileSystem, file: string): Promise<boolean> {
  try {
    return (await fsApi.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function versionFor(file: string, runner: GrokVersionRunner): Promise<GrokCliInfo> {
  const result = await runner(file, ['--version']);
  return {
    installed: true,
    executablePath: file,
    version: parseGrokVersion(`${result.stdout}\n${result.stderr}`),
  };
}
