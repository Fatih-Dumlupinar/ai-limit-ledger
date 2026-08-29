import { describe, expect, it } from 'vitest';
import { redactSensitive } from '../src/infrastructure/redact';
describe('Logger', () => {
  it('redacts sensitive log values', () => {
    expect(redactSensitive('email=user@example.com access_token=abc')).toContain('[redacted]');
  });
});
