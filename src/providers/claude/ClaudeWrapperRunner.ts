import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Test/integration override for the child environment; production callers inherit the host environment. */
  env?: NodeJS.ProcessEnv;
}

/** Spawns a generated wrapper script and returns its stdout/exit code. Never logs stdin/stdout/args. */
export function spawnWrapperOnce(
  wrapperPath: string,
  stdin: string,
  platform: NodeJS.Platform,
  options: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const [command, args] =
    platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath]]
      : ['node', [wrapperPath]];

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    let stdout = '';
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (outputBytes >= maxOutputBytes) return;
      const remaining = maxOutputBytes - outputBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      outputBytes += slice.length;
      stdout += slice.toString('utf8');
      if (outputBytes >= maxOutputBytes) child.kill();
    });
    child.stderr.resume();

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: '', exitCode: null, timedOut: false });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, exitCode: code, timedOut });
    });

    child.stdin.write(stdin, 'utf8');
    child.stdin.end();
  });
}
