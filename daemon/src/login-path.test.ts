import { describe, expect, it } from 'vitest';
import { afterMark, loginPath, resetLoginPathCache, resolveExecutable } from './login-path.js';

/**
 * The PATH a person actually has.
 *
 * `.zshrc` is read by interactive shells only, and it is where `~/.local/bin` is put in front of
 * everything else on this machine and most others. A login shell that is not interactive answers
 * with a PATH nobody has, and the cost of that was real: `claude` resolved to a copy from May
 * 2025 that asks for a model which no longer exists, so every prompt in an agent TabTerm started
 * came back `API Error: 404`.
 */
describe('reading the PATH out of a shell that prints other things too', () => {
  it('takes the fenced line and ignores the noise around it', () => {
    const output = [
      'Welcome to your shell',
      'nvm: loaded',
      '__tabterm_path__/a/bin:/b/bin',
      '',
    ].join('\n');
    expect(afterMark(output)).toBe('/a/bin:/b/bin');
  });

  it('answers nothing when the marker never appeared', () => {
    // A profile that refuses to run interactively. The caller falls back rather than guessing.
    expect(afterMark('some other output\n')).toBe('');
  });

  it('is not confused by the marker being mentioned in the noise', () => {
    // The line has to start with it, not merely contain it.
    expect(afterMark('see __tabterm_path__ for details\n__tabterm_path__/real/bin\n')).toBe(
      '/real/bin',
    );
  });
});

describe('the PATH this machine answers with', () => {
  it('is the one a person gets in their own terminal', () => {
    resetLoginPathCache();
    const path = loginPath();
    expect(path.split(':').length).toBeGreaterThan(3);
    /*
     * Asserted against the shell rather than against a list, because a list is a second copy of
     * somebody's configuration and would be wrong on the next machine.
     */
    expect(path).toContain('/bin');
  });

  it('finds a command where an interactive shell would find it', () => {
    resetLoginPathCache();
    // `ls` rather than an agent, since every machine has one and no machine has both agents.
    const found = resolveExecutable('ls');
    expect(found).not.toBeNull();
    expect(found).toMatch(/\/ls$/);
  });
});
