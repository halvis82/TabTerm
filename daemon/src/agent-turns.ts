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

/**
 * Whether what somebody typed abandons the answer they were waiting for.
 *
 * A turn is bounded by hooks, and an agent that is interrupted by the person does not report one:
 * `Stop` is fired when a response finishes, not when somebody stops it. So the prompt that follows
 * an interrupt arrives while the agent still looks like it is working, and it was read as a second
 * prompt queued onto the turn already in progress. The label then went on counting from the
 * question that had been abandoned, which is the report this exists for: "it doesn't register if a
 * user interrupts and sends a new prompt. the timer is just kept going."
 *
 * Escape is what interrupts these agents, and Ctrl+C is the older way to stop anything. Neither is
 * proof on its own, which is why the shape matters: an arrow key is an escape followed by `[` or
 * `O`, and a paste can carry anything. What is looked for is an escape that is not the start of a
 * sequence.
 *
 * Being wrong here is cheap and only in one direction: a turn that restarts when it should not
 * under-reports a wait by the time between the two prompts. A turn that never restarts reports a
 * wait that is not happening, which is the one people notice.
 */
export function looksLikeInterrupt(text: string): boolean {
  if (text.includes('\u0003')) return true;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\u001b') continue;
    const next = text[i + 1];
    // A bare escape, or one that does not open a control sequence, is somebody pressing Escape.
    if (next === undefined || (next !== '[' && next !== 'O')) return true;
  }
  return false;
}

/** States the agent is resting in, which is where a prompt may begin a turn. */
function isResting(state: AgentState | undefined): boolean {
  return state !== 'working' && state !== 'starting';
}

export class TurnTracker {
  readonly #startedAt = new Map<string, number>();
  /**
   * Sessions whose answer was abandoned by the person, so the next prompt is a fresh wait.
   *
   * Needed because the agent's own state does not change when it is interrupted: it is still
   * reported as working, so the guard that stops a queued prompt restarting the clock would stop
   * this one too. Cleared by the prompt it lets through.
   */
  readonly #interrupted = new Set<string>();

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
      if (
        hook === TURN_START_HOOK &&
        (isResting(previous) || this.#interrupted.delete(sessionId))
      ) {
        this.#startedAt.set(sessionId, now);
      }
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

  /**
   * When the turn a session is in began, or undefined when it is not in one.
   *
   * Sent to the page so a pane can say how long somebody has been waiting, counted up there from
   * one timestamp rather than streamed. The alternative is the number this replaces: a terminal
   * that said how long the agent CLI itself had been running, which is how long ago the session
   * was opened and is never the question.
   */
  startedAt(sessionId: string): number | undefined {
    return this.#startedAt.get(sessionId);
  }

  /**
   * The person stopped waiting for this answer.
   *
   * The clock stops rather than being left to run, and the next prompt is allowed to start a new
   * one even though the agent has not said it is resting, because it never will: nothing reports
   * an interrupt.
   */
  interrupt(sessionId: string): void {
    this.#startedAt.delete(sessionId);
    this.#interrupted.add(sessionId);
  }

  forget(sessionId: string): void {
    this.#startedAt.delete(sessionId);
    this.#interrupted.delete(sessionId);
  }
}
