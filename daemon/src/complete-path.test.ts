import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commonPrefix, completePath, contractHome, expandHome } from './complete-path.js';

let home = '';

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tt-complete-'));
  for (const dir of ['Documents', 'Downloads', 'Desktop', 'Doc-other', '.hidden']) {
    mkdirSync(join(home, dir));
  }
  mkdirSync(join(home, 'Documents', 'Projects'));
  writeFileSync(join(home, 'Documents', 'notes.txt'), 'x');
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('completing a folder the way a shell does', () => {
  it('completes as far as the candidates agree', () => {
    // Three of these start with "D", so Tab can only get as far as they share.
    const out = completePath('~/D', home);
    expect(out.completed).toBe('~/D');
    expect(out.matches).toEqual(['Desktop', 'Doc-other', 'Documents', 'Downloads']);
  });

  it('completes fully when only one thing matches, with a trailing slash', () => {
    // The slash is what lets the next Tab go deeper.
    expect(completePath('~/Documen', home).completed).toBe('~/Documents/');
  });

  it('lists what is inside once the directory is complete', () => {
    expect(completePath('~/Documents/', home).matches).toEqual(['Projects']);
  });

  it('offers directories only, since a file cannot be opened as one', () => {
    expect(completePath('~/Documents/n', home).matches).toEqual([]);
  });

  it('hides dotfiles until they are asked for, as a shell does', () => {
    expect(completePath('~/', home).matches).not.toContain('.hidden');
    expect(completePath('~/.h', home).matches).toEqual(['.hidden']);
  });

  it('leaves what was typed alone when nothing matches', () => {
    expect(completePath('~/zzz', home)).toEqual({ completed: '~/zzz', matches: [] });
  });

  it('says nothing about a directory that does not exist', () => {
    expect(completePath('/no/such/place/x', home).matches).toEqual([]);
  });

  it('survives a path it cannot read rather than throwing', () => {
    expect(() => completePath('/dev/null/nope', home)).not.toThrow();
  });

  it('keeps the tilde it was given', () => {
    expect(completePath('~/Documen', home).completed.startsWith('~')).toBe(true);
  });

  it('works from an absolute path too', () => {
    expect(completePath(`${home}/Documen`, home).completed).toBe('~/Documents/');
  });
});

describe('the pieces', () => {
  it('finds what candidates share', () => {
    expect(commonPrefix(['Documents', 'Downloads'])).toBe('Do');
    expect(commonPrefix(['one'])).toBe('one');
    expect(commonPrefix([])).toBe('');
    expect(commonPrefix(['a', 'b'])).toBe('');
  });

  it('round trips a home path', () => {
    expect(expandHome('~/x', '/Users/someone')).toBe('/Users/someone/x');
    expect(expandHome('~', '/Users/someone')).toBe('/Users/someone');
    expect(contractHome('/Users/someone/x', '/Users/someone')).toBe('~/x');
    expect(contractHome('/etc', '/Users/someone')).toBe('/etc');
  });
});
