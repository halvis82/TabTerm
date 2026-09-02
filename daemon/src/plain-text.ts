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
      // CSI: colors, cursor movement, and mode switches such as bracketed paste.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // The two-character escapes.
      .replace(/\u001b[@-Z\\-_]/g, '')
      .split('\n')
      .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+$/, ''))
      .filter((line) => line.length > 0)
  );
}
/* eslint-enable no-control-regex */
