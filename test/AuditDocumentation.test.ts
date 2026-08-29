import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const DOC_FILES = [
  'README.md',
  'SECURITY.md',
  'PUBLISHING.md',
  'docs/DEPENDENCY-RISK-REGISTER.md',
].filter((f) => existsSync(resolve(ROOT, f)));

const docs = new Map(DOC_FILES.map((f) => [f, readFileSync(resolve(ROOT, f), 'utf8')]));

// A false claim this suite guards against: describing `npm audit` itself as offline/network-free.
// It is fine (and expected) for these files to say `npm run audit:release` is offline — that
// claim is true. It is a bug if the word "offline" (or "no network"/"network gerektirmez") ever
// sits next to a bare `npm audit` claim without "audit:release" nearby to disambiguate.
function claimsNpmAuditIsOffline(text: string): boolean {
  const offlineMentions = [...text.matchAll(/offline|no network|network gerektirmez/gi)];
  for (const mention of offlineMentions) {
    const windowStart = Math.max(0, mention.index! - 150);
    const windowEnd = Math.min(text.length, mention.index! + 150);
    const window = text.slice(windowStart, windowEnd);
    const mentionsBareNpmAudit = /npm audit(?!:release)(?!\s*--json.*release)/i.test(window);
    const mentionsAuditRelease = /audit:release|release-audit\.mjs/i.test(window);
    // A sentence that is itself correcting/negating the false claim (errata prose, "it is
    // not", "requires network"/"registry") is documentation ABOUT the bug, not the bug itself.
    const isCorrective =
      /errata|is not\b|requires? (network|registry)|not the same|separate tool/i.test(window);
    if (mentionsBareNpmAudit && !mentionsAuditRelease && !isCorrective) return true;
  }
  return false;
}

describe('Task 10.1: npm audit network-semantics documentation is accurate', () => {
  it.each(DOC_FILES)('%s never claims bare `npm audit` is offline/network-free', (file) => {
    expect(claimsNpmAuditIsOffline(docs.get(file)!)).toBe(false);
  });

  it('README explicitly documents that npm audit requires registry network access', () => {
    expect(docs.get('README.md')).toMatch(/npm audit.{0,200}(network|registry)/is);
  });

  it('README explicitly distinguishes npm audit from npm run audit:release', () => {
    const readme = docs.get('README.md')!;
    expect(readme).toMatch(/audit:release/);
    expect(readme).toMatch(/not.{0,40}(the )?same tool|not interchangeable|separate/i);
  });

  it('the dependency risk register carries an errata note correcting the original offline mischaracterization', () => {
    const register = docs.get('docs/DEPENDENCY-RISK-REGISTER.md')!;
    expect(register).toMatch(/Errata/i);
    expect(register).toMatch(/npm audit/i);
  });

  it('the 0.6.1 security audit historical document is preserved (not silently rewritten) and carries its own errata note', () => {
    const path = resolve(ROOT, 'docs/SECURITY-AUDIT-0.6.1.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toMatch(/Errata/i);
    // The original (imprecise) sentence must still be present, unedited, alongside the errata —
    // a silent rewrite would delete it instead of correcting it in place.
    expect(content).toMatch(/no other network access was used/);
  });
});
