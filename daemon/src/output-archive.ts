import type { Database } from './database.js';
import { isSensitive } from './launcher-data.js';
import { debug, info } from './log.js';

/**
 * Archiving command output.
 *
 * **Off by default**, and the default is the important part. This stores what commands printed,
 * which is the single most sensitive thing the product touches: tokens echoed by a script,
 * contents of a file someone `cat`ed, an API response. Nobody should be opted into that.
 *
 * Only **OSC 133-delimited command output** is captured — the region between "a command
 * started" and "it finished". Everything outside that boundary is dropped, which is what makes
 * this bounded rather than a transcript of a terminal.
 *
 * **Alt-screen periods are skipped entirely.** Vim, less, htop and every other full-screen
 * program redraw constantly, so archiving them would capture megabytes of screen repaints that
 * mean nothing once the program has exited. See docs/03-data-model.md.
 */

/** Per command. A build log is worth keeping; a 200 MB one is not. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Alt-screen enter and leave, the only two sequences this needs to recognise.
 *
 * The escape character is exactly what is being matched here, so the rule against control
 * characters in a pattern does not apply.
 */
/* eslint-disable no-control-regex */
const ALT_ENTER = /\u001b\[\?(?:1049|47|1047)h/;
const ALT_LEAVE = /\u001b\[\?(?:1049|47|1047)l/;
/* eslint-enable no-control-regex */

export interface ArchivedOutput {
  id: number;
  sessionId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  bytes: number;
  output: string;
}

/**
 * Capture state for one session.
 *
 * Not started until a command starts, and discarded when one ends, so an idle shell costs one
 * object with nothing in it.
 */
interface Capture {
  command: string;
  cwd: string;
  startedAt: number;
  chunks: string[];
  bytes: number;
  /** True while a full-screen program owns the terminal. */
  inAltScreen: boolean;
  /** Set when the cap was hit, so the record can say so rather than silently truncating. */
  truncated: boolean;
}

export class OutputArchive {
  readonly #db: Database;
  readonly #captures = new Map<string, Capture>();
  #enabled = false;

  constructor(db: Database, enabled = false) {
    this.#db = db;
    this.#enabled = enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    // Anything mid-capture when it is turned off is dropped rather than written. Turning this
    // off has to mean the output stops being recorded, including output already buffered.
    if (!enabled) this.#captures.clear();
    info('archive.enabled', { enabled });
  }

  /** A command started. Begin capturing until it ends. */
  begin(sessionId: string, command: string, cwd: string): void {
    if (!this.#enabled) return;
    // Never archive output from a command that should not have been recorded at all. The same
    // rule history uses, applied to something far more revealing than the command line.
    if (isSensitive(command)) {
      this.#captures.delete(sessionId);
      return;
    }
    this.#captures.set(sessionId, {
      command,
      cwd,
      startedAt: Date.now(),
      chunks: [],
      bytes: 0,
      inAltScreen: false,
      truncated: false,
    });
  }

  /**
   * Feed output for a session.
   *
   * Cheap when nothing is being captured, which is almost always: one map lookup that misses.
   */
  write(sessionId: string, data: string): void {
    const capture = this.#captures.get(sessionId);
    if (!capture) return;

    // Alt-screen transitions can arrive inside the same chunk as real output, so the chunk is
    // split at the boundary rather than classified as a whole.
    let rest = data;
    for (;;) {
      if (capture.inAltScreen) {
        const leave = ALT_LEAVE.exec(rest);
        if (!leave) return; // still full-screen; nothing here is worth keeping
        capture.inAltScreen = false;
        rest = rest.slice(leave.index + leave[0].length);
        continue;
      }
      const enter = ALT_ENTER.exec(rest);
      if (!enter) {
        this.#append(capture, rest);
        return;
      }
      this.#append(capture, rest.slice(0, enter.index));
      capture.inAltScreen = true;
      rest = rest.slice(enter.index + enter[0].length);
    }
  }

  #append(capture: Capture, text: string): void {
    if (!text) return;
    const room = MAX_OUTPUT_BYTES - capture.bytes;
    if (room <= 0) {
      capture.truncated = true;
      return;
    }
    const slice = text.length > room ? text.slice(0, room) : text;
    capture.chunks.push(slice);
    capture.bytes += slice.length;
    if (slice.length < text.length) capture.truncated = true;
  }

  /** A command ended. Write the record, or discard it if there was nothing worth keeping. */
  end(sessionId: string, exitCode: number): void {
    const capture = this.#captures.get(sessionId);
    this.#captures.delete(sessionId);
    if (!capture || !this.#enabled) return;

    const output = capture.chunks.join('');
    // A command that printed nothing has nothing to archive. The command itself is already in
    // history; a row here would only add disk.
    if (output.trim().length === 0) return;

    this.#db.handle
      .prepare(
        `INSERT INTO command_output (session_id, command, cwd, exit_code, started_at, bytes, truncated, output)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        capture.command,
        capture.cwd,
        exitCode,
        capture.startedAt,
        capture.bytes,
        capture.truncated ? 1 : 0,
        capture.truncated
          ? `${output}\n[output truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`
          : output,
      );
    debug('archive.stored', { bytes: capture.bytes, truncated: capture.truncated });
  }

  /** Abandon a capture, for a session that went away mid-command. */
  abandon(sessionId: string): void {
    this.#captures.delete(sessionId);
  }

  /**
   * Search archived output.
   *
   * Substring, in SQL, against an indexed command column where one is given. Full-text search
   * would be the obvious next step and is not here yet: this is a bounded archive of recent
   * command output, not a log store.
   */
  search(options: { query?: string; command?: string; limit?: number }): ArchivedOutput[] {
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.query) {
      clauses.push('output LIKE ?');
      params.push(`%${options.query.replaceAll('%', '').replaceAll('_', '')}%`);
    }
    if (options.command) {
      clauses.push('command LIKE ?');
      params.push(`%${options.command.replaceAll('%', '').replaceAll('_', '')}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.#db.handle
      .prepare(
        `SELECT id, session_id, command, cwd, exit_code, started_at, bytes, output
         FROM command_output ${where}
         -- id breaks a tie: several commands can finish inside the same millisecond, and
         -- without this they come back in whatever order SQLite chose.
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as {
      id: number;
      session_id: string;
      command: string;
      cwd: string;
      exit_code: number | null;
      started_at: number;
      bytes: number;
      output: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      command: r.command,
      cwd: r.cwd,
      exitCode: r.exit_code,
      startedAt: r.started_at,
      bytes: r.bytes,
      output: r.output,
    }));
  }

  /** Total bytes held, so growth can be reported rather than discovered. */
  usage(): { rows: number; bytes: number } {
    const row = this.#db.handle
      .prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM command_output')
      .get() as { rows: number; bytes: number };
    return { rows: row.rows, bytes: row.bytes };
  }

  /**
   * Enforce retention.
   *
   * Both an age limit and a total size limit, because either alone fails: a quiet week keeps
   * nothing under a size cap, and one noisy afternoon blows past any age cap.
   */
  prune(options: { olderThanMs: number; maxTotalBytes: number }): void {
    this.#db.handle
      .prepare('DELETE FROM command_output WHERE started_at < ?')
      .run(Date.now() - options.olderThanMs);

    let { bytes } = this.usage();
    while (bytes > options.maxTotalBytes) {
      const oldest = this.#db.handle
        .prepare('SELECT id, bytes FROM command_output ORDER BY started_at ASC, id ASC LIMIT 20')
        .all() as { id: number; bytes: number }[];
      if (oldest.length === 0) break;
      for (const row of oldest) {
        this.#db.handle.prepare('DELETE FROM command_output WHERE id = ?').run(row.id);
        bytes -= row.bytes;
        if (bytes <= options.maxTotalBytes) break;
      }
    }
  }

  clear(): void {
    this.#db.handle.prepare('DELETE FROM command_output').run();
    this.#captures.clear();
    info('archive.cleared', {});
  }
}
