import { describe, expect, it } from 'vitest';
import { shorten } from './launcher.js';

describe('path display', () => {
  const home = '/Users/someone';

  it('abbreviates the home directory', () => {
    expect(shorten('/Users/someone/Projects/eeg', home)).toBe('~/Projects/eeg');
    expect(shorten('/Users/someone', home)).toBe('~');
  });

  it('leaves paths outside home alone', () => {
    expect(shorten('/usr/local/bin', home)).toBe('/usr/local/bin');
    expect(shorten('/Users/other/thing', home)).toBe('/Users/other/thing');
  });
});
