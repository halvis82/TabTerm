import type { AgentState } from '@tabterm/shared';

/**
 * How long an agent took to answer.
 *
 * A turn is the unit that matters here and no command boundary can see it: the shell command is
 * the agent CLI itself and it runs for an hour, so `command-end` fires when the user quits it
 * rather than when it finished thinking. Bounded instead by the hooks that report its ends.
 *
 * **Timed from the prompt**, because that is what the sentence it produces claims. "An agent
 * finished, took four minutes" is read as four minutes since the person asked, so anything else
 * measured under that wording is wrong however defensible the other number is.
 *
 * It used to be timed from the first working event of a turn, on the reasoning that a turn should
 * not include the time a person spent thinking. That reasoning is not wrong, but it does not match
 * the sentence, and the way it went wrong in practice was worse than the philosophy: **any turn
 * that asked a question restarted the clock.** `Notification` is a rest, so the `PreToolUse` after
 * a permission prompt looked exactly like the start of a new turn, and an hour of work reported as
 * the forty seconds since the last approval. A turn that never asked anything reported correctly,
 * which is why it survived.
 *
 * See docs/09-agent-integration.md.
 */

export interface FinishedTurn {
  durationMs: number;
  failed: boolean;
}

/**
 * The hook that begins a turn, and the only one.
 *
 * A turn starts when a person submits a prompt. Every other working event continues one, including
 * the one that follows a permission prompt, which is the case that used to be indistinguishable
 * from a beginning.
 */
const TURN_START_HOOK = 'UserPromptSubmit';

/** States the agent is resting in, which is where a prompt may begin a turn. */
function isResting(state: AgentState | undefined): boolean {
  return state !== 'working' && state !== 'starting';
}

export class TurnTracker {
  readonly #startedAt = new Map<string, number>();

  /**
   * Record a state change, and report a turn if this one ended it.
   *
   * `hook` is the event's own name rather than the state it mapped to, because the two are not
   * the same question. `UserPromptSubmit` and `PreToolUse` both mean the agent is working, and
   * only one of them means a turn began. Optional, so an older caller still compiles, and without
   * it nothing starts a turn rather than the wrong thing starting one.
   */
  observe(
    sessionId: string,
    state: AgentState,
    previous: AgentState | undefined,
    now: number,
    hook?: string,
  ): FinishedTurn | null {
    if (state === 'working' || state === 'starting') {
      /*
       * A prompt starts the clock, and only while the agent is resting.
       *
       * The guard is for a prompt queued while the agent is already working, which an agent lets
       * you do. Both prompts are answered in the one turn the person is waiting through, so the
       * turn is measured from the first of them: the second is not a moment anybody started
       * waiting at.
       */
      if (hook === TURN_START_HOOK && isResting(previous)) this.#startedAt.set(sessionId, now);
      return null;
    }

    if (state !== 'idle' && state !== 'failed') return null;

    const startedAt = this.#startedAt.get(sessionId);
    this.#startedAt.delete(sessionId);
    /*
     * No start means no prompt was seen, so there is no honest number to report.
     *
     * It happens for real: a daemon restarted mid-turn, or the hooks installed while an agent was
     * already running. Saying nothing is the right answer. The alternative is a duration measured
     * from whatever this daemon happened to see first, which is exactly the class of wrong number
     * this file exists to stop.
     */
    if (startedAt === undefined) return null;
    return { durationMs: now - startedAt, failed: state === 'failed' };
  }

  forget(sessionId: string): void {
    this.#startedAt.delete(sessionId);
  }
}
