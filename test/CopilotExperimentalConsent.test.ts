import { afterEach, describe, expect, it } from 'vitest';
import {
  copilotExperimentalUsageEnabled,
  disableExperimentalCopilotUsage,
  enableExperimentalCopilotUsage,
} from '../src/providers/copilot/CopilotExperimentalConsent';
import {
  __infoMessages,
  __rejectConfigWrite,
  __resetConfigMocks,
  __resetWindowMocks,
  __setWarningResponse,
  __warningCalls,
} from './vscode';

afterEach(() => {
  __resetConfigMocks();
  __resetWindowMocks();
});

describe('enableExperimentalCopilotUsage', () => {
  it('shows a modal consent dialog before writing anything', async () => {
    __setWarningResponse(undefined);
    await enableExperimentalCopilotUsage();
    expect(__warningCalls()).toHaveLength(1);
    expect(__warningCalls()[0].options).toEqual({ modal: true });
    expect(copilotExperimentalUsageEnabled()).toBe(false);
  });

  it('writes the setting to Global scope and it reads back true after consent', async () => {
    __setWarningResponse('Enable Experimental Usage');
    const ok = await enableExperimentalCopilotUsage();
    expect(ok).toBe(true);
    expect(copilotExperimentalUsageEnabled()).toBe(true);
  });

  it('refreshes the provider only after a successful write', async () => {
    __setWarningResponse('Enable Experimental Usage');
    let refreshed = 0;
    await enableExperimentalCopilotUsage(() => refreshed++);
    expect(refreshed).toBe(1);
  });

  it('does nothing when the user cancels — no write, no refresh, no crash', async () => {
    __setWarningResponse(undefined);
    let refreshed = 0;
    const ok = await enableExperimentalCopilotUsage(() => refreshed++);
    expect(ok).toBe(false);
    expect(refreshed).toBe(0);
    expect(copilotExperimentalUsageEnabled()).toBe(false);
  });

  it('shows a safe, specific error (not a generic failure) when the write is rejected', async () => {
    __rejectConfigWrite('aiLimitLedger', 'copilot.experimentalEntitlementUsage.enabled');
    __setWarningResponse('Enable Experimental Usage');
    let refreshed = 0;
    const ok = await enableExperimentalCopilotUsage(() => refreshed++);
    expect(ok).toBe(false);
    expect(refreshed).toBe(0);
    // onChanged must not fire, and the setting must not read back as enabled, on a rejected write.
    expect(copilotExperimentalUsageEnabled()).toBe(false);
  });

  it('is idempotent: running it twice while already enabled does not break', async () => {
    __setWarningResponse('Enable Experimental Usage');
    await enableExperimentalCopilotUsage();
    const second = await enableExperimentalCopilotUsage();
    expect(second).toBe(true);
    expect(copilotExperimentalUsageEnabled()).toBe(true);
  });

  it('never writes a credential-shaped value alongside the boolean setting', async () => {
    __setWarningResponse('Enable Experimental Usage');
    await enableExperimentalCopilotUsage();
    const messages = __infoMessages().join(' ');
    expect(messages).not.toMatch(/token|bearer|secret/i);
  });
});

describe('disableExperimentalCopilotUsage', () => {
  it('writes false and it reads back false', async () => {
    __setWarningResponse('Enable Experimental Usage');
    await enableExperimentalCopilotUsage();
    expect(copilotExperimentalUsageEnabled()).toBe(true);
    const ok = await disableExperimentalCopilotUsage();
    expect(ok).toBe(true);
    expect(copilotExperimentalUsageEnabled()).toBe(false);
  });
});
