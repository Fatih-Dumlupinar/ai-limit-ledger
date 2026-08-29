import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { vscode: new URL('./test/vscode.ts', import.meta.url).pathname } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several suites spawn real powershell.exe processes (ClaudeWrapperRunner) or perform real,
    // immediately-read-back filesystem writes (ClaudeDiagnostics/ClaudeDisable) with no injected
    // fake I/O layer. Vitest 4's more aggressive default cross-file parallelism let those
    // resource-heavy real-process/real-fs suites run concurrently with the rest of the ~90-file
    // suite, occasionally starving CPU/disk I/O enough to intermittently fail otherwise
    // deterministic (fixed fake clock) assertions — flakiness that did not reproduce under
    // Vitest 2's scheduling. Running test files sequentially costs a few seconds on a suite this
    // size and removes the race entirely, which this project already prioritizes over raw speed
    // (see the Task 10 SharedSnapshotStore temp-isolation hardening).
    fileParallelism: false,
  },
});
