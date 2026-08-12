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

/** A duration in the shortest form that is still honest about its magnitude. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return 'running';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)}m ${String(seconds)}s`;
}

/** A wall-clock time, because "when" is half of what a statistics list is for. */
export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
