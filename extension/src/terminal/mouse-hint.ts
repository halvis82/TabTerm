/**
 * Why the mouse stopped selecting, said once, when it happens.
 *
 * A program can ask the terminal for the mouse, and while it has it the terminal stops selecting
 * with it: drags go to the program instead. Every terminal behaves this way and every terminal
 * offers the same escape, which is to hold a modifier.
 *
 * That is fine for somebody who knows it and baffling for anybody else. Reported as text that could
 * not be selected in one tab while everything else worked, and it was an agent that had turned
 * mouse reporting on and not turned it off: counted in that session's own scrollback, on 188 times
 * and off 4.
 *
 * So the terminal says so, once per pane, at the moment somebody tries. Not a setting and not a
 * banner: an answer to a question that has just been asked.
 */
export type MouseMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/**
 * Whether a drag with no modifier is about to do nothing a person wanted.
 *
 * `x10` reports a press and nothing else, so a drag still selects under it and there is nothing to
 * explain. The others take the drag.
 */
export function dragIsTakenByProgram(
  mode: MouseMode,
  held: { alt: boolean; shift: boolean },
): boolean {
  if (held.alt || held.shift) return false;
  return mode === 'vt200' || mode === 'drag' || mode === 'any';
}

export const MOUSE_HINT = 'This program is using the mouse. Hold Option to select text.';
