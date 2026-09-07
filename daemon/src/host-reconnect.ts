/**
 * Which sessions are actually gone when the connection to the PTY host comes back.
 *
 * The socket to the host is reconnected after any close at all, and an error handler closes it,
 * so a reconnect is not evidence that anything died. This used to end **every** session on the
 * reasoning that a reconnect means a new host and a new host means the old one's processes are
 * gone. The second half is true. The first half is not, and one `ECONNRESET` would have ended
 * every terminal on the machine while every one of their processes was still running.
 *
 * The host knows what it has, so it is asked, and the answer decides. Nothing here guesses.
 */

export interface ReconnectVerdict {
  /** Sessions whose process is gone. Their tabs get the expiry page, which is the truth. */
  lost: string[];
  /** Sessions the host still holds. Kept, and their missed output replayed. */
  kept: string[];
}

/**
 * `stillOnHost` is what the host reported, or `null` when it could not be asked.
 *
 * The unaskable case keeps everything, deliberately. Ending a session cannot be undone and
 * keeping one costs a terminal that answers nothing until the next reconnect, seconds away.
 * Nothing is lost by waiting and everything can be by not.
 */
export function decideReconnect(
  held: readonly string[],
  stillOnHost: readonly string[] | null,
): ReconnectVerdict {
  if (stillOnHost === null) return { lost: [], kept: [...held] };
  const alive = new Set(stillOnHost);
  return {
    lost: held.filter((id) => !alive.has(id)),
    kept: held.filter((id) => alive.has(id)),
  };
}
