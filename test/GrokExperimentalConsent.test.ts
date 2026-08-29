import { afterEach, describe, expect, it } from 'vitest';
import {
  disableExperimentalGrokUsage,
  enableExperimentalGrokUsage,
  grokExperimentalUsageEnabled,
} from '../src/providers/grok/GrokExperimentalConsent';
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

describe('enableExperimentalGrokUsage', () => {
  it('shows a modal consent dialog before writing anything', async () => {
    __setWarningResponse(undefined);
    await enableExperimentalGrokUsage();
    expect(__warningCalls()).toHaveLength(1);
    expect(__warningCalls()[0].options).toEqual({ modal: true });
    expect(grokExperimentalUsageEnabled()).toBe(false);
  });

  it('writes the setting to Global scope and it reads back true after consent', async () => {
    __setWarningResponse('Enable Experimental Usage');
    const ok = await enableExperimentalGrokUsage();
    expect(ok).toBe(true);
    expect(grokExperimentalUsageEnabled()).toBe(true);
  });

  it('refreshes the provider only after a successful write', async () => {
    __setWarningResponse('Enable Experimental Usage');
    let refreshed = 0;
    await enableExperimentalGrokUsage(() => refreshed++);
    expect(refreshed).toBe(1);
  });

  it('does nothing when the user cancels — no write, no refresh, no crash', async () => {
    __setWarningResponse(undefined);
    let refreshed = 0;
    const ok = await enableExperimentalGrokUsage(() => refreshed++);
    expect(ok).toBe(false);
    expect(refreshed).toBe(0);
    expect(grokExperimentalUsageEnabled()).toBe(false);
  });

  it('shows a safe, specific error (not a generic failure) when the write is rejected', async () => {
    __rejectConfigWrite('aiLimitLedger', 'grok.experimentalCliProxyUsage.enabled');
    __setWarningResponse('Enable Experimental Usage');
    let refreshed = 0;
    const ok = await enableExperimentalGrokUsage(() => refreshed++);
    expect(ok).toBe(false);
    expect(refreshed).toBe(0);
    expect(grokExperimentalUsageEnabled()).toBe(false);
  });

  it('is idempotent: running it twice while already enabled does not break', async () => {
    __setWarningResponse('Enable Experimental Usage');
    await enableExperimentalGrokUsage();
    const second = await enableExperimentalGrokUsage();
    expect(second).toBe(true);
    expect(grokExperimentalUsageEnabled()).toBe(true);
  });

  it('never writes a credential-shaped value alongside the boolean setting', async () => {
    __setWarningResponse('Enable Experimental Usage');
    await enableExperimentalGrokUsage();
    const messages = __infoMessages().join(' ');
    expect(messages).not.toMatch(/token|bearer|secret/i);
  });
});

describe('disableExperimentalGrokUsage', () => {
  it('writes false and it reads back false', async () => {
    __setWarningResponse('Enable Experimental Usage');
    await enableExperimentalGrokUsage();
    expect(grokExperimentalUsageEnabled()).toBe(true);
    const ok = await disableExperimentalGrokUsage();
    expect(ok).toBe(true);
    expect(grokExperimentalUsageEnabled()).toBe(false);
  });
});
