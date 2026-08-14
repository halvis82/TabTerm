/**
 * Shell-quote a path for a `cd`.
 *
 * The tilde is deliberately left outside the quotes. A quoted `~` is a literal character rather
 * than your home directory, so `cd '~/Documents'` fails with "no such file or directory" for a
 * folder that is plainly there. Since almost every path typed into the folder box starts with a
 * tilde, quoting it made that box appear not to work at all.
 *
 * Everything after the tilde is still quoted, which is what the quoting is for: a space, an
 * apostrophe, or a folder named after something that would otherwise be run.
 */
export function quotePath(path: string): string {
  const escape = (part: string): string => `'${part.replaceAll("'", `'\\''`)}'`;
  if (path === '~') return '~';
  if (path.startsWith('~/')) {
    const rest = path.slice(2);
    return rest === '' ? '~/' : `~/${escape(rest)}`;
  }
  return escape(path);
}
