/**
 * A screen as a person would read it.
 *
 * The serialized screen carries the escape sequences that produced it, so anything showing it
 * raw displays things like `[?2004h` beside a prompt, which reads as a bug in whatever is doing
 * the displaying. Empty lines are dropped, so the length of the result is how much is actually
 * on the screen.
 *
 * Its own module because both the server and the session manager need it, and the session
 * manager cannot import the server.
 */
/* eslint-disable no-control-regex -- the whole job here is matching control sequences. */
export function plainText(screen: string): string[] {
  return (
    screen
      // OSC, terminated by BEL or ST. Titles and cwd reports live here.
      .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
      /**
       * A gap the program drew by moving the cursor is a gap, not nothing.
       *
       * A full screen program lays its interface out by jumping the cursor rather than by writing
       * spaces, because it is cheaper: `ESC [ 12 C` means twelve columns to the right. Deleting
       * those along with the colours closed every one of those gaps, so a preview read
       * "Configdialogdismissed" and "bypasspermissionson", which is the noise he reported. Several
       * hundred of them in a single screen of an agent's interface, counted in his own database.
       *
       * Put back as spaces, which is what they looked like.
       */
      .replace(/\u001b\[([0-9]*)C/g, (_, count: string) =>
        ' '.repeat(Math.min(200, Number(count) || 1)),
      )
      // CSI: colors, cursor movement, and mode switches such as bracketed paste.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // The two-character escapes.
      .replace(/\u001b[@-Z\\-_]/g, '')
      .split('\n')
      // Indentation is meaning here: a transcript, a tree of output, a table all say something by
      // where they start. Only what trails off the end of a line is dropped.
      .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+$/, ''))
      .filter((line) => line.length > 0)
  );
}
/* eslint-enable no-control-regex */
