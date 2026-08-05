import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './config.js';
import { warn } from './log.js';

/**
 * Small durable stores, written atomically.
 *
 * Interim: `docs/03-data-model.md` specifies SQLite with indices for history search, and this
 * will move there. JSON is honest for the volumes involved now (thousands of rows, capped) and
 * adds no native dependency, which matters because every native module has to be staged
 * alongside the daemon and carries its own install surprises.
 *
 * Writes go to a temp file and rename into place, so a crash mid-write leaves the previous
 * file intact rather than a truncated one.
 */
export class JsonStore<T> {
  readonly #file: string;
  readonly #fallback: T;
  #cache: T | null = null;
  #writeTimer: NodeJS.Timeout | null = null;

  constructor(name: string, fallback: T) {
    this.#file = join(paths.state, `${name}.json`);
    this.#fallback = fallback;
  }

  read(): T {
    if (this.#cache !== null) return this.#cache;
    try {
      this.#cache = JSON.parse(readFileSync(this.#file, 'utf8')) as T;
    } catch {
      this.#cache = structuredClone(this.#fallback);
    }
    return this.#cache;
  }

  update(fn: (current: T) => T): T {
    const next = fn(this.read());
    this.#cache = next;
    this.#scheduleWrite();
    return next;
  }

  /**
   * Coalesce writes. A busy shell reports a new directory on every prompt, and rewriting the
   * file each time would be pointless IO on the hot path.
   */
  #scheduleWrite(): void {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.flush();
    }, 400);
  }

  flush(): void {
    if (this.#cache === null) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#cache), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (e) {
      warn('store.write.failed', { file: this.#file, error: String(e) });
    }
  }
}
