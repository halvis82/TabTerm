/**
 * Lines a shell prints that are not output.
 *
 * A terminal that has "nothing in it" is the basis of two decisions: whether a tab still shows
 * its start screen, and whether a session the daemon adopted has ever been used. Both count the
 * lines with something on them, and both were wrong for the same reason.
 *
 * **zsh marks a partial line.** When a command's output does not end in a newline, zsh prints an
 * inverse `%` and then a newline, so the last of that output is not overwritten by the prompt.
 * That is the whole of the feature, it is on by default, and it means an untouched shell can show
 * two lines: a lone `%` and a prompt. bash does the same with `$` under some configurations.
 *
 * So the marker is not content. Nothing was run, nothing was printed, and a tab holding one is as
 * empty as a tab holding none.
 */

/**
 * Is this line only a shell's partial-line marker?
 *
 * Deliberately narrow. A line of exactly one character, being one of the two markers, and nothing
 * else. `% ls` is a person's transcript and counts; `%` on its own is furniture. Widening this to
 * "starts with %" would hide real output the first time somebody printed a percentage.
 */
export function isShellNoise(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '%' || trimmed === '$' || trimmed === '#';
}

/** How many of these lines have anything on them that a person put there. */
export function linesOfContent(lines: readonly string[]): number {
  return lines.filter((line) => line.trim() !== '' && !isShellNoise(line)).length;
}
