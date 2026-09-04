/**
 * How much a terminal has on its screen, for deciding whether a tab has been used at all.
 *
 * Its own module because it is a decision rather than a detail: a tab showing the start screen
 * and a tab showing work are told apart by this, and getting it wrong drops somebody into a bare
 * shell they did not ask for. Away from the page so it can be checked without a browser.
 */
import { isShellNoise } from '@tabterm/shared';

interface BufferLike {
  buffer: {
    active: {
      length: number;
      getLine: (y: number) => { translateToString: (trim: boolean) => string } | undefined;
    };
  };
}

/**
 * Lines with something on them that a person put there, counted up to two.
 *
 * Two is all the caller needs: "more than one line" is the question. Stopping there also means
 * this stays cheap on a screen holding ten thousand lines of scrollback.
 *
 * A shell's partial-line marker does not count. zsh prints a lone inverse `%` when output did not
 * end in a newline, which happens for ordinary reasons and left an untouched shell looking used.
 */
export function linesWithContent(term: BufferLike): number {
  const buffer = term.buffer.active;
  let count = 0;
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)?.translateToString(true) ?? '';
    if (line.trim() !== '' && !isShellNoise(line)) count++;
    if (count > 1) return count;
  }
  return count;
}
