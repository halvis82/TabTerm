import { describe, expect, it } from 'vitest';
import { isShellNoise, linesOfContent } from './shell-noise.js';

/**
 * The lone `%` a shell prints, which is not output and was being counted as work.
 *
 * zsh marks output that did not end in a newline by printing an inverse `%` and a newline, so
 * the last of it is not overwritten by the prompt. An untouched shell can therefore show two
 * lines. Two lines meant "this tab has been used", so the start screen was taken away and the
 * person was dropped into a terminal holding a percent sign.
 */
describe('what a shell prints that nobody typed', () => {
  it('recognises the partial-line marker on its own', () => {
    expect(isShellNoise('%')).toBe(true);
    expect(isShellNoise(' % ')).toBe(true);
    expect(isShellNoise('$')).toBe(true);
    expect(isShellNoise('#')).toBe(true);
  });

  it('and nothing else, because a % in real output is real output', () => {
    // Narrow on purpose. "starts with %" would hide the first line of anything about
    // percentages, which is a far worse failure than showing one stray character.
    expect(isShellNoise('% ls')).toBe(false);
    expect(isShellNoise('50%')).toBe(false);
    expect(isShellNoise('%%')).toBe(false);
    expect(isShellNoise('progress: 12%')).toBe(false);
  });

  it('counts a prompt under a marker as one line, which is what empty means', () => {
    expect(linesOfContent(['%', '(base) halvis82@Mac ~ %'])).toBe(1);
  });

  it('still counts real output above a prompt', () => {
    expect(linesOfContent(['hello', '(base) halvis82@Mac ~ %'])).toBe(2);
  });

  it('ignores blank lines, which is what it always did', () => {
    expect(linesOfContent(['', '   ', 'one'])).toBe(1);
  });
});
