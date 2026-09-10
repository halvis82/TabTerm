/**
 * What an error may say in a diagnostic log.
 *
 * `String(e)` on a filesystem error is `Error: ENOENT: no such file or directory, open
 * '/Users/somebody/Projects/their-client/notes.md'`. The useful half of that is `ENOENT`. The other
 * half is where a person keeps their work, written to a file that outlives the failure and is
 * attached to bug reports.
 *
 * This is the reason the field-name audit could not see the problem: the field is called `error`,
 * which is as innocuous a name as exists, and the path is in the value. So the value is built here
 * instead, from the parts that cannot name anything: the error's kind and its code.
 *
 * The message is dropped rather than filtered. Deciding whether a particular message contains a
 * path means guessing at every library's wording, and the codes are what anybody diagnosing this
 * actually reads.
 */
export function safeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    const name = e.name || 'Error';
    return typeof code === 'string' && code !== '' ? `${name}(${code})` : name;
  }
  if (typeof e === 'string') return 'string';
  if (e === null || e === undefined) return 'none';
  return typeof e;
}
