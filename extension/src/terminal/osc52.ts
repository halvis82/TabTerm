/**
 * A program putting text on the clipboard, by asking the terminal to (`OSC 52`).
 *
 * vim with `set clipboard`, tmux, neovim, and anything running over ssh copy this way, because the
 * program has no clipboard of its own to reach: on a remote machine the only thing that can touch
 * this Mac's clipboard is the terminal showing it. TabTerm ignored the sequence, so their copy did
 * nothing and said nothing.
 *
 * **Writing only.** The same sequence with `?` in place of the text asks the terminal to send the
 * clipboard back, which would hand whatever was last copied, a password included, to any program
 * that prints the right bytes, `cat` of a file somebody was sent among them. Asking is answered
 * with silence, which is what iTerm2, Ghostty and kitty do by default as well.
 *
 * **Bounded.** A copy is something a person did, and tens of megabytes of it is not one.
 */

/** Decoded text, in characters. Larger than any yank a person makes, smaller than a log file. */
export const MAX_COPY_CHARS = 4_000_000;

/** Whether programs may copy, on unless turned off, the way the other terminals ship it. */
export const PROGRAM_COPY_KEY = 'tabterm.programsMayCopy';

/** Whether the bell shows, on unless turned off. */
export const BELL_KEY = 'tabterm.showBell';

export type Osc52 = { kind: 'write'; text: string } | { kind: 'ignored'; reason: string };

/**
 * What an `OSC 52` payload asks for.
 *
 * The payload is `Pc;Pd`: which clipboards (`c`, `p`, `s` and so on, or nothing for the default),
 * then the text in base64. A Mac has one clipboard, so every target means that one.
 */
export function parseOsc52(data: string): Osc52 {
  const semi = data.indexOf(';');
  if (semi === -1) return { kind: 'ignored', reason: 'malformed' };
  const payload = data.slice(semi + 1);
  if (payload === '?') return { kind: 'ignored', reason: 'read' };
  // Empty means "clear", which would wipe what somebody copied for a program that cannot know it.
  if (payload === '') return { kind: 'ignored', reason: 'clear' };
  if (payload.length > (MAX_COPY_CHARS / 3) * 4 + 4)
    return { kind: 'ignored', reason: 'too-large' };
  let bytes: Uint8Array;
  try {
    const binary = atob(payload.replace(/\s+/g, ''));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return { kind: 'ignored', reason: 'malformed' };
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text === '') return { kind: 'ignored', reason: 'clear' };
  return { kind: 'write', text };
}

/** What a notice says about it: short, and enough to recognise what was copied. */
export function describeCopy(text: string): string {
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > 1) return `Copied ${lines.toLocaleString('en-US')} lines from the program`;
  const one = text.trim();
  return one.length <= 40
    ? `Copied "${one}" from the program`
    : `Copied ${one.length.toLocaleString('en-US')} characters from the program`;
}
