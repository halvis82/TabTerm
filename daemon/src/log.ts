import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_BYTES = 4 * 1024 * 1024;

let threshold: Level = 'info';
let file: string | null = null;

export function initLog(level: Level): void {
  threshold = level;
  /**
   * Whatever is waiting goes to disk before the process does.
   *
   * `exit` runs for a clean stop and for an uncaught throw, and only synchronous work is allowed
   * in it, which is exactly what this is. A signal that kills outright still loses the current
   * turn, which is why nothing that explains a crash is ever buffered.
   */
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', flushLog);
  }
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  file = join(paths.logs, 'daemon.log');
  rotateLaunchdLogs();
}

/**
 * Rotate the files launchd owns.
 *
 * `daemon.log` is ours and rotates itself on every write. `stdout.log` and `stderr.log` are
 * opened by launchd from the plist, appended to forever, and never touched by this process
 * otherwise. Nothing bounds them.
 *
 * That is not a slow leak, it is a fast one under exactly the conditions where logs matter: a
 * daemon that cannot start gets restarted, writes the same failure again, and repeats. Six MB
 * of one identical line accumulated that way before it was noticed. Rotating at startup keeps
 * one generation, which is the one anybody debugging a restart actually wants.
 */
function rotateLaunchdLogs(directory: string = paths.logs): void {
  for (const name of ['stdout.log', 'stderr.log']) {
    const path = join(directory, name);
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      /* absent, or rotated by a concurrent start. Both are fine. */
    }
  }
}

/**
 * Logs never contain command text, environment values, or terminal output.
 * See docs/05-security.md §9.
 */
/**
 * Lines waiting to be written, and the turn they will be written at the end of.
 *
 * Every line used to cost two blocking syscalls on the event loop that is also pumping terminal
 * output: a `stat` to decide about rotation and an `appendFileSync`. Measured on this machine,
 * five thousand lines took 122 ms written one at a time and 9 ms written in batches, and the
 * `stat` was another 14 percent on top. During the resize storm that was measured, that is eight
 * thousand lines in a minute, all of it blocking.
 *
 * The trade is stated rather than hidden: a process killed outright loses the lines from the turn
 * it was killed in. Which is why **`warn` and `error` are never buffered**. Those are the lines
 * somebody reads after a crash, they are rare, and they keep going straight to disk.
 */
let exitHooked = false;
let pending: string[] = [];
let pendingBytes = 0;
let flushScheduled = false;

/**
 * Asked once per write, which is once per turn rather than once per line.
 *
 * The size is asked for rather than remembered because the PTY host writes to this same file, so
 * a count of our own writes drifts and the file would outgrow its limit by however much the other
 * process had added. One syscall per batch is cheap; one per line was the problem.
 */
function rotateIfFull(): void {
  if (!file) return;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // no file yet, so nothing to rotate
  }
  if (size <= MAX_BYTES) return;
  try {
    renameSync(file, file + '.1');
  } catch {
    /* rotation raced with the other process writing here. Either copy is fine. */
  }
}

/** Write everything waiting, as one call. Safe to call at any time, including twice. */
export function flushLog(): void {
  if (pending.length === 0 || !file) {
    pending = [];
    pendingBytes = 0;
    return;
  }
  const text = pending.join('');
  pending = [];
  pendingBytes = 0;
  rotateIfFull();
  try {
    appendFileSync(file, text);
  } catch {
    /* never let logging break the daemon */
  }
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }) + '\n';
  if (level === 'error' || level === 'warn') console.error(line.trimEnd());
  if (!file) return;

  if (level === 'error' || level === 'warn') {
    /**
     * Written now, and after whatever is already waiting, so the file stays in order.
     *
     * A line that explains a crash is worth a syscall. There are very few of them.
     */
    pending.push(line);
    pendingBytes += Buffer.byteLength(line);
    flushLog();
    return;
  }

  pending.push(line);
  pendingBytes += Buffer.byteLength(line);
  // A burst inside one turn must not grow without limit, so a large enough batch goes early.
  if (pendingBytes >= 256 * 1024) {
    flushLog();
    return;
  }
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      flushLog();
    });
  }
}

export const debug = (e: string, f?: Record<string, unknown>) => log('debug', e, f);
export const info = (e: string, f?: Record<string, unknown>) => log('info', e, f);
export const warn = (e: string, f?: Record<string, unknown>) => log('warn', e, f);
export const error = (e: string, f?: Record<string, unknown>) => log('error', e, f);

/** Exposed so the rotation rule can be tested against a temporary directory. */
export const rotateForTest = rotateLaunchdLogs;
