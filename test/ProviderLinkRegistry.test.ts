import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PROVIDER_LINK_HOSTS,
  getProviderInstallGuidance,
  getProviderLink,
  PROVIDER_LINK_REGISTRY,
  validateProviderLinkDefinitions,
  validateProviderLinkUrl,
} from '../src/links/ProviderLinkRegistry';

describe('ProviderLinkRegistry', () => {
  it('contains immutable, canonical provider definitions with unique IDs', () => {
    expect(validateProviderLinkDefinitions(PROVIDER_LINK_REGISTRY)).toEqual({
      valid: true,
      issues: [],
    });
    expect(new Set(PROVIDER_LINK_REGISTRY.map((link) => link.id)).size).toBe(
      PROVIDER_LINK_REGISTRY.length,
    );
    expect(PROVIDER_LINK_REGISTRY.every((link) => Object.isFrozen(link))).toBe(true);
    expect(PROVIDER_LINK_REGISTRY).toContain(getProviderLink('codex-usage'));
  });

  it('validates protocol, exact hosts, userinfo, ports, IPs and shorteners', () => {
    expect(
      validateProviderLinkUrl('https://chatgpt.com/codex/cloud/settings/analytics#usage').valid,
    ).toBe(true);
    expect(
      validateProviderLinkUrl('http://chatgpt.com/codex/cloud/settings/analytics#usage').valid,
    ).toBe(false);
    expect(validateProviderLinkUrl('https://evilgithub.com/settings/billing').valid).toBe(false);
    expect(validateProviderLinkUrl('https://github.com.evil.example/settings/billing').valid).toBe(
      false,
    );
    expect(validateProviderLinkUrl('https://user:pass@github.com/settings/billing').valid).toBe(
      false,
    );
    expect(validateProviderLinkUrl('https://github.com:444/settings/billing').valid).toBe(false);
    expect(validateProviderLinkUrl('https://127.0.0.1/settings/billing').valid).toBe(false);
    expect(validateProviderLinkUrl('https://bit.ly/provider').valid).toBe(false);
    expect(ALLOWED_PROVIDER_LINK_HOSTS).not.toContain('*.github.com');
  });

  it('allows only fixed query and fragment values', () => {
    expect(validateProviderLinkUrl('https://grok.com/?_s=billing').valid).toBe(true);
    expect(
      validateProviderLinkUrl(
        'https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat',
      ).valid,
    ).toBe(true);
    expect(validateProviderLinkUrl('https://grok.com/?token=secret').valid).toBe(false);
    expect(validateProviderLinkUrl('https://grok.com/?_s=other').valid).toBe(false);
    expect(validateProviderLinkUrl('https://chatgpt.com/#usage-from-user').valid).toBe(false);
  });

  it('keeps setup guidance separate from experimental transport labels', () => {
    expect(getProviderInstallGuidance('codex').summary).toContain('required for automatic usage');
    expect(getProviderInstallGuidance('claude').summary).toContain('experimental');
    expect(getProviderInstallGuidance('copilot').summary).toContain('optional');
    expect(getProviderInstallGuidance('grok').cliUsageInstruction).toContain('/usage');
    expect(getProviderLink('grok-home').label).not.toMatch(/usage/i);
  });
});
