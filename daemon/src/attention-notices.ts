/**
 * Whether an agent needing a person is worth interrupting them for, again.
 *
 * Reported as five desktop notifications in five seconds, all of them "an agent is waiting for
 * you in /Users/halvis82", from tabs where nothing was happening. Two faults behind it, and the
 * same shape in both: the daemon raised a notification for the **state** an agent was in rather
 * than for it **entering** that state.
 *
 * An agent's hooks are not a state machine anybody controls. A notification hook fires when the
 * agent wants somebody, and it can fire again, and a subagent fires its own; the daemon received
 * each one and each one became a notification. Nothing compared the event to what it already knew.
 *
 * So: entering a state is news, being in it is not, and even entering it repeatedly is not news
 * more than once in a while. A person who has been told an agent is waiting does not need telling
 * again a second later, and a notification that arrives five times is not five times as useful,
 * it is the reason people turn notifications off.
 */

/** How long a session stays quiet after it has said the same thing. */
export const QUIET_MS = 60_000;

export type Attention = 'approval' | 'waiting';

export interface Notice {
  sessionId: string;
  state: Attention;
}

export class AttentionNotices {
  /** When each session last interrupted somebody, per kind. */
  readonly #saidAt = new Map<string, number>();

  /**
   * Should this be raised?
   *
   * `previous` is what the session was doing before this event, which is what separates entering
   * a state from being reminded of it. An event that reports the state a session is already in
   * is not news at all and is dropped without touching the clock.
   */
  shouldRaise(
    sessionId: string,
    state: string,
    previous: string | undefined,
    now: number,
  ): boolean {
    if (state !== 'approval' && state !== 'waiting') return false;
    // Being told again what we already knew. Not news, and not a reason to reset anything.
    if (previous === state) return false;

    const key = `${sessionId}:${state}`;
    const last = this.#saidAt.get(key);
    /**
     * An approval is exempt from the floor.
     *
     * It blocks the agent until somebody answers it, so a second one really is a second thing
     * waiting on a person, and missing it costs more than an extra notification does. Waiting is
     * the opposite: an agent that has nothing to do will go on having nothing to do.
     */
    if (state === 'approval') {
      this.#saidAt.set(key, now);
      return true;
    }
    if (last !== undefined && now - last < QUIET_MS) return false;
    this.#saidAt.set(key, now);
    return true;
  }

  /** A session that has gone. Nothing is owed to it. */
  forget(sessionId: string): void {
    for (const key of [...this.#saidAt.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.#saidAt.delete(key);
    }
  }
}
