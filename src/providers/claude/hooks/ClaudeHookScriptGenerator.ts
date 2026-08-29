import { jsSingleQuoteLiteral, powerShellSingleQuoteLiteral } from '../ClaudeQuoting';

export const HOOK_ACTIVITY_SCHEMA_VERSION = 1;
export const MAX_HOOK_INPUT_BYTES = 64 * 1024;

/**
 * Windows activity-hook script: reads the Claude Code hook JSON payload from stdin and appends
 * exactly one allowlisted line — schema version, event type, timestamp, and a coarse safe error
 * category — to the activity file. Never writes the prompt, response, transcript path, cwd, tool
 * input/output, token, or any account identity; anything not on the allowlist is discarded the
 * instant the payload is parsed.
 */
export function generateWindowsHookScript(activityPath: string): string {
  const activity = powerShellSingleQuoteLiteral(activityPath);
  return `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$maxInputBytes = ${MAX_HOOK_INPUT_BYTES}
$activityPath = ${activity}
try {
  $stdinText = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($stdinText) -le $maxInputBytes) {
    $data = $stdinText | ConvertFrom-Json -ErrorAction Stop
    $eventType = [string]$data.hook_event_name
    if (-not $eventType) { $eventType = 'unknown' }
    $category = 'none'
    $reasonText = [string]$data.reason
    if ($reasonText -match '(?i)rate.?limit|429') { $category = 'rate_limit' } elseif ($reasonText) { $category = 'other' }
    $line = [ordered]@{
      schemaVersion = ${HOOK_ACTIVITY_SCHEMA_VERSION}
      eventType     = $eventType
      observedAt    = (Get-Date).ToUniversalTime().ToString('o')
      safeErrorCategory = $category
    }
    Add-Content -LiteralPath $activityPath -Value ($line | ConvertTo-Json -Compress) -Encoding utf8
  }
} catch {
  # The activity signal is best-effort; a malformed hook payload must never fail the hook itself.
}
`;
}

/** POSIX activity-hook script (Node.js). Same allowlist and best-effort contract as the Windows script. */
export function generatePosixHookScript(activityPath: string): string {
  const activity = jsSingleQuoteLiteral(activityPath);
  return `#!/usr/bin/env node
const fs = require('fs');
const MAX_INPUT_BYTES = ${MAX_HOOK_INPUT_BYTES};
const ACTIVITY_PATH = ${activity};
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const input = Buffer.concat(chunks);
    if (input.length <= MAX_INPUT_BYTES) {
      const data = JSON.parse(input.toString('utf8'));
      const eventType = typeof data.hook_event_name === 'string' ? data.hook_event_name : 'unknown';
      const reasonText = typeof data.reason === 'string' ? data.reason : '';
      const category = /rate.?limit|429/i.test(reasonText) ? 'rate_limit' : reasonText ? 'other' : 'none';
      const line = {
        schemaVersion: ${HOOK_ACTIVITY_SCHEMA_VERSION},
        eventType,
        observedAt: new Date().toISOString(),
        safeErrorCategory: category,
      };
      fs.appendFileSync(ACTIVITY_PATH, JSON.stringify(line) + '\\n', { mode: 0o600 });
    }
  } catch (e) {
    // The activity signal is best-effort; a malformed hook payload must never fail the hook itself.
  }
});
`;
}
