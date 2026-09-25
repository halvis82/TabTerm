/**
 * What this session has actually done.
 *
 * Built from the command-start and command-end events the page already receives, so it costs
 * nothing extra to collect and reflects what the daemon observed rather than what the screen
 * happens to show. See docs/14-command-menu.md.
 */

export interface CommandRecord {
  command: string;
  startedAt: number;
  durationMs?: number;
  exitCode?: number;
}

/** What an agent has been asked and how long the answers took, per session. */
export interface TurnSummary {
  /** Turns that finished. A turn in flight is counted when it ends, never before. */
  count: number;
  totalMs: number;
  longestMs: number;
  lastMs: number | null;
  lastEndedAt: number | null;
}

export interface SessionSummary {
  total: number;
  failed: number;
  running: number;
  totalMs: number;
  medianMs: number;
  longest: CommandRecord | null;
  startedAt: number;
}

/** Kept bounded: a session that runs for days should not accumulate without limit. */
const MAX_RECORDS = 500;

export class SessionStats {
  readonly #records: CommandRecord[] = [];
  readonly #open = new Map<string, CommandRecord>();
  readonly #startedAt = Date.now();
  /**
   * Finished turns, which no command boundary can see.
   *
   * A pane running an agent is one long command, so everything counted below says the same thing
   * about it all day: one command, still running. What actually happened in that pane is a number
   * of answers and how long each took, and the daemon is the only thing that can bound them.
   */
  #turns: { totalMs: number; longestMs: number; lastMs: number; lastEndedAt: number } | null = null;
  #turnCount = 0;

  /** Record a turn the daemon has said is over. Never called for one still in flight. */
  turnFinished(durationMs: number, endedAt = Date.now()): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.#turnCount += 1;
    this.#turns = {
      totalMs: (this.#turns?.totalMs ?? 0) + durationMs,
      longestMs: Math.max(this.#turns?.longestMs ?? 0, durationMs),
      lastMs: durationMs,
      lastEndedAt: endedAt,
    };
  }

  turns(): TurnSummary {
    return {
      count: this.#turnCount,
      totalMs: this.#turns?.totalMs ?? 0,
      longestMs: this.#turns?.longestMs ?? 0,
      lastMs: this.#turns?.lastMs ?? null,
      lastEndedAt: this.#turns?.lastEndedAt ?? null,
    };
  }

  begin(key: string, command: string, startedAt: number): void {
    const record: CommandRecord = { command, startedAt };
    this.#open.set(key, record);
    this.#records.push(record);
    if (this.#records.length > MAX_RECORDS) this.#records.shift();
  }

  /**
   * Close the most recent open command for a session.
   *
   * Matched by key rather than by command text, because the same command run twice is two
   * different things and matching on text would attribute the second run's timing to the first.
   */
  end(key: string, durationMs: number, exitCode?: number): void {
    const record = this.#open.get(key);
    this.#open.delete(key);
    if (!record) return;
    record.durationMs = durationMs;
    if (exitCode !== undefined) record.exitCode = exitCode;
  }

  get records(): readonly CommandRecord[] {
    // Newest first, which is the order anyone reads a log of what just happened.
    return [...this.#records].reverse();
  }

  summarize(): SessionSummary {
    const finished = this.#records.filter((r) => r.durationMs !== undefined);
    const durations = finished
      .map((r) => r.durationMs ?? 0)
      .slice()
      .sort((a, b) => a - b);

    return {
      total: this.#records.length,
      failed: finished.filter((r) => (r.exitCode ?? 0) !== 0).length,
      running: this.#open.size,
      totalMs: durations.reduce((sum, ms) => sum + ms, 0),
      // Median rather than mean: one `npm install` should not describe a session of quick
      // commands, and that is exactly what an average would do.
      medianMs: durations.length ? (durations[Math.floor(durations.length / 2)] as number) : 0,
      longest:
        finished.reduce<CommandRecord | null>(
          (best, r) => (!best || (r.durationMs ?? 0) > (best.durationMs ?? 0) ? r : best),
          null,
        ) ?? null,
      startedAt: this.#startedAt,
    };
  }
}

/**
 * A duration in the shortest form that is still honest about its magnitude.
 *
 * It stopped at minutes, so a week of waiting on agents read as `3720m 12s`, which is a number
 * nobody can hold: it takes arithmetic to learn it is two and a half days. Two units, always, and
 * the larger one chosen so the first number is something a person can picture.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return 'running';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

/** A wall-clock time, because "when" is half of what a statistics list is for. */
export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
