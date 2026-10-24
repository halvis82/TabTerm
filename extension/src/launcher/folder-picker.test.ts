import { describe, expect, it } from 'vitest';
import { upFrom } from './folder-picker.js';

describe('upFrom', () => {
  const home = '/Users/me';

  it('takes one segment off what was typed, keeping its form', () => {
    expect(upFrom('Documents/code/', home)).toBe('Documents/');
    expect(upFrom('Documents/', home)).toBe('');
    expect(upFrom('~/Documents/', home)).toBe('~/');
    expect(upFrom('/usr/local/', home)).toBe('/usr/');
    expect(upFrom('/usr/', home)).toBe('/');
  });

  it('goes above home from home, which used to be a button that did nothing', () => {
    expect(upFrom('', home)).toBe('/Users/');
    expect(upFrom('~/', home)).toBe('/Users/');
  });

  it('offers nothing at the root, or when home is not known yet', () => {
    expect(upFrom('/', home)).toBeNull();
    expect(upFrom('', '~')).toBeNull();
  });
});
