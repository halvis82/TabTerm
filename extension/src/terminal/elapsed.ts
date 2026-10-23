/**
 * Elapsed-time display.
 *
 * The daemon sends discrete events only: a command started, a command ended, a session
 * attached. Elapsed time is computed here from those timestamps, because streaming a ticking
 * clock over the wire would be continuous traffic to say something the receiver can work out
 * for itself. See docs/11-performance.md §6.
 */

export interface TimeState {
  sessionStartedAt?: number;
  commandStartedAt?: number;
  lastCommand?: string;
  lastDurationMs?: number;
  lastExitCode?: number;
  lastFinishedAt?: number;
  /**
   * When the turn this pane's agent is in began, which is when the person asked.
   *
   * The reason this exists at all: in a pane running an agent, the shell command is the agent CLI
   * itself and it started when the session did, so the running-command line said "running 47m"
   * about a process nobody is waiting on. The question in that pane is how long **this answer**
   * has taken, and nothing on the screen could say it.
   */
  agentTurnStartedAt?: number;
  /** What the agent is doing, so a turn that is blocked on a person says so rather than ticking. */
  agentState?: 'working' | 'waiting' | 'approval' | 'idle' | 'failed' | 'starting';
  /** How long the last turn took, so a pane says what happened after it is over. */
  lastTurnMs?: number;
  lastTurnEndedAt?: number;
}

/** Compact and stable in width, so a label does not jitter as it counts. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

export function formatAgo(at: number, now = Date.now()): string {
  const ms = now - at;
  if (ms < 2000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

/**
 * The single line a pane shows about time.
 *
 * A running command is the only thing worth watching tick, so it wins. Otherwise the most
 * recently useful fact is how the last command went. After whichever of those it says comes how
 * long the session has been alive, which is said in every state. An empty string means show
 * nothing at all rather than something vacuous.
 */
export function describeTime(state: TimeState, now = Date.now()): string {
  /**
   * How long the session has been alive, on the end of every line.
   *
   * Asked for "in addition to what is already there", so it is a second fact rather than one of
   * the alternatives below. It counts from the daemon's start for the terminal, which a reload,
   * a reattach, or a move to another tab all carry with them, so it is the session's age and never
   * the tab's. It used to be said, as "open", only when nothing else was, which is exactly when it
   * mattered least. Only once it has been alive a while: nobody needs to be told a session is four
   * seconds old.
   */
  const alive =
    state.sessionStartedAt !== undefined && now - state.sessionStartedAt > 60_000
      ? `alive ${formatDuration(now - state.sessionStartedAt)}`
      : '';
  const said = whatIsHappening(state, now);
  if (said === '') return alive;
  return alive === '' ? said : `${said} · ${alive}`;
}

function whatIsHappening(state: TimeState, now: number): string {
  /**
   * An agent in a turn is the question, when there is one.
   *
   * It comes first because in that pane every other line is about the wrong thing: the command
   * that is running is the agent CLI, which started with the session.
   *
   * A turn blocked on a person says so instead of counting. The clock is still running and the
   * number is still true, and "waiting for you" is what somebody glancing at the pane needs,
   * because the thing holding it up is them.
   */
  if (state.agentTurnStartedAt !== undefined) {
    const waited = formatDuration(now - state.agentTurnStartedAt);
    if (state.agentState === 'waiting') return `waiting for you · ${waited}`;
    if (state.agentState === 'approval') return `needs approval · ${waited}`;
    return `answering ${waited}`;
  }
  if (state.lastTurnMs !== undefined && state.lastTurnEndedAt !== undefined) {
    // What the last answer cost, which outlives the turn and is the thing worth knowing next.
    return `answered in ${formatDuration(state.lastTurnMs)} · ${formatAgo(state.lastTurnEndedAt, now)}`;
  }
  if (state.commandStartedAt !== undefined) {
    return `running ${formatDuration(now - state.commandStartedAt)}`;
  }
  if (state.lastDurationMs !== undefined && state.lastFinishedAt !== undefined) {
    const took = formatDuration(state.lastDurationMs);
    const failed = state.lastExitCode !== undefined && state.lastExitCode !== 0;
    const status = failed ? ` · exit ${String(state.lastExitCode)}` : '';
    return `took ${took}${status} · ${formatAgo(state.lastFinishedAt, now)}`;
  }
  return '';
}

/**
 * Whether a running command has gone on long enough to be worth mentioning.
 *
 * Used to decide when a completion is worth a notification. A command that took under a few
 * seconds finished before anyone looked away.
 */
export function isLongRunning(startedAt: number, thresholdMs = 30_000, now = Date.now()): boolean {
  return now - startedAt >= thresholdMs;
}
