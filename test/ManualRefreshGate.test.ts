import { describe, expect, it } from 'vitest';
import { createManualRefreshGate } from '../src/commands/registerCommands';

describe('createManualRefreshGate', () => {
  it('allows the first invocation and blocks a second one inside the cooldown', () => {
    let now = 0;
    const gate = createManualRefreshGate(
      () => 10,
      () => now,
    );
    expect(gate()).toBe(true);
    now = 5_000;
    expect(gate()).toBe(false);
  });

  it('allows another invocation once the cooldown has fully elapsed', () => {
    let now = 0;
    const gate = createManualRefreshGate(
      () => 10,
      () => now,
    );
    expect(gate()).toBe(true);
    now = 10_000;
    expect(gate()).toBe(true);
  });

  it('reads the cooldown live from the provided setting on every call', () => {
    let now = 0;
    let cooldownSeconds = 10;
    const gate = createManualRefreshGate(
      () => cooldownSeconds,
      () => now,
    );
    expect(gate()).toBe(true);
    now = 2_000;
    cooldownSeconds = 1; // user lowered the setting between calls
    expect(gate()).toBe(true);
  });
});
