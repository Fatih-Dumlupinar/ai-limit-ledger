import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MARKETPLACE_SCREENSHOT_FILENAME_PATTERN,
  ABSOLUTE_PATH_PATTERNS,
  KNOWN_SAFE_FIXTURE_MARKERS,
  // @ts-expect-error -- plain ES module, no type declarations
} from '../scripts/release-audit.mjs';

const ROOT = resolve(__dirname, '..');

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

  it('points to the screenshot runbook for how the pending files will be produced', () => {
    expect(inventory).toContain('MARKETPLACE-SCREENSHOT-RUNBOOK.md');
  });

  it('does not claim a screenshot is already included in the VSIX before it exists', () => {
    // Every screenshot row's "Included in VSIX" column must read "No" while pending.
    const rows = inventory
      .split('\n')
      .filter((line) => line.includes('assets/marketplace/') && line.trim().startsWith('|'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatch(/\|\s*No\b[^|]*\|\s*$/);
    }
  });
});
