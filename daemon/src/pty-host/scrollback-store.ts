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

/** Enough waiting to be worth a syscall. Small enough that memory stays flat under any program. */
const FLUSH_AT_BYTES = 64 * 1024;

/** And the longest a quiet session's last line waits to be on disk. */
const FLUSH_AFTER_MS = 10;

export class ScrollbackStore {
  #directory: string;
  #budget: number;
  /** Sessions whose file has been made, so its mode is only ever set once. */
  readonly #created = new Set<string>();
  /** Bytes written since the last compaction, per session, to avoid a stat on every write. */
  readonly #written = new Map<string, number>();
  /**
   * Output waiting to be written, per session, so a burst costs one write rather than dozens.
   *
   * `appendFileSync` on every chunk is a syscall per chunk in the process that holds every
   * terminal, and the process is single threaded: measured, sixteen megabytes arriving in four
   * kilobyte chunks cost 429 ms of wall clock against 119 ms of processor, so three hundred
   * milliseconds of it was this process blocked in `write` with every other terminal's keystrokes
   * waiting behind it.
   *
   * Batched, the same sixteen megabytes is a few hundred writes instead of four thousand. What is
   * given up is a few milliseconds of durability on a history file: a host killed outright loses
   * the last flush window of scrollback, which is the one thing here that is explicitly a feature
   * rather than the product. Everything that reads, clears, prunes or measures flushes first, so
   * nothing can ever observe the difference.
   */
  readonly #pending = new Map<string, Uint8Array[]>();
  #pendingBytes = 0;
  #flushTimer: NodeJS.Timeout | undefined;

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
    const held = this.#pending.get(sessionId);
    if (held) held.push(data);
    else this.#pending.set(sessionId, [data]);
    this.#pendingBytes += data.length;

    /*
     * Written when there is enough to be worth a syscall, or when the moment has passed.
     *
     * The size bound is what keeps memory flat under a program printing continuously; the timer
     * is what gets a quiet session's last line onto disk. Neither is a delay anybody can see:
     * reading this back flushes first.
     */
    if (this.#pendingBytes >= FLUSH_AT_BYTES) {
      this.flush();
      return;
    }
    if (this.#flushTimer === undefined) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = undefined;
        this.flush();
      }, FLUSH_AFTER_MS);
      this.#flushTimer.unref?.();
    }
  }

  /**
   * Put everything waiting on disk, for one session or for all of them.
   *
   * Called before anything reads, clears, prunes or measures, and on the way out. A caller that
   * forgets would see a file missing its newest bytes, which is why no caller has to remember:
   * every method that touches a file goes through here first.
   */
  flush(sessionId?: string): void {
    if (this.#pending.size === 0) return;
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    const ids = sessionId === undefined ? [...this.#pending.keys()] : [sessionId];
    for (const id of ids) {
      const held = this.#pending.get(id);
      if (!held || held.length === 0) {
        this.#pending.delete(id);
        continue;
      }
      this.#pending.delete(id);
      const bytes = held.reduce((n, part) => n + part.length, 0);
      this.#pendingBytes = Math.max(0, this.#pendingBytes - bytes);
      const path = this.#path(id);
      try {
        /**
         * Asked once per session, not once per chunk.
         *
         * `appendFileSync` creates the file itself, so the check was only ever about the mode bits
         * on the first write. Asking the filesystem on every chunk cost a syscall per chunk on the
         * process that holds every terminal: measured, a fifth of the cost of the write beside it.
         */
        if (!this.#created.has(id)) {
          if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
          this.#created.add(id);
        }
        // One write for the lot. `concat` copies once, which is cheaper than a syscall each.
        appendFileSync(path, held.length === 1 ? (held[0] as Uint8Array) : Buffer.concat(held));
        const written = (this.#written.get(id) ?? 0) + bytes;
        this.#written.set(id, written);
        if (written > this.#budget * COMPACT_AT) this.#compact(id);
      } catch {
        // A full disk, or a directory somebody removed. Losing history is not a reason to lose
        // the terminal, so this is silent by design.
      }
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
    this.flush(sessionId);
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
    // Dropped rather than flushed: writing bytes to a file that is about to be removed, and
    // recreating it on the way past, is how a cleared session comes back.
    const held = this.#pending.get(sessionId);
    if (held) {
      this.#pendingBytes = Math.max(0, this.#pendingBytes - held.reduce((n, p) => n + p.length, 0));
      this.#pending.delete(sessionId);
    }
    try {
      const path = this.#path(sessionId);
      if (existsSync(path)) unlinkSync(path);
      this.#written.delete(sessionId);
      // The file is gone, so the next write has to make it again with the right mode.
      this.#created.delete(sessionId);
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
    this.flush();
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
    this.flush();
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
