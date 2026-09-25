import { describe, expect, it } from 'vitest';
import { safeError } from './safe-error.js';

/**
 * What an error is allowed to say in a log that outlives the failure.
 *
 * The rule this exists to hold is that a path never appears. `String(e)` on a filesystem error
 * carries one, and the field is called `error`, which is why a field-name audit could not see it.
 */
describe('describing an error for a log', () => {
  const errno = (code: string, syscall?: string, message = 'boom'): Error => {
    const e = new Error(message) as NodeJS.ErrnoException;
    e.code = code;
    if (syscall !== undefined) e.syscall = syscall;
    return e;
  };

  it('keeps the kind and the code', () => {
    expect(safeError(errno('ENOENT'))).toBe('Error(ENOENT)');
  });

  it('and the call it failed in, which a code alone cannot say', () => {
    // EPERM against a layout that did not open could be looking at a folder, making one, or
    // starting a shell. Three different faults, one code.
    expect(safeError(errno('EPERM', 'mkdir'))).toBe('Error(EPERM, mkdir)');
  });

  it('says only the kind when there is no code', () => {
    expect(safeError(new TypeError('nope'))).toBe('TypeError');
  });

  it('never repeats the message, whatever is in it', () => {
    const said = safeError(
      errno('ENOENT', 'open', "ENOENT: no such file, open '/Users/somebody/Projects/a-client.md'"),
    );
    expect(said).not.toContain('/Users');
    expect(said).not.toContain('a-client');
    expect(said).toBe('Error(ENOENT, open)');
  });

  it('survives being handed something that is not an error', () => {
    expect(safeError('a string')).toBe('string');
    expect(safeError(null)).toBe('none');
    expect(safeError(undefined)).toBe('none');
    expect(safeError(42)).toBe('number');
  });
});
