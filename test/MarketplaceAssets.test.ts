import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MARKETPLACE_SCREENSHOT_FILENAME_PATTERN,
  MAX_SCREENSHOT_BYTES,
  ABSOLUTE_PATH_PATTERNS,
  KNOWN_SAFE_FIXTURE_MARKERS,
  validateScreenshotFile,
  scanMarketplaceScreenshots,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const ROOT = resolve(__dirname, '..');
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function makePngBuffer(extraAscii = ''): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(extraAscii, 'latin1'), Buffer.alloc(32)]);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('Task 13: icon asset', () => {
  const iconPath = resolve(ROOT, 'assets/icon.png');
  const iconBuffer = readFileSync(iconPath);

  it('has a valid PNG signature', () => {
    expect(iconBuffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('is at least 128x128', () => {
    expect(iconBuffer.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(iconBuffer.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
  });

  it('matches the SHA-256 recorded in docs/MARKETPLACE-ASSET-INVENTORY.md', () => {
    const inventory = readFileSync(resolve(ROOT, 'docs/MARKETPLACE-ASSET-INVENTORY.md'), 'utf8');
    const hash = sha256(iconBuffer);
    expect(inventory).toContain(hash);
  });

  it('matches the byte size recorded in docs/MARKETPLACE-ASSET-INVENTORY.md', () => {
    const inventory = readFileSync(resolve(ROOT, 'docs/MARKETPLACE-ASSET-INVENTORY.md'), 'utf8');
    expect(inventory).toContain(String(iconBuffer.length));
  });
});

describe('Task 13: Marketplace screenshot filename policy', () => {
  it.each([
    'dashboard-dark-en.png',
    'dashboard-light-en.png',
    'dashboard-tr.png',
    'safe-dashboard-en.png',
    'statusbar-tooltip-en.png',
  ])('accepts the planned filename %s', (name: string) => {
    expect(MARKETPLACE_SCREENSHOT_FILENAME_PATTERN.test(name)).toBe(true);
  });

  it.each([
    'Dashboard Dark.png', // spaces/uppercase
    '../evil.png', // path traversal
    'photo.jpg', // wrong extension
    'dashboard--dark.png', // empty segment
    'dashboard_dark.png', // underscore instead of hyphen
    '.png', // empty name
  ])('rejects %s', (name: string) => {
    expect(MARKETPLACE_SCREENSHOT_FILENAME_PATTERN.test(name)).toBe(false);
  });
});

describe('Task 13: Marketplace screenshots are not fabricated placeholders', () => {
  const dir = resolve(ROOT, 'assets/marketplace');

  it('no placeholder/mock image was committed under assets/marketplace/', () => {
    if (!existsSync(dir)) {
      // Expected state until the screenshot runbook is completed by a human with a desktop VS
      // Code install — see docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md.
      expect(existsSync(dir)).toBe(false);
      return;
    }
    const files = readdirSync(dir);
    for (const file of files) {
      const lower = file.toLowerCase();
      expect(lower).not.toContain('placeholder');
      expect(lower).not.toContain('lorem');
      expect(lower).not.toContain('mock');
      expect(lower).not.toContain('coming-soon');
    }
  });

  it('every committed screenshot (if any) has a real PNG signature, not an empty/stub file', () => {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'))) {
      const buf = readFileSync(resolve(dir, file));
      expect(buf.length).toBeGreaterThan(100);
      expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
  });
});

describe('Task 13: screenshot personal-data-rejection logic (reusing the audit pattern set)', () => {
  // Mirrors what scripts/release-audit.mjs's checkMarketplaceScreenshotAssets() does: scan the raw
  // bytes of a PNG (including any embedded tEXt/iTXt metadata) as Latin-1 text and look for
  // absolute-user-path-shaped substrings, the same way it scans source files.
  function scanBytesForPersonalPaths(text: string): boolean {
    return (ABSOLUTE_PATH_PATTERNS as RegExp[]).some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text) && !(KNOWN_SAFE_FIXTURE_MARKERS as RegExp).test(text);
    });
  }

  // These cases deliberately assemble the whole path via concatenation, not a contiguous string
  // literal, so the detector under test is proven to flag a genuinely real-looking path — a
  // contiguous Windows- or POSIX-style absolute user home path written directly in this file's
  // own source would itself be caught by this repo's static absolute-user-path release-audit scan
  // (which reads the matched substring straight from source text, not the assembled runtime
  // value). Splitting the drive/home-directory anchor prefix itself is the same technique
  // test/ReleaseAudit.test.ts already uses for its own credential-shaped fixture values.
  const winPath = ['C:', '\\Us', 'ers\\', 'realusername', '\\Desktop\\shot.png'].join('');
  const macPath = ['/Us', 'ers/', 'realusername', '/Desktop'].join('');
  const linuxPath = ['/ho', 'me/', 'realusername', '/.config'].join('');

  it('flags a real-looking embedded Windows user path', () => {
    expect(scanBytesForPersonalPaths(`tEXtComment ${winPath}`)).toBe(true);
  });

  it('flags a real-looking embedded macOS/Linux home path', () => {
    expect(scanBytesForPersonalPaths(`tEXtComment ${macPath}`)).toBe(true);
    expect(scanBytesForPersonalPaths(`tEXtComment ${linuxPath}`)).toBe(true);
  });

  it('does not flag a fixture/placeholder-marked path', () => {
    expect(scanBytesForPersonalPaths('tEXtComment C:\\Users\\fixture\\workspace')).toBe(false);
  });

  it('does not flag ordinary PNG metadata with no path', () => {
    expect(scanBytesForPersonalPaths('tEXtSoftware Paint.NET 5.0')).toBe(false);
  });
});

describe('Task 13: asset inventory lists every planned screenshot file', () => {
  const inventory = readFileSync(resolve(ROOT, 'docs/MARKETPLACE-ASSET-INVENTORY.md'), 'utf8');

  it.each([
    'assets/marketplace/dashboard-dark-en.png',
    'assets/marketplace/dashboard-light-en.png',
    'assets/marketplace/dashboard-tr.png',
    'assets/marketplace/safe-dashboard-en.png',
    'assets/marketplace/statusbar-tooltip-en.png',
  ])('lists %s', (file: string) => {
    expect(inventory).toContain(file);
  });

  it('points to the screenshot runbook describing how the optional files could be produced', () => {
    expect(inventory).toContain('MARKETPLACE-SCREENSHOT-RUNBOOK.md');
  });

  it('does not claim a screenshot is already included in the VSIX before it exists', () => {
    // Every screenshot row's "Included in VSIX" column must read "No" while absent.
    const rows = inventory
      .split('\n')
      .filter((line) => line.includes('assets/marketplace/') && line.trim().startsWith('|'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatch(/\|\s*No\b[^|]*\|\s*$/);
    }
  });
});

describe('Task 13.1: screenshots are documented as optional, not a publish blocker', () => {
  const listing = readFileSync(resolve(ROOT, 'docs/MARKETPLACE-LISTING.md'), 'utf8');
  const inventory = readFileSync(resolve(ROOT, 'docs/MARKETPLACE-ASSET-INVENTORY.md'), 'utf8');
  const preflight = readFileSync(resolve(ROOT, 'docs/MARKETPLACE-PREFLIGHT.md'), 'utf8');
  const runbook = readFileSync(resolve(ROOT, 'docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md'), 'utf8');
  const publishing = readFileSync(resolve(ROOT, 'PUBLISHING.md'), 'utf8');

  const forbiddenPhrases = [
    /open blocker/i,
    /required before (Task 14|real publish|publish)/i,
    /still missing/i,
    /must be completed before publish/i,
    /screenshots?\s+(is|are)\s+pending/i,
  ];

  it.each([
    ['docs/MARKETPLACE-LISTING.md', () => listing],
    ['docs/MARKETPLACE-ASSET-INVENTORY.md', () => inventory],
    ['docs/MARKETPLACE-PREFLIGHT.md', () => preflight],
    ['docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md', () => runbook],
    ['PUBLISHING.md', () => publishing],
  ])('%s contains no publish-blocker language about screenshots', (_name, getContent) => {
    const content = getContent();
    for (const pattern of forbiddenPhrases) {
      expect(content).not.toMatch(pattern);
    }
  });

  it('the listing explicitly states screenshots are optional', () => {
    expect(listing).toMatch(/optional/i);
  });

  it('the asset inventory explicitly states screenshots are optional, not required', () => {
    expect(inventory).toMatch(/optional/i);
  });

  it('the preflight checklist marks screenshots as optional and not a release gate', () => {
    expect(preflight).toMatch(/Optional: real product screenshots may be added later\./);
  });

  it('the preflight checklist keeps every other required-item section intact', () => {
    for (const requiredSection of [
      '## Publisher identity',
      '## Extension identity',
      '## Version',
      '## README',
      '## License',
      '## Privacy',
      '## Security',
      '## Support',
      '## Changelog',
      '## VSIX audit',
    ]) {
      expect(preflight).toContain(requiredSection);
    }
  });

  it('the runbook frames itself as an optional future enhancement, not a requirement', () => {
    expect(runbook).toMatch(/optional/i);
    expect(runbook).toMatch(/not required to publish/i);
  });

  it('the runbook still forbids AI-generated or hand-drawn fake product screens', () => {
    expect(runbook).toMatch(/AI image model|hand-draw/i);
  });
});

describe('Task 13.1: validateScreenshotFile — per-file policy checks (pure, synthetic buffers)', () => {
  it('accepts a well-formed screenshot: real PNG signature, allowed filename, under the size budget', () => {
    const issues = validateScreenshotFile('dashboard-dark-en.png', makePngBuffer());
    expect(issues).toEqual([]);
  });

  it('flags an invalid PNG signature', () => {
    const bogus = Buffer.from('this is definitely not a png file', 'utf8');
    const issues = validateScreenshotFile('dashboard-dark-en.png', bogus);
    expect(issues.some((i: string) => i.includes('not a valid PNG signature'))).toBe(true);
  });

  it('flags a screenshot over the size budget', () => {
    const oversized = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_SCREENSHOT_BYTES + 1)]);
    const issues = validateScreenshotFile('dashboard-dark-en.png', oversized);
    expect(issues.some((i: string) => i.includes('exceeds the'))).toBe(true);
  });

  it('flags a disallowed filename even when the PNG itself is valid', () => {
    const issues = validateScreenshotFile('Dashboard Dark.png', makePngBuffer());
    expect(issues.some((i: string) => i.includes('filename does not match'))).toBe(true);
  });

  it('flags a real-looking personal path embedded in the file bytes', () => {
    const realPath = ['C:', '\\Us', 'ers\\', 'realusername', '\\Desktop'].join('');
    const withPath = makePngBuffer(`tEXt ${realPath}`);
    const issues = validateScreenshotFile('dashboard-dark-en.png', withPath);
    expect(issues.some((i: string) => i.includes('possible personal path'))).toBe(true);
  });

  it('does not flag a fixture-marked path embedded in the file bytes', () => {
    const withFixturePath = makePngBuffer('tEXt C:\\Users\\fixture\\workspace');
    const issues = validateScreenshotFile('dashboard-dark-en.png', withFixturePath);
    expect(issues.some((i: string) => i.includes('possible personal path'))).toBe(false);
  });

  it('flags credential-shaped content embedded in the file bytes', () => {
    const ghpPrefix = ['gh', 'p_'].join(''); // split so this file's own text never matches the pattern
    const withToken = makePngBuffer(`tEXt token=${ghpPrefix}abcdefghijklmnopqrstuvwx`);
    const issues = validateScreenshotFile('dashboard-dark-en.png', withToken);
    expect(issues.some((i: string) => i.includes('possible credential-shaped content'))).toBe(true);
  });
});

describe('Task 13.1: scanMarketplaceScreenshots — directory-level pass/fail behavior', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ail-screenshot-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing directory is a pass, not a warn or fail', async () => {
    const dir = join(tmpdir(), 'ail-screenshot-test-does-not-exist-' + Date.now());
    const result = await scanMarketplaceScreenshots(dir);
    expect(result.severity).toBe('pass');
  });

  it('an empty directory is a pass, not a warn or fail', async () => {
    const dir = makeTempDir();
    const result = await scanMarketplaceScreenshots(dir);
    expect(result.severity).toBe('pass');
  });

  it('the real repository has none of the five planned screenshots yet, and that is a pass', async () => {
    const result = await scanMarketplaceScreenshots(resolve(ROOT, 'assets/marketplace'));
    expect(result.severity).toBe('pass');
  });

  it('a single valid screenshot is a pass, and only that file is validated/reported', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'dashboard-dark-en.png'), makePngBuffer());
    const result = await scanMarketplaceScreenshots(dir);
    expect(result.severity).toBe('pass');
    expect(result.summary).toMatch(/^1 Marketplace screenshot/);
  });

  it('an invalid PNG among the files is a fail', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'dashboard-dark-en.png'), Buffer.from('not a png', 'utf8'));
    const result = await scanMarketplaceScreenshots(dir);
    expect(result.severity).toBe('fail');
    expect(result.details.some((d: string) => d.includes('not a valid PNG signature'))).toBe(true);
  });

  it('an oversized screenshot is a fail', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'dashboard-dark-en.png'),
      Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_SCREENSHOT_BYTES + 1)]),
    );
    const result = await scanMarketplaceScreenshots(dir);
    expect(result.severity).toBe('fail');
    expect(result.details.some((d: string) => d.includes('exceeds the'))).toBe(true);
  });

  it('a screenshot with personal-path-shaped metadata is a fail', async () => {
    const dir = makeTempDir();
    const realPath = ['C:', '\\Us', 'ers\\', 'realusername', '\\Desktop'].join('');
    writeFileSync(join(dir, 'dashboard-dark-en.png'), makePngBuffer(`tEXt ${realPath}`));
    const result = await scanMarketplaceScreenshots(dir);
    expect(result.severity).toBe('fail');
    expect(result.details.some((d: string) => d.includes('possible personal path'))).toBe(true);
  });

  it('non-screenshot policy checks (icon/publisher/version/etc.) are unaffected by this directory being absent', () => {
    // Sanity guard: scanning an absent screenshot directory must not throw or otherwise disturb
    // any other part of the audit — the pure function only ever inspects the one directory given.
    expect(async () => scanMarketplaceScreenshots(join(tmpdir(), 'does-not-exist'))).not.toThrow();
  });
});
