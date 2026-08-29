import { jsSingleQuoteLiteral, powerShellSingleQuoteLiteral } from './ClaudeQuoting';
import type { WrapperConfig } from './types';

/**
 * Windows chaining wrapper: reads Claude Code's status-line JSON from stdin once, writes an
 * allowlisted snapshot via temp-file + atomic rename, then relays the same stdin to the
 * pre-existing status-line command (baked in as a trusted literal, never built from the JSON)
 * and mirrors its stdout/exit code back to Claude Code unchanged.
 */
export function generateWindowsWrapperScript(cfg: WrapperConfig): string {
  const snapshot = powerShellSingleQuoteLiteral(cfg.snapshotPath);
  const inner = powerShellSingleQuoteLiteral(cfg.innerCommand);
  return `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$maxInputBytes = ${cfg.maxInputBytes}
$maxOutputBytes = ${cfg.maxOutputBytes}
$timeoutMs = ${cfg.timeoutMs}
$snapshotPath = ${snapshot}
$innerCommand = ${inner}

$stdinText = [Console]::In.ReadToEnd()
$inputBytes = [Text.Encoding]::UTF8.GetByteCount($stdinText)

if ($inputBytes -le $maxInputBytes) {
  try {
    $data = $stdinText | ConvertFrom-Json -ErrorAction Stop
    $safe = [ordered]@{
      schemaVersion = 2
      observedAt    = (Get-Date).ToUniversalTime().ToString('o')
      version       = $data.version
      model         = [ordered]@{ id = $data.model.id; display_name = $data.model.display_name }
      rate_limits   = [ordered]@{ five_hour = $data.rate_limits.five_hour; seven_day = $data.rate_limits.seven_day }
      context_window = [ordered]@{
        total_input_tokens = $data.context_window.total_input_tokens
        total_output_tokens = $data.context_window.total_output_tokens
        context_window_size = $data.context_window.context_window_size
        used_percentage = $data.context_window.used_percentage
        remaining_percentage = $data.context_window.remaining_percentage
        current_usage = [ordered]@{
          input_tokens = $data.context_window.current_usage.input_tokens
          output_tokens = $data.context_window.current_usage.output_tokens
          cache_creation_input_tokens = $data.context_window.current_usage.cache_creation_input_tokens
          cache_read_input_tokens = $data.context_window.current_usage.cache_read_input_tokens
        }
      }
      cost          = [ordered]@{
        total_cost_usd = $data.cost.total_cost_usd
        total_duration_ms = $data.cost.total_duration_ms
        total_api_duration_ms = $data.cost.total_api_duration_ms
        total_lines_added = $data.cost.total_lines_added
        total_lines_removed = $data.cost.total_lines_removed
      }
      fast_mode     = $data.fast_mode
      effort        = [ordered]@{ level = $data.effort.level }
      thinking      = [ordered]@{ enabled = $data.thinking.enabled }
      exceeds_200k_tokens = $data.exceeds_200k_tokens
      output_style = [ordered]@{ name = $data.output_style.name }
    }
    $tmp = "$snapshotPath.ai-limit-ledger-tmp-$([guid]::NewGuid().ToString('N'))"
    try {
      [System.IO.File]::WriteAllText($tmp, ($safe | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
      try { icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):(F)" 2>$null | Out-Null } catch {}
      Move-Item -LiteralPath $tmp -Destination $snapshotPath -Force
    } finally {
      if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
  } catch {
    # Snapshot write is best-effort; the chained status line must keep working regardless.
  }
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/d /s /c "' + $innerCommand + '"'
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [Text.Encoding]::UTF8
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

try {
  $process = [System.Diagnostics.Process]::Start($psi)
} catch {
  [Console]::Error.WriteLine('AI Limit Ledger wrapper: failed to start the existing status-line command.')
  exit 90
}

try {
  $process.StandardInput.Write($stdinText)
} finally {
  $process.StandardInput.Close()
}

$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$exited = $process.WaitForExit($timeoutMs)

if (-not $exited) {
  try { taskkill /PID $process.Id /T /F 2>$null | Out-Null } catch {}
  try { $process.Kill() } catch {}
  [Console]::Error.WriteLine('AI Limit Ledger wrapper: existing status-line command timed out.')
  exit 91
}

$stdout = $stdoutTask.GetAwaiter().GetResult()
$stdoutBytes = [Text.Encoding]::UTF8.GetBytes($stdout)
if ($stdoutBytes.Length -gt $maxOutputBytes) {
  $stdout = [Text.Encoding]::UTF8.GetString($stdoutBytes, 0, $maxOutputBytes)
}

[Console]::Out.Write($stdout)
if ($process.ExitCode -ne 0) {
  [Console]::Error.WriteLine("AI Limit Ledger wrapper: existing status-line command exited with code $($process.ExitCode).")
}
exit $process.ExitCode
`;
}

/** Standalone (no prior statusLine to chain to) Windows bridge: snapshot-only, no inner command. */
export function generateStandaloneWindowsScript(
  snapshotPath: string,
  maxInputBytes: number,
): string {
  const snapshot = powerShellSingleQuoteLiteral(snapshotPath);
  return `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$maxInputBytes = ${maxInputBytes}
$snapshotPath = ${snapshot}
$stdinText = [Console]::In.ReadToEnd()
if ([Text.Encoding]::UTF8.GetByteCount($stdinText) -gt $maxInputBytes) { exit 1 }
$data = $stdinText | ConvertFrom-Json
$safe = [ordered]@{
  schemaVersion = 2
  observedAt    = (Get-Date).ToUniversalTime().ToString('o')
  version       = $data.version
  model         = [ordered]@{ id = $data.model.id; display_name = $data.model.display_name }
  rate_limits   = [ordered]@{ five_hour = $data.rate_limits.five_hour; seven_day = $data.rate_limits.seven_day }
  context_window = [ordered]@{
    total_input_tokens = $data.context_window.total_input_tokens
    total_output_tokens = $data.context_window.total_output_tokens
    context_window_size = $data.context_window.context_window_size
    used_percentage = $data.context_window.used_percentage
    remaining_percentage = $data.context_window.remaining_percentage
    current_usage = [ordered]@{
      input_tokens = $data.context_window.current_usage.input_tokens
      output_tokens = $data.context_window.current_usage.output_tokens
      cache_creation_input_tokens = $data.context_window.current_usage.cache_creation_input_tokens
      cache_read_input_tokens = $data.context_window.current_usage.cache_read_input_tokens
    }
  }
  cost          = [ordered]@{
    total_cost_usd = $data.cost.total_cost_usd
    total_duration_ms = $data.cost.total_duration_ms
    total_api_duration_ms = $data.cost.total_api_duration_ms
    total_lines_added = $data.cost.total_lines_added
    total_lines_removed = $data.cost.total_lines_removed
  }
  fast_mode     = $data.fast_mode
  effort        = [ordered]@{ level = $data.effort.level }
  thinking      = [ordered]@{ enabled = $data.thinking.enabled }
  exceeds_200k_tokens = $data.exceeds_200k_tokens
  output_style = [ordered]@{ name = $data.output_style.name }
}
$tmp = "$snapshotPath.ai-limit-ledger-tmp-$([guid]::NewGuid().ToString('N'))"
[System.IO.File]::WriteAllText($tmp, ($safe | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tmp -Destination $snapshotPath -Force
Write-Output 'AI Limit Ledger connected'
`;
}

/** Standalone (no prior statusLine to chain to) POSIX bridge: snapshot-only, no inner command. */
export function generateStandalonePosixScript(snapshotPath: string, maxInputBytes: number): string {
  const snapshot = jsSingleQuoteLiteral(snapshotPath);
  return `const fs = require('fs');
const MAX_INPUT_BYTES = ${maxInputBytes};
const SNAPSHOT_PATH = ${snapshot};
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  if (Buffer.byteLength(s) > MAX_INPUT_BYTES) process.exit(1);
  const data = JSON.parse(s);
  const safe = {
    schemaVersion: 2,
    observedAt: new Date().toISOString(),
    version: data.version,
    model: { id: data.model && data.model.id, display_name: data.model && data.model.display_name },
    rate_limits: { five_hour: data.rate_limits && data.rate_limits.five_hour, seven_day: data.rate_limits && data.rate_limits.seven_day },
    context_window: {
      total_input_tokens: data.context_window && data.context_window.total_input_tokens,
      total_output_tokens: data.context_window && data.context_window.total_output_tokens,
      context_window_size: data.context_window && data.context_window.context_window_size,
      used_percentage: data.context_window && data.context_window.used_percentage,
      remaining_percentage: data.context_window && data.context_window.remaining_percentage,
      current_usage: {
        input_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.input_tokens,
        output_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.output_tokens,
        cache_creation_input_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.cache_creation_input_tokens,
        cache_read_input_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.cache_read_input_tokens,
      },
    },
    cost: {
      total_cost_usd: data.cost && data.cost.total_cost_usd,
      total_duration_ms: data.cost && data.cost.total_duration_ms,
      total_api_duration_ms: data.cost && data.cost.total_api_duration_ms,
      total_lines_added: data.cost && data.cost.total_lines_added,
      total_lines_removed: data.cost && data.cost.total_lines_removed,
    },
    fast_mode: data.fast_mode,
    effort: { level: data.effort && data.effort.level },
    thinking: { enabled: data.thinking && data.thinking.enabled },
    exceeds_200k_tokens: data.exceeds_200k_tokens,
    output_style: { name: data.output_style && data.output_style.name },
  };
  const tmp = SNAPSHOT_PATH + '.ai-limit-ledger-tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(safe), { mode: 0o600 });
  fs.renameSync(tmp, SNAPSHOT_PATH);
  console.log('AI Limit Ledger connected');
});
`;
}

/**
 * POSIX chaining wrapper (Node.js, same runtime the standalone bridge already requires):
 * mirrors the Windows wrapper's guarantees for macOS/Linux.
 */
export function generatePosixWrapperScript(cfg: WrapperConfig): string {
  const snapshot = jsSingleQuoteLiteral(cfg.snapshotPath);
  const inner = jsSingleQuoteLiteral(cfg.innerCommand);
  return `#!/usr/bin/env node
const fs = require('fs');
const { spawnSync } = require('child_process');
const MAX_INPUT_BYTES = ${cfg.maxInputBytes};
const MAX_OUTPUT_BYTES = ${cfg.maxOutputBytes};
const TIMEOUT_MS = ${cfg.timeoutMs};
const SNAPSHOT_PATH = ${snapshot};
const INNER_COMMAND = ${inner};

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  if (input.length <= MAX_INPUT_BYTES) {
    try {
      const data = JSON.parse(input.toString('utf8'));
      const safe = {
        schemaVersion: 2,
        observedAt: new Date().toISOString(),
        version: data.version,
        model: { id: data.model && data.model.id, display_name: data.model && data.model.display_name },
        rate_limits: { five_hour: data.rate_limits && data.rate_limits.five_hour, seven_day: data.rate_limits && data.rate_limits.seven_day },
        context_window: {
          total_input_tokens: data.context_window && data.context_window.total_input_tokens,
          total_output_tokens: data.context_window && data.context_window.total_output_tokens,
          context_window_size: data.context_window && data.context_window.context_window_size,
          used_percentage: data.context_window && data.context_window.used_percentage,
          remaining_percentage: data.context_window && data.context_window.remaining_percentage,
          current_usage: {
            input_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.input_tokens,
            output_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.output_tokens,
            cache_creation_input_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.cache_creation_input_tokens,
            cache_read_input_tokens: data.context_window && data.context_window.current_usage && data.context_window.current_usage.cache_read_input_tokens,
          },
        },
        cost: {
          total_cost_usd: data.cost && data.cost.total_cost_usd,
          total_duration_ms: data.cost && data.cost.total_duration_ms,
          total_api_duration_ms: data.cost && data.cost.total_api_duration_ms,
          total_lines_added: data.cost && data.cost.total_lines_added,
          total_lines_removed: data.cost && data.cost.total_lines_removed,
        },
        fast_mode: data.fast_mode,
        effort: { level: data.effort && data.effort.level },
        thinking: { enabled: data.thinking && data.thinking.enabled },
        exceeds_200k_tokens: data.exceeds_200k_tokens,
        output_style: { name: data.output_style && data.output_style.name },
      };
      const tmp = SNAPSHOT_PATH + '.ai-limit-ledger-tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(safe), { mode: 0o600 });
      fs.renameSync(tmp, SNAPSHOT_PATH);
    } catch (e) {
      // Snapshot write is best-effort; the chained status line must keep working regardless.
    }
  }

  const child = spawnSync('/bin/sh', ['-c', INNER_COMMAND], {
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: TIMEOUT_MS,
  });

  if (child.error) {
    process.stderr.write('AI Limit Ledger wrapper: failed to run the existing status-line command.\\n');
    process.exit(child.signal ? 91 : 90);
  }
  process.stdout.write(child.stdout || Buffer.alloc(0));
  if (child.status !== 0) {
    process.stderr.write('AI Limit Ledger wrapper: existing status-line command exited with code ' + child.status + '.\\n');
  }
  process.exit(child.status === null ? 91 : child.status);
});
`;
}
