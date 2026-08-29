import { describe, expect, it } from 'vitest';
import {
  generatePosixWrapperScript,
  generateWindowsWrapperScript,
} from '../../src/providers/claude/ClaudeWrapperGenerator';

const cfg = {
  snapshotPath: 'C:\\Users\\me\\snap.json',
  innerCommand: 'C:\\Program Files\\tool\\run.exe --flag "value with spaces"',
  maxInputBytes: 1024,
  maxOutputBytes: 2048,
  timeoutMs: 3000,
  wrapperVersion: 2,
};

describe('generateWindowsWrapperScript', () => {
  const script = generateWindowsWrapperScript(cfg);

  it('reads stdin exactly once', () => {
    expect(script.match(/\[Console\]::In\.ReadToEnd\(\)/g)).toHaveLength(1);
  });

  it('bakes the inner command in as an escaped literal, not JSON interpolation', () => {
    expect(script).toContain('\'C:\\Program Files\\tool\\run.exe --flag "value with spaces"\'');
    expect(script).not.toContain('$stdinText' + ' + $innerCommand');
  });

  it('writes the snapshot via a temp file and atomic Move-Item, never the raw JSON directly', () => {
    expect(script).toContain('ai-limit-ledger-tmp');
    expect(script).toContain('Move-Item -LiteralPath $tmp -Destination $snapshotPath -Force');
    expect(script).not.toMatch(/Set-Content -LiteralPath \$snapshotPath/);
  });

  it('only extracts the allowlisted fields', () => {
    expect(script).toContain('$data.rate_limits.five_hour');
    expect(script).toContain('$data.rate_limits.seven_day');
    expect(script).toContain('$data.model.id');
    expect(script).not.toContain('$data.session_id');
    expect(script).not.toContain('$data.cwd');
  });

  it('enforces max input/output size and a timeout', () => {
    expect(script).toContain('$maxInputBytes = 1024');
    expect(script).toContain('$maxOutputBytes = 2048');
    expect(script).toContain('$timeoutMs = 3000');
  });

  it('never logs stdin, stdout, or command content — only generic diagnostic text', () => {
    expect(script).not.toMatch(/Write-(Host|Output).*\$stdinText/);
    expect(script).not.toMatch(/Write-(Host|Output).*\$stdout\b.*existing status-line/);
  });
});

describe('generatePosixWrapperScript', () => {
  const script = generatePosixWrapperScript(cfg);

  it('reads stdin exactly once via a single end handler', () => {
    expect(script.match(/process\.stdin\.on\('end'/g)).toHaveLength(1);
  });

  it('bakes the inner command as a spawnSync argv element, not shell string concatenation', () => {
    expect(script).toContain("spawnSync('/bin/sh', ['-c', INNER_COMMAND]");
  });

  it('writes the snapshot via a temp file and atomic rename', () => {
    expect(script).toContain('ai-limit-ledger-tmp');
    expect(script).toContain('fs.renameSync(tmp, SNAPSHOT_PATH)');
  });

  it('caps output and applies a timeout', () => {
    expect(script).toContain('maxBuffer: MAX_OUTPUT_BYTES');
    expect(script).toContain('timeout: TIMEOUT_MS');
  });
});
