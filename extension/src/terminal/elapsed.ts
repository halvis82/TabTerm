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
 * recently useful fact is how the last command went, and failing that, how long the session
 * has been open. An empty string means show nothing at all rather than something vacuous.
 */
export function describeTime(state: TimeState, now = Date.now()): string {
  if (state.commandStartedAt !== undefined) {
    return `running ${formatDuration(now - state.commandStartedAt)}`;
  }
  if (state.lastDurationMs !== undefined && state.lastFinishedAt !== undefined) {
    const took = formatDuration(state.lastDurationMs);
    const failed = state.lastExitCode !== undefined && state.lastExitCode !== 0;
    const status = failed ? ` · exit ${String(state.lastExitCode)}` : '';
    return `took ${took}${status} · ${formatAgo(state.lastFinishedAt, now)}`;
  }
  if (state.sessionStartedAt !== undefined) {
    const open = now - state.sessionStartedAt;
    // Nobody needs to be told a session is four seconds old.
    if (open > 60_000) return `open ${formatDuration(open)}`;
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
