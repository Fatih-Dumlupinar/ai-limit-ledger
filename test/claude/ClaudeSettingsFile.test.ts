import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  byteExactBackup,
  readSettings,
  writeStatusLineOnly,
} from '../../src/providers/claude/ClaudeSettingsFile';
import { makeTempDir, realFs } from './fixtures';

describe('ClaudeSettingsFile', () => {
  let dir: string;
  let target: string;
  beforeEach(async () => {
    dir = await makeTempDir('ai-limit-ledger-settings-');
    target = path.join(dir, 'settings.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as empty settings', async () => {
    const result = await readSettings(realFs(), target);
    expect(result.existed).toBe(false);
    expect(result.parsed).toEqual({});
  });

  it('rejects invalid JSON with a safe error', async () => {
    await fs.writeFile(target, '{not json', 'utf8');
    await expect(readSettings(realFs(), target)).rejects.toThrow('invalid JSON');
  });

  it('produces a byte-exact timestamped backup', async () => {
    const raw = '{\n  "statusLine": { "type": "command", "command": "echo hi" }\n}';
    await fs.writeFile(target, raw, 'utf8');
    const backupPath = await byteExactBackup(
      realFs(),
      target,
      raw,
      () => new Date('2026-01-02T03:04:05.006Z'),
    );
    expect(backupPath).toContain('.ai-limit-ledger.');
    const backedUp = await fs.readFile(backupPath, 'utf8');
    expect(backedUp).toBe(raw);
  });

  it('writes only the statusLine key and preserves everything else, including unknown fields', async () => {
    const original = {
      statusLine: {
        type: 'command',
        command: 'echo old',
        padding: 2,
        refreshInterval: 500,
        hideVimModeIndicator: true,
      },
      permissions: { allow: ['Bash'] },
      someFutureField: { nested: true },
    };
    await fs.writeFile(target, JSON.stringify(original, null, 2), 'utf8');

    const next = await writeStatusLineOnly(realFs(), target, {
      type: 'command',
      command: 'echo new',
      padding: 2,
      refreshInterval: 500,
      hideVimModeIndicator: true,
    });

    expect(next.permissions).toEqual({ allow: ['Bash'] });
    expect(next.someFutureField).toEqual({ nested: true });
    expect((next.statusLine as Record<string, unknown>).command).toBe('echo new');

    const reread = await readSettings(realFs(), target);
    expect(reread.parsed).toEqual(next);
  });

  it('deletes the statusLine key when passed undefined, leaving other keys untouched', async () => {
    await fs.writeFile(
      target,
      JSON.stringify({ statusLine: { type: 'command', command: 'x' }, other: 1 }),
      'utf8',
    );
    const next = await writeStatusLineOnly(realFs(), target, undefined);
    expect(next.statusLine).toBeUndefined();
    expect(next.other).toBe(1);
  });

  it('never leaves a partial file at the target path (atomic write)', async () => {
    await writeStatusLineOnly(realFs(), target, { type: 'command', command: 'echo x' });
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes('ai-limit-ledger-tmp'))).toHaveLength(0);
  });
});
