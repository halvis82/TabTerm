/**
 * Shell-quote a path for a `cd`.
 *
 * The tilde is deliberately left outside the quotes. A quoted `~` is a literal character rather
 * than your home directory, so `cd '~/Documents'` fails with "no such file or directory" for a
 * folder that is plainly there. Since almost every path typed into the folder box starts with a
 * tilde, quoting it made that box appear not to work at all.
 *
 * Everything after the tilde is quoted **only when it needs to be**, which is what the quoting is
 * for: a space, an apostrophe, or a folder named after something that would otherwise be run. A
 * path made of ordinary characters is passed through as typed, because `cd ~/'Documents/thing'`
 * for a folder with no space in it is noise, and the line it leaves in the scrollback is a line
 * nobody would have written by hand.
 */

/**
 * Characters a shell passes through untouched.
 *
 * Deliberately a list of what is safe rather than a list of what is dangerous: a character
 * nobody thought of ends up quoted, which is harmless, instead of unquoted, which is not.
 */
const PLAIN = /^[A-Za-z0-9._/+,:@%=-]+$/;

export function quotePath(path: string): string {
  const escape = (part: string): string =>
    PLAIN.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`;
  if (path === '~') return '~';
  if (path.startsWith('~/')) {
    const rest = path.slice(2);
    return rest === '' ? '~/' : `~/${escape(rest)}`;
  }
  return escape(path);
}
