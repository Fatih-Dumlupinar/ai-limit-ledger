import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_README_EN_SECTIONS,
  REQUIRED_README_TR_SECTIONS,
  FORBIDDEN_MARKETING_CLAIMS,
  ABSOLUTE_PATH_PATTERNS,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const ROOT = resolve(__dirname, '..');
const readmeEn = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const readmeTr = readFileSync(resolve(ROOT, 'README.tr.md'), 'utf8');

function hasHeading(content: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^#{1,3}\\s+${escaped}\\s*$`, 'm').test(content);
}

describe('Task 13: README.md required Marketplace sections', () => {
  it.each(REQUIRED_README_EN_SECTIONS)('has a "%s" heading', (heading: string) => {
    expect(hasHeading(readmeEn, heading)).toBe(true);
  });
});

describe('Task 13: README.tr.md required Marketplace sections (parity)', () => {
  it.each(REQUIRED_README_TR_SECTIONS)('has a "%s" heading', (heading: string) => {
    expect(hasHeading(readmeTr, heading)).toBe(true);
  });

  it('has exactly as many required top-level Marketplace sections as the English README', () => {
    expect(REQUIRED_README_TR_SECTIONS.length).toBe(REQUIRED_README_EN_SECTIONS.length);
  });
});

describe('Task 13: non-affiliation notice', () => {
  it('README.md states independence from Microsoft, GitHub, OpenAI, Anthropic, and xAI', () => {
    expect(readmeEn).toMatch(/not affiliated with,?\s*endorsed by,?\s*or sponsored by/i);
    for (const provider of ['Microsoft', 'GitHub', 'OpenAI', 'Anthropic', 'xAI']) {
      expect(readmeEn).toContain(provider);
    }
  });

  it('README.tr.md carries the same non-affiliation semantics in Turkish', () => {
    expect(readmeTr).toMatch(/bağlantılı\s+değildir/i);
    for (const provider of ['Microsoft', 'GitHub', 'OpenAI', 'Anthropic', 'xAI']) {
      expect(readmeTr).toContain(provider);
    }
  });

  it('does not use a provider logo/trademark image anywhere in either README', () => {
    // Only text mentions of provider names are permitted for interoperability — no logo images.
    expect(readmeEn).not.toMatch(/!\[[^\]]*logo[^\]]*\]/i);
    expect(readmeTr).not.toMatch(/!\[[^\]]*logo[^\]]*\]/i);
  });
});

describe('Task 13: no overstated marketing claims', () => {
  it('none of the forbidden absolute claim patterns appear in README.md', () => {
    for (const { pattern } of FORBIDDEN_MARKETING_CLAIMS) {
      expect(readmeEn).not.toMatch(pattern);
    }
  });

  it('none of the forbidden absolute claim patterns appear in README.tr.md', () => {
    for (const { pattern } of FORBIDDEN_MARKETING_CLAIMS) {
      expect(readmeTr).not.toMatch(pattern);
    }
  });
});

describe('Task 13: provider limitation and provenance disclosures', () => {
  it('discloses that Claude session insight reflects only the latest observed CLI session, not an account total', () => {
    expect(readmeEn).toMatch(/most recently observed( local)? CLI session/i);
    expect(readmeTr).toContain('en son gözlemlenen');
  });

  it('discloses that GitHub Copilot organization-managed accounts may have no personal allowance', () => {
    expect(readmeEn).toMatch(
      /organization-managed accounts may (not expose|have no) a? ?personal allowance/i,
    );
    expect(readmeTr).toContain('kişisel bir ödenek');
    expect(readmeTr).toContain('organizasyon');
  });

  it('discloses that Grok Free accounts may not receive a numeric usage percentage', () => {
    expect(readmeEn).toMatch(/Grok Free accounts may not receive a numeric usage percentage/i);
    expect(readmeTr).toContain('sayısal bir kullanım yüzdesi');
    expect(readmeTr).toContain('Grok Free');
  });

  it('labels experimental sources as experimental (bolded) in both READMEs', () => {
    expect(readmeEn).toMatch(/\*\*experimental\*\*/i);
    expect(readmeTr).toMatch(/\*\*deneysel/i);
  });

  it('never claims providers are combined into a single total (each README explicitly denies it)', () => {
    expect(readmeEn).toMatch(/never (summed|combine[ds]?) across providers/i);
    expect(readmeTr).toContain('sağlayıcılar arasında asla toplanmaz');
  });

  it('states that a missing value is shown as unavailable rather than treated as zero', () => {
    expect(readmeEn).toMatch(
      /missing value is shown as unavailable rather than (treated as|estimated as) zero/i,
    );
    expect(readmeTr).toContain('kullanılamaz olarak gösterilir');
  });
});

describe('Task 13: support links', () => {
  it('README.md links to the real GitHub Issues page and SUPPORT.md', () => {
    expect(readmeEn).toContain('https://github.com/Fatih-Dumlupinar/ai-limit-ledger/issues');
    expect(readmeEn).toContain('SUPPORT.md');
  });

  it('README.tr.md links to the real GitHub Issues page and SUPPORT.md', () => {
    expect(readmeTr).toContain('https://github.com/Fatih-Dumlupinar/ai-limit-ledger/issues');
    expect(readmeTr).toContain('SUPPORT.md');
  });
});

describe('Task 13: image links are HTTPS-only, no local/absolute paths', () => {
  const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;

  function imageUrls(content: string): string[] {
    const urls: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(imgPattern);
    while ((m = re.exec(content))) urls.push(m[1]);
    return urls;
  }

  it('README.md has no http://, file://, or Windows-absolute-path image links', () => {
    for (const url of imageUrls(readmeEn)) {
      expect(url).not.toMatch(/^http:\/\//i);
      expect(url).not.toMatch(/^file:\/\//i);
      expect(url).not.toMatch(/^[A-Za-z]:\\/);
    }
  });

  it('README.tr.md has no http://, file://, or Windows-absolute-path image links', () => {
    for (const url of imageUrls(readmeTr)) {
      expect(url).not.toMatch(/^http:\/\//i);
      expect(url).not.toMatch(/^file:\/\//i);
      expect(url).not.toMatch(/^[A-Za-z]:\\/);
    }
  });

  it('neither README contains a real absolute user home path', () => {
    for (const content of [readmeEn, readmeTr]) {
      for (const pattern of ABSOLUTE_PATH_PATTERNS as RegExp[]) {
        pattern.lastIndex = 0;
        expect(pattern.test(content)).toBe(false);
      }
    }
  });
});

describe('Task 13: screenshots are not fabricated', () => {
  it('README.md does not reference a local assets/marketplace screenshot path (none exist yet — nothing was faked)', () => {
    // The only images allowed are the CI/CodeQL status badges (dynamically generated, hosted on
    // GitHub); no local screenshot/mockup file reference is permitted until it genuinely exists.
    expect(readmeEn).not.toMatch(/!\[[^\]]*\]\(assets\/marketplace\//);
    expect(readmeEn).not.toMatch(/!\[[^\]]*\]\([^)]*\.(png|jpg|jpeg|gif)\)/i);
  });

  it('README.tr.md does not reference a local assets/marketplace screenshot path', () => {
    expect(readmeTr).not.toMatch(/!\[[^\]]*\]\(assets\/marketplace\//);
    expect(readmeTr).not.toMatch(/!\[[^\]]*\]\([^)]*\.(png|jpg|jpeg|gif)\)/i);
  });

  it('README.md points to the screenshot runbook instead of an embedded image', () => {
    expect(readmeEn).toContain('docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md');
  });

  it('README.tr.md points to the screenshot runbook instead of an embedded image', () => {
    expect(readmeTr).toContain('docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md');
  });
});
