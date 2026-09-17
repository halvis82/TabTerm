/**
 * Putting a saved screen back in front of somebody, without putting a dead program's terminal back.
 *
 * Restoring a workspace writes the screen as it was into a **new** shell, so the work is still
 * there to read. What comes with that screen is the problem: a serialized screen carries the modes
 * the program had set, and several of those modes are not about drawing at all. They are about
 * input.
 *
 * An agent's interface turns on mouse tracking, focus reporting, application cursor keys and
 * bracketed paste. Replay its screen into a fresh shell and that shell's terminal now has all four,
 * while the process on the other end never asked for any of them and does not understand the
 * answers. Every click sends `ESC [ M` and three raw bytes. Every focus change sends `ESC [ I` or
 * `ESC [ O`. Every arrow key sends `ESC O A` instead of `ESC [ A`. The person did not type any of
 * it and it arrives as if they had.
 *
 * Reported as restored sessions simply not working: a prompt typed into a resumed agent came
 * straight back as "Interrupted by user", because a stray `ESC` is that program's interrupt key.
 *
 * So the screen is history and the input state is not restored with it. Said explicitly rather than
 * by stripping sequences out of the saved bytes: what the screen looks like is the saved program's
 * business, and what the keyboard and mouse do is the new one's.
 */

/**
 * Every input mode a restored screen could have left armed, turned off, plus a visible cursor.
 *
 * Written after the screen and before the notice, so the notice is drawn in the state the new shell
 * will actually run in. The shell turns back on whatever it wants for itself, which is the point:
 * these now belong to the program that is running rather than to one that is not.
 */
export const INPUT_STATE_OF_A_NEW_SHELL = [
  '[?1l', // cursor keys send the ordinary sequences again
  '[?66l', // and so does the keypad
  '[?9l', // no mouse reporting, in any of the four protocols
  '[?1000l',
  '[?1002l',
  '[?1003l',
  '[?1005l', // and none of the encodings that go with them
  '[?1006l',
  '[?1015l',
  '[?1004l', // no focus reporting
  '[?2004l', // and no bracketed paste, until the shell asks for it itself
  '[?25h', // and a cursor somebody can see, since the program that hid it is gone
].join('');
