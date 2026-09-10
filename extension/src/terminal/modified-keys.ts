/**
 * Telling a program which modifier was held, when it has asked to be told.
 *
 * A terminal cannot say "Shift and Return" in its own alphabet. Return is one byte, and a modifier
 * that does not change which character it is has nowhere to go, so Shift and Return arrives as a
 * plain carriage return and cannot be told apart from Return. That is why a chat-style prompt
 * inside a terminal cannot offer Shift and Return for a new line without help.
 *
 * `modifyOtherKeys` is the help. A program asks for it with `CSI > 4 ; 2 m`, and the terminal then
 * sends any key whose modifiers it could not otherwise express as `CSI 27 ; modifier ; key ~`.
 *
 * xterm.js does not implement it. It parses the request and does nothing, so a program that asked
 * goes on believing it will be told and never is. Found by reading what an agent had actually sent:
 * `CSI > 4 ; 2 m` in the session logs, and a Shift and Return that arrived as a bare carriage
 * return and was taken as "send this".
 */

/** As xterm numbers them: one, plus a bit for each modifier held. */
export function modifierCode(held: {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}): number {
  return 1 + (held.shift ? 1 : 0) + (held.alt ? 2 : 0) + (held.ctrl ? 4 : 0) + (held.meta ? 8 : 0);
}

/** The keys worth reporting this way, by the code the protocol names them with. */
const REPORTABLE: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  Escape: 27,
};

/**
 * How to send a key, or null to leave it to the terminal's ordinary handling.
 *
 * Null for an unmodified key, because a plain Return must stay a plain carriage return: it is how
 * anything is ever run. Null too when nobody has asked, since this encoding means nothing to a
 * program that did not request it and would arrive as text.
 */
export function encodeModifiedKey(
  key: string,
  held: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean },
  level: number,
): string | null {
  if (level < 1) return null;
  const code = REPORTABLE[key];
  if (code === undefined) return null;
  const modifier = modifierCode(held);
  if (modifier === 1) return null;
  return `\u001b[27;${String(modifier)};${String(code)}~`;
}

/**
 * The level a program asked for, read from the parameters of `CSI > 4 ; n m`.
 *
 * No parameter means zero, which is off, and is how a program turns it off on the way out.
 */
export function modifyOtherKeysLevel(params: readonly number[]): number | null {
  if (params[0] !== 4) return null;
  return params.length > 1 ? (params[1] ?? 0) : 0;
}
