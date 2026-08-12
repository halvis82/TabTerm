import type { AgentState } from '@tabterm/shared';

/**
 * How long an agent took to answer.
 *
 * A turn is the unit that matters here and no command boundary can see it: the shell command is
 * the agent CLI itself and it runs for an hour, so `command-end` fires when the user quits it
 * rather than when it finished thinking. Bounded instead by the hooks that report its ends.
 *
 * Timed from the first working event of a turn, which is where a person stopped being able to do
 * anything but wait. See docs/09-agent-integration.md.
 */

export interface FinishedTurn {
  durationMs: number;
  failed: boolean;
}

/** States that mean the agent is between turns, so the next working event starts a new one. */
function isResting(state: AgentState | undefined): boolean {
  return state !== 'working' && state !== 'starting';
}

export class TurnTracker {
  readonly #startedAt = new Map<string, number>();

  /**
   * Record a state change, and report a turn if this one ended it.
   *
   * Repeated working events do not restart the clock. A turn that ran a hundred tools would
   * otherwise be measured from the last one, and report seconds for something that took an hour.
   */
  observe(
    sessionId: string,
    state: AgentState,
    previous: AgentState | undefined,
    now: number,
  ): FinishedTurn | null {
    if (state === 'working' || state === 'starting') {
      if (isResting(previous)) this.#startedAt.set(sessionId, now);
      return null;
    }

    if (state !== 'idle' && state !== 'failed') return null;

    const startedAt = this.#startedAt.get(sessionId);
    this.#startedAt.delete(sessionId);
    // No start means nothing was waited on: an agent that reports idle without having worked has
    // not finished anything, and saying it did would be a notification about nothing.
    if (startedAt === undefined) return null;
    return { durationMs: now - startedAt, failed: state === 'failed' };
  }

  forget(sessionId: string): void {
    this.#startedAt.delete(sessionId);
  }
}
