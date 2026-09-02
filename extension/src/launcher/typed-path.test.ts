import { describe, expect, it } from 'vitest';
import { resolveTypedPath, unresolveTypedPath } from './typed-path.js';

const HOME = '/Users/someone';

describe('what a typed path means', () => {
  it('takes a bare name as being under home', () => {
    // Nobody types `~/` before `Documents` when they mean the obvious thing.
    expect(resolveTypedPath('Documents', HOME)).toBe('~/Documents');
    expect(resolveTypedPath('Documents/work', HOME)).toBe('~/Documents/work');
  });

  it('takes a leading slash literally, which is the one case it should', () => {
    expect(resolveTypedPath('/etc', HOME)).toBe('/etc');
    expect(resolveTypedPath('/', HOME)).toBe('/');
  });

  it('leaves a tilde somebody wrote themselves alone', () => {
    expect(resolveTypedPath('~/Documents', HOME)).toBe('~/Documents');
    expect(resolveTypedPath('~', HOME)).toBe('~');
  });

  it('takes an empty box as home', () => {
    expect(resolveTypedPath('', HOME)).toBe(HOME);
    expect(resolveTypedPath('   ', HOME)).toBe(HOME);
  });

  it('puts an answer back the way it was asked', () => {
    // They typed `Doc`, so they should see `Documents` rather than a tilde appearing under
    // their cursor.
    expect(unresolveTypedPath('~/Documents', 'Doc')).toBe('Documents');
    expect(unresolveTypedPath('~/Documents/work', 'Documents/w')).toBe('Documents/work');
  });

  it('keeps a tilde in the answer when there was one in the question', () => {
    expect(unresolveTypedPath('~/Documents', '~/Doc')).toBe('~/Documents');
    expect(unresolveTypedPath('/etc/hosts', '/etc/h')).toBe('/etc/hosts');
  });
});
