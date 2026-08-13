import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * A session's output, on disk.
 *
 * The in-memory ring is what redraws a screen after the daemon restarts. This is what survives
 * the host restarting, the machine rebooting, and the crash nobody planned for. They are fed
 * from the same stream and answer different questions: "what did this look like a moment ago"
 * and "what happened here at all".
 *
 * Deliberately dumb. Append the bytes, keep the file under budget, delete on clear. Anything
 * cleverer here would be a database in the process whose entire value is that it never changes.
 *
 * Owner-readable only, and pruned by age, because this is the most revealing thing the product
 * keeps: it is literally everything a terminal printed. See docs/07-terminal-fidelity.md.
 */

export interface ScrollbackStoreOptions {
  directory: string;
  /** Bytes kept per session, from the user's setting. */
  budgetBytes: number;
}

/** Compaction rewrites the file, so it happens at a multiple of the budget rather than at it. */
const COMPACT_AT = 2;

/** Files untouched for this long are somebody's history from a machine that has moved on. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export class ScrollbackStore {
  #directory: string;
  #budget: number;
  /** Bytes written since the last compaction, per session, to avoid a stat on every write. */
  readonly #written = new Map<string, number>();

  constructor(opts: ScrollbackStoreOptions) {
    this.#directory = opts.directory;
    this.#budget = Math.max(1, opts.budgetBytes);
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    } catch {
      // A store that cannot be created must not stop terminals from working. History is a
      // feature; running a shell is the product.
    }
  }

  setBudget(bytes: number): void {
    this.#budget = Math.max(1, bytes);
  }

  #path(sessionId: string): string {
    // Session ids are generated, but this is a filename, so anything unexpected is refused
    // rather than trusted.
    const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
    return join(this.#directory, `${safe}.log`);
  }

  append(sessionId: string, data: Uint8Array): void {
    if (data.length === 0) return;
    const path = this.#path(sessionId);
    try {
      if (!existsSync(path)) {
        closeSync(openSync(path, 'a', 0o600));
      }
      appendFileSync(path, data);
      const written = (this.#written.get(sessionId) ?? 0) + data.length;
      this.#written.set(sessionId, written);
      if (written > this.#budget * COMPACT_AT) this.#compact(sessionId);
    } catch {
      // A full disk, or a directory somebody removed. Losing history is not a reason to lose
      // the terminal, so this is silent by design.
    }
  }

  /**
   * Keep the newest budget worth and drop the rest.
   *
   * Rewritten through a temporary file and renamed, so a crash midway leaves either the old
   * history or the new one, never half of either.
   */
  #compact(sessionId: string): void {
    const path = this.#path(sessionId);
    try {
      const stats = statSync(path);
      if (stats.size <= this.#budget) {
        this.#written.set(sessionId, 0);
        return;
      }
      const whole = readFileSync(path);
      const kept = whole.subarray(whole.length - this.#budget);
      const temporary = `${path}.compacting`;
      writeFileSync(temporary, kept, { mode: 0o600 });
      renameSync(temporary, path);
      this.#written.set(sessionId, 0);
    } catch {
      // Leave the file as it is. Oversized history is better than lost history.
    }
  }

  /** Everything kept for a session, oldest first, or empty if there is nothing. */
  read(sessionId: string): Uint8Array {
    try {
      const path = this.#path(sessionId);
      if (!existsSync(path)) return new Uint8Array(0);
      const whole = readFileSync(path);
      return whole.length > this.#budget ? whole.subarray(whole.length - this.#budget) : whole;
    } catch {
      return new Uint8Array(0);
    }
  }

  /** Clear has to reach here too, or the output comes back the next time anything reads it. */
  clear(sessionId: string): void {
    try {
      const path = this.#path(sessionId);
      if (existsSync(path)) unlinkSync(path);
      this.#written.delete(sessionId);
    } catch {
      /* nothing to do about it, and nothing worth breaking over */
    }
  }

  /**
   * Drop history for sessions nobody has touched in a month.
   *
   * Keeping everything forever is how a state directory quietly becomes gigabytes of somebody's
   * terminal output, which is the last thing this should be.
   */
  prune(now = Date.now(), olderThanMs = PRUNE_AFTER_MS): number {
    let removed = 0;
    try {
      for (const name of readdirSync(this.#directory)) {
        if (!name.endsWith('.log')) continue;
        const path = join(this.#directory, name);
        try {
          if (now - statSync(path).mtimeMs > olderThanMs) {
            unlinkSync(path);
            removed++;
          }
        } catch {
          /* a file that vanished under us is already pruned */
        }
      }
    } catch {
      /* no directory, nothing to prune */
    }
    return removed;
  }

  /** Total bytes held, for diagnostics and for a settings pane that can say what it costs. */
  usage(): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    try {
      for (const name of readdirSync(this.#directory)) {
        if (!name.endsWith('.log')) continue;
        try {
          bytes += statSync(join(this.#directory, name)).size;
          files++;
        } catch {
          /* raced with a delete */
        }
      }
    } catch {
      /* no directory yet */
    }
    return { files, bytes };
  }
}
