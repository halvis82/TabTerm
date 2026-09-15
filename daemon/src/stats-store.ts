import type { CommandTally } from '@tabterm/shared';
import type { Database } from './database.js';

/**
 * What a terminal has actually done, kept where the terminal is.
 *
 * Every figure on the Stats page used to be counted in the page that was showing it. Refreshing
 * the tab reset all of them, and a session hours old reported that it had been open for four
 * seconds, run nothing, and answered nothing. The numbers were not wrong about the page. They were
 * about the wrong thing: a tab is a view of a session and the session is what did the work.
 *
 * So the daemon keeps them, and writes them down. It already sees every command boundary and every
 * agent turn, it outlives every tab, and it is the only thing that survives a reload.
 *
 * Two shapes, because two different questions are being asked:
 *
 * - **Per session**, so a pane can say what it has done since it started
 * - **Per day**, so "today" and "this week" are answerable without keeping an event per command.
 *   A row per day is bounded by the calendar rather than by use, which is the only bound that does
 *   not need pruning to be correct
 *
 * Nothing here holds a command, a directory or any text. Those already live in `commands`, under
 * the rules that table has about what may be remembered. This is counters.
 */

export interface SessionStats {
  sessionId: string;
  startedAt: number;
  commandsRun: number;
  commandsFailed: number;
  /** Time spent inside commands, which is not the age of the session. */
  commandMs: number;
  /** Prompts answered, which no command boundary can see. See `agent-turns.ts`. */
  turns: number;
  /** Time between a prompt and its answer, summed. */
  turnMs: number;
}

export interface DayStats {
  day: string;
  commandsRun: number;
  commandsFailed: number;
  commandMs: number;
  turns: number;
  turnMs: number;
  sessionsOpened: number;
}

/** A day in local time, because "today" is a question about the person rather than about UTC. */
export function dayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How many days back a window covers, counted in local days including today. */
export function daysBack(days: number, now = Date.now()): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) out.push(dayKey(now - i * 86_400_000));
  return out;
}

export class StatsStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** A session begins. Written once, so its age is the session's rather than a tab's. */
  sessionStarted(sessionId: string, startedAt: number): void {
    this.#db.handle
      .prepare(
        `INSERT INTO session_stats (session_id, started_at)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
      )
      .run(sessionId, startedAt);
    this.#bumpDay(startedAt, { sessionsOpened: 1 });
  }

  /** A command finished. `exitCode` absent counts as run and not as failed. See ADR-0016. */
  commandFinished(sessionId: string, durationMs: number, exitCode?: number): void {
    const failed = exitCode !== undefined && exitCode !== 0 ? 1 : 0;
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
    this.#db.handle
      .prepare(
        `UPDATE session_stats
            SET commands_run = commands_run + 1,
                commands_failed = commands_failed + ?,
                command_ms = command_ms + ?
          WHERE session_id = ?`,
      )
      .run(failed, ms, sessionId);
    this.#bumpDay(Date.now(), { commandsRun: 1, commandsFailed: failed, commandMs: ms });
  }

  /** An agent answered. The unit no command boundary can see. */
  turnFinished(sessionId: string, durationMs: number): void {
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
    this.#db.handle
      .prepare(
        `UPDATE session_stats
            SET turns = turns + 1, turn_ms = turn_ms + ?
          WHERE session_id = ?`,
      )
      .run(ms, sessionId);
    this.#bumpDay(Date.now(), { turns: 1, turnMs: ms });
  }

  /** What one session has done, or nothing when it began before any of this existed. */
  forSession(sessionId: string): SessionStats | null {
    const row = this.#db.handle
      .prepare(
        `SELECT session_id, started_at, commands_run, commands_failed, command_ms, turns, turn_ms
           FROM session_stats WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, number | string> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row['session_id']),
      startedAt: Number(row['started_at']),
      commandsRun: Number(row['commands_run']),
      commandsFailed: Number(row['commands_failed']),
      commandMs: Number(row['command_ms']),
      turns: Number(row['turns']),
      turnMs: Number(row['turn_ms']),
    };
  }

  /** Every day in the window, summed. Absent days are zeroes rather than gaps. */
  overDays(days: readonly string[]): DayStats {
    if (days.length === 0) return this.#emptyDay('');
    const marks = days.map(() => '?').join(',');
    const row = this.#db.handle
      .prepare(
        `SELECT COALESCE(SUM(commands_run), 0)    AS commands_run,
                COALESCE(SUM(commands_failed), 0) AS commands_failed,
                COALESCE(SUM(command_ms), 0)      AS command_ms,
                COALESCE(SUM(turns), 0)           AS turns,
                COALESCE(SUM(turn_ms), 0)         AS turn_ms,
                COALESCE(SUM(sessions_opened), 0) AS sessions_opened
           FROM day_stats WHERE day IN (${marks})`,
      )
      .get(...days) as Record<string, number> | undefined;
    return {
      day: days[0] ?? '',
      commandsRun: Number(row?.['commands_run'] ?? 0),
      commandsFailed: Number(row?.['commands_failed'] ?? 0),
      commandMs: Number(row?.['command_ms'] ?? 0),
      turns: Number(row?.['turns'] ?? 0),
      turnMs: Number(row?.['turn_ms'] ?? 0),
      sessionsOpened: Number(row?.['sessions_opened'] ?? 0),
    };
  }

  /**
   * Days older than this are dropped, because a counter nobody will ever ask about is a row.
   *
   * Generous: a year is 365 rows, which is nothing, and somebody asking "how much did I run in
   * March" is a reasonable question to be able to answer later.
   */
  prune(keepDays = 365, now = Date.now()): void {
    const oldest = dayKey(now - keepDays * 86_400_000);
    this.#db.handle.prepare('DELETE FROM day_stats WHERE day < ?').run(oldest);
  }

  /**
   * The two lists that are about habits rather than about counters.
   *
   * Read from the history table, which already decides what may be remembered: a command typed
   * with a leading space or one that looks like a secret never reaches it, so neither reaches
   * here. That is why these live beside the counters rather than being counted separately.
   */
  topCommands(limit = 8): CommandTally[] {
    return this.#tallies(
      `SELECT command, use_count, exit_code, last_used_at FROM commands
        ORDER BY use_count DESC, last_used_at DESC LIMIT ?`,
      limit,
    );
  }

  /** What has ended badly, most recent first, which is the order somebody looking for it wants. */
  failures(limit = 6): CommandTally[] {
    return this.#tallies(
      `SELECT command, use_count, exit_code, last_used_at FROM commands
        WHERE exit_code IS NOT NULL AND exit_code != 0
        ORDER BY last_used_at DESC LIMIT ?`,
      limit,
    );
  }

  /** Where the work happens, by how much has been run there. */
  topPlaces(limit = 6): { cwd: string; count: number }[] {
    return (
      this.#db.handle
        .prepare(
          `SELECT cwd, SUM(use_count) AS n FROM commands GROUP BY cwd ORDER BY n DESC LIMIT ?`,
        )
        .all(limit) as { cwd: string; n: number }[]
    ).map((r) => ({ cwd: r.cwd, count: Number(r.n) }));
  }

  #tallies(sql: string, limit: number): CommandTally[] {
    return (
      this.#db.handle.prepare(sql).all(limit) as {
        command: string;
        use_count: number;
        exit_code: number | null;
        last_used_at: number;
      }[]
    ).map((r) => ({
      command: r.command,
      count: Number(r.use_count),
      ...(r.exit_code === null ? {} : { exitCode: Number(r.exit_code) }),
      lastUsedAt: Number(r.last_used_at),
    }));
  }

  #emptyDay(day: string): DayStats {
    return {
      day,
      commandsRun: 0,
      commandsFailed: 0,
      commandMs: 0,
      turns: 0,
      turnMs: 0,
      sessionsOpened: 0,
    };
  }

  #bumpDay(at: number, by: Partial<Omit<DayStats, 'day'>>): void {
    this.#db.handle
      .prepare(
        `INSERT INTO day_stats (day, commands_run, commands_failed, command_ms, turns, turn_ms, sessions_opened)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           commands_run    = commands_run + excluded.commands_run,
           commands_failed = commands_failed + excluded.commands_failed,
           command_ms      = command_ms + excluded.command_ms,
           turns           = turns + excluded.turns,
           turn_ms         = turn_ms + excluded.turn_ms,
           sessions_opened = sessions_opened + excluded.sessions_opened`,
      )
      .run(
        dayKey(at),
        by.commandsRun ?? 0,
        by.commandsFailed ?? 0,
        by.commandMs ?? 0,
        by.turns ?? 0,
        by.turnMs ?? 0,
        by.sessionsOpened ?? 0,
      );
  }
}
