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
 *
 * **And the call it failed in, where the runtime says one.** A full run recorded `Error(EPERM)`
 * against a layout that did not open, and a code on its own cannot say whether that was looking
 * at a folder, making one, or starting a shell, which are three different faults. The syscall
 * name is the runtime's own word for the operation, never a path and never anything a person
 * typed, so it can be said.
 */
export function safeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    const call = (e as NodeJS.ErrnoException).syscall;
    const name = e.name || 'Error';
    if (typeof code !== 'string' || code === '') return name;
    return typeof call === 'string' && call !== ''
      ? `${name}(${code}, ${call})`
      : `${name}(${code})`;
  }
  if (typeof e === 'string') return 'string';
  if (e === null || e === undefined) return 'none';
  return typeof e;
}

/**
 * The frames of a stack, without the line that is the message.
 *
 * `Error.prototype.stack` begins with `${name}: ${message}` and only then the frames, so logging a
 * stack beside `safeError(e)` writes the very sentence `safeError` exists to drop, in the next
 * field on the same line. For a filesystem error that sentence is `ENOENT: no such file or
 * directory, open '/Users/somebody/Projects/a-client/notes.md'`.
 *
 * Both places this was reached from are uncaught exception handlers, which is exactly where
 * unexpected filesystem errors arrive, and `error` is on at every log level.
 *
 * The frames themselves are kept: they name this product's own files and the runtime's, which is
 * what anybody diagnosing a crash actually reads.
 */
export function safeStack(e: unknown): string | undefined {
  if (!(e instanceof Error) || typeof e.stack !== 'string') return undefined;
  const lines = e.stack.split('\n');
  const frames = lines.filter((l) => /^\s+at\s/.test(l));
  return frames.length > 0 ? frames.join('\n') : undefined;
}
