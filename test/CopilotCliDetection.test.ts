import { describe, expect, it, vi } from 'vitest';
import {
  detectCopilotCli,
  parseCopilotVersion,
  parseWhereOutput,
  standardCopilotPaths,
} from '../src/providers/copilot/CopilotCliDetection';

describe('parseCopilotVersion / parseWhereOutput', () => {
  it('parses the CLI version banner', () => {
    expect(parseCopilotVersion('GitHub Copilot CLI 1.0.80.\nRun copilot update')).toBe('1.0.80');
  });

  it('parses the first non-empty line of where.exe output', () => {
    expect(parseWhereOutput('\nC:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd\r\n')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd',
    );
    expect(parseWhereOutput('')).toBeNull();
  });

  it('builds the known npm-global install location from %APPDATA%', () => {
    const paths = standardCopilotPaths('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
    expect(paths).toContain('C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd');
  });
});

describe('detectCopilotCli layered resolution', () => {
  it('detects copilot.cmd directly on PATH (Windows)', async () => {
    const runner = vi.fn(async (file: string) => {
      if (file === 'copilot.cmd') return { stdout: 'GitHub Copilot CLI 1.0.80.\n', stderr: '' };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectCopilotCli({ platform: 'win32', runVersion: runner });
    expect(result).toEqual({ installed: true, executablePath: 'copilot.cmd', version: '1.0.80' });
  });

  it('falls back to where.exe when PATH lookup fails but the CLI is still resolvable', async () => {
    const knownPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd';
    const runner = vi.fn(async (file: string) => {
      if (file === 'where.exe') return { stdout: `${knownPath}\n`, stderr: '' };
      if (file === knownPath) return { stdout: 'GitHub Copilot CLI 1.0.80.\n', stderr: '' };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const fs = { stat: vi.fn(async () => ({ isFile: () => true })) };
    const result = await detectCopilotCli({ platform: 'win32', runVersion: runner, fs });
    expect(result).toEqual({ installed: true, executablePath: knownPath, version: '1.0.80' });
  });

  it('falls back to the known npm-global install location when where.exe also fails', async () => {
    const knownPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd';
    const runner = vi.fn(async (file: string) => {
      if (file === knownPath) return { stdout: 'GitHub Copilot CLI 1.0.80.\n', stderr: '' };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const fs = { stat: vi.fn(async (file: string) => ({ isFile: () => file === knownPath })) };
    const result = await detectCopilotCli({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      runVersion: runner,
      fs,
    });
    expect(result).toEqual({ installed: true, executablePath: knownPath, version: '1.0.80' });
  });

  it('reports not-installed when every layer fails', async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const fs = { stat: vi.fn(async () => ({ isFile: () => false })) };
    const result = await detectCopilotCli({ platform: 'win32', runVersion: runner, fs, env: {} });
    expect(result.installed).toBe(false);
  });

  it('honors a valid explicit machine-scoped path override', async () => {
    const explicit = 'C:\\tools\\copilot.exe';
    const runner = vi.fn(async () => ({ stdout: 'GitHub Copilot CLI 2.0.0.\n', stderr: '' }));
    const fs = { stat: vi.fn(async () => ({ isFile: () => true })) };
    const result = await detectCopilotCli({
      explicitPath: explicit,
      platform: 'win32',
      runVersion: runner,
      fs,
    });
    expect(result).toEqual({ installed: true, executablePath: explicit, version: '2.0.0' });
    expect(runner).toHaveBeenCalledWith(explicit, ['--version']);
  });

  it('rejects a relative explicit path and falls back to auto-detection', async () => {
    const runner = vi.fn(async (file: string) => {
      if (file === 'copilot.cmd') return { stdout: 'GitHub Copilot CLI 1.0.80.\n', stderr: '' };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectCopilotCli({
      explicitPath: 'copilot.exe',
      platform: 'win32',
      runVersion: runner,
    });
    expect(result.executablePath).toBe('copilot.cmd');
  });
});
