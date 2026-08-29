import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateWindowsWrapperScript } from '../../src/providers/claude/ClaudeWrapperGenerator';
import { spawnWrapperOnce } from '../../src/providers/claude/ClaudeWrapperRunner';
import { makeTempDir } from './fixtures';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const stdinJson = JSON.stringify({
  version: '1.2.3',
  cwd: 'secret-cwd',
  session_id: 'secret-session',
  model: { id: 'm1', display_name: 'Model One' },
  rate_limits: { five_hour: { used_percentage: 40, resets_at: '2026-01-01T00:00:00Z' } },
});

async function writeWrapper(
  dir: string,
  snapshotPath: string,
  innerCommand: string,
  overrides: Partial<Parameters<typeof generateWindowsWrapperScript>[0]> = {},
): Promise<string> {
  const wrapperPath = path.join(dir, `wrapper-${Math.random().toString(36).slice(2)}.ps1`);
  const script = generateWindowsWrapperScript({
    snapshotPath,
    innerCommand,
    maxInputBytes: 256 * 1024,
    maxOutputBytes: 64 * 1024,
    timeoutMs: 5000,
    wrapperVersion: 2,
    ...overrides,
  });
  await fs.writeFile(wrapperPath, script, 'utf8');
  return wrapperPath;
}

async function writeFixture(dir: string, name: string, body: string): Promise<string> {
  const fixturePath = path.join(dir, name);
  await fs.writeFile(fixturePath, body, 'utf8');
  return fixturePath;
}

describeWindows('ClaudeWrapperRunner (Windows chained wrapper, real powershell.exe)', () => {
  let dir: string;
  let snapshotPath: string;
  beforeEach(async () => {
    dir = await makeTempDir('ai-limit-ledger-wrapper-');
    snapshotPath = path.join(dir, 'snapshot.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('forwards single-line stdout and exit code 0 unchanged', async () => {
    const fixture = await writeFixture(
      dir,
      'echo-fixed.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('Codex 42% left');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Codex 42% left');
  });

  it('forwards multi-line stdout unchanged', async () => {
    const fixture = await writeFixture(
      dir,
      'multiline.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('line1\\nline2\\nline3');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).toBe('line1\nline2\nline3');
  });

  it('forwards unicode stdout unchanged', async () => {
    const fixture = await writeFixture(
      dir,
      'unicode.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('caf\\u00e9 \\u4e16\\u754c \\ud83d\\ude00');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).toBe('café 世界 😀');
  });

  it('forwards empty stdout unchanged', async () => {
    const fixture = await writeFixture(
      dir,
      'empty.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('passes through a nonzero exit code from the inner command', async () => {
    const fixture = await writeFixture(
      dir,
      'fail.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('partial');process.exit(7)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('partial');
  });

  it('supports a spaced, quoted inner script path', async () => {
    const spacedDir = path.join(dir, 'path with spaces');
    await fs.mkdir(spacedDir, { recursive: true });
    const fixture = await writeFixture(
      spacedDir,
      'echo.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('spaced ok');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).toBe('spaced ok');
    expect(result.exitCode).toBe(0);
  });

  it('supports an inner command containing its own quoted arguments', async () => {
    const fixture = await writeFixture(
      dir,
      'quoted-args.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(process.argv[2]);process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}" "hello world"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).toBe('hello world');
  });

  it('supports an environment variable in the inner command', async () => {
    const envDir = await makeTempDir('ai-limit-ledger-envvar-');
    const fixture = await writeFixture(
      envDir,
      'envvar.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('env ok');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(
      dir,
      snapshotPath,
      `node "%TEMP%\\${path.basename(fixture)}"`,
    );
    try {
      const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32', {
        env: { TEMP: envDir, TMP: envDir },
      });
      expect(result.stdout).toBe('env ok');
    } finally {
      await fs.rm(envDir, { recursive: true, force: true });
    }
  });

  it('kills the inner command and exits distinctly on timeout', async () => {
    const fixture = await writeFixture(
      dir,
      'hang.js',
      'process.stdin.resume();setTimeout(()=>{},1000000);',
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`, {
      timeoutMs: 1000,
    });
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32', { timeoutMs: 8000 });
    expect(result.exitCode).toBe(91);
  }, 15000);

  it('truncates stdout at the configured maximum', async () => {
    const fixture = await writeFixture(
      dir,
      'bigoutput.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('x'.repeat(5000));process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`, {
      maxOutputBytes: 100,
    });
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout.length).toBeLessThanOrEqual(100);
  });

  it('skips the snapshot but still forwards stdout when stdin exceeds the input cap', async () => {
    const fixture = await writeFixture(
      dir,
      'echo-fixed2.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('still works');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`, {
      maxInputBytes: 10,
    });
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).toBe('still works');
    await expect(fs.readFile(snapshotPath, 'utf8')).rejects.toThrow();
  });

  it('writes only an allowlisted snapshot, never the raw JSON', async () => {
    const fixture = await writeFixture(
      dir,
      'echo-fixed3.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('ok');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, snapshotPath, `node "${fixture}"`);
    await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    const snapshotRaw = await fs.readFile(snapshotPath, 'utf8');
    expect(snapshotRaw).not.toContain('secret-cwd');
    expect(snapshotRaw).not.toContain('secret-session');
    const parsed = JSON.parse(snapshotRaw);
    expect(parsed.model.id).toBe('m1');
    expect(parsed.rate_limits.five_hour.used_percentage).toBe(40);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'schemaVersion',
        'observedAt',
        'version',
        'model',
        'rate_limits',
        'context_window',
        'cost',
        'fast_mode',
        'effort',
        'exceeds_200k_tokens',
        'thinking',
        'output_style',
      ].sort(),
    );
  });

  it('still forwards stdout when the snapshot directory does not exist (best-effort snapshot write)', async () => {
    const badSnapshotPath = path.join(dir, 'missing-subdir', 'snapshot.json');
    const fixture = await writeFixture(
      dir,
      'echo-fixed4.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('resilient');process.exit(0)});",
    );
    const wrapperPath = await writeWrapper(dir, badSnapshotPath, `node "${fixture}"`);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).toBe('resilient');
    expect(result.exitCode).toBe(0);
  });

  it('never emits the inner command text on its own stdout', async () => {
    const fixture = await writeFixture(
      dir,
      'fail2.js',
      "process.stdin.resume();process.stdin.on('end',()=>{process.exit(3)});",
    );
    const secretLookingCommand = `node "${fixture}" --api-key "sk-should-not-leak"`;
    const wrapperPath = await writeWrapper(dir, snapshotPath, secretLookingCommand);
    const result = await spawnWrapperOnce(wrapperPath, stdinJson, 'win32');
    expect(result.stdout).not.toContain('sk-should-not-leak');
    expect(result.exitCode).toBe(3);
  });
});
