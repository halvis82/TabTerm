import { describe, expect, it } from 'vitest';
import { findCandidates, findUrls } from './path-links.js';

const texts = (s: string) => findCandidates(s).map((c) => c.text);

describe('path candidate detection', () => {
  it('finds an absolute path', () => {
    expect(texts('  ⎿  /Users/me/Documents/code/wifi-site-blocker')).toContain(
      '/Users/me/Documents/code/wifi-site-blocker',
    );
  });

  it('finds a relative path', () => {
    expect(texts('editing src/main.ts now')).toContain('src/main.ts');
  });

  it('keeps a line and column suffix attached', () => {
    expect(texts('src/main.ts:42:7: error')).toContain('src/main.ts:42:7');
  });

  it('finds a home-relative path', () => {
    expect(texts('cd ~/Projects/eeg')).toContain('~/Projects/eeg');
  });

  it('strips trailing punctuation a human would not include', () => {
    expect(texts('see src/main.ts, then go')).toContain('src/main.ts');
    expect(texts('(src/main.ts)')).toContain('src/main.ts');
  });

  it('finds several paths on one line', () => {
    const found = texts('cp src/a.ts dist/b.ts');
    expect(found).toContain('src/a.ts');
    expect(found).toContain('dist/b.ts');
  });

  it('ignores ordinary prose with no path in it', () => {
    expect(texts('Cooked for 3s and everything was fine')).toHaveLength(0);
  });

  it('does not match a bare word', () => {
    expect(texts('pwd')).toHaveLength(0);
  });

  it('reports offsets that map back to the original text', () => {
    const line = 'error in src/main.ts here';
    const [c] = findCandidates(line);
    expect(c).toBeDefined();
    expect(line.slice(c!.start, c!.end)).toBe('src/main.ts');
  });

  it('survives a line of pure punctuation without throwing', () => {
    expect(() => findCandidates('////::::....~~~~')).not.toThrow();
  });
});

describe('URL detection', () => {
  it('finds a bare URL', () => {
    expect(findUrls('see https://example.com/docs for more').map((u) => u.text)).toContain(
      'https://example.com/docs',
    );
  });

  it('strips trailing punctuation from a URL', () => {
    expect(findUrls('(https://example.com/x).').map((u) => u.text)).toContain(
      'https://example.com/x',
    );
  });

  it('ignores non-http schemes entirely', () => {
    expect(findUrls('javascript:alert(1) data:text/html,x file:///etc/passwd')).toHaveLength(0);
  });

  it('does not treat a path as a URL', () => {
    expect(findUrls('/Users/me/Projects')).toHaveLength(0);
  });
});
