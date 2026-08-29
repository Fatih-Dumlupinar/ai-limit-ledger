import { describe, expect, it } from 'vitest';
import { CodexExecutableResolver } from '../src/appServer/CodexExecutableResolver';
describe('CodexExecutableResolver', () => {
  it('does not accept a relative configured executable', () => {
    expect(new CodexExecutableResolver().resolve('workspace/codex.cmd')).toBeUndefined();
  });
  it('accepts an existing absolute configured executable', () => {
    expect(new CodexExecutableResolver().resolve(process.execPath)).toBe(process.execPath);
  });
});
