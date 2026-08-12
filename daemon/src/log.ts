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
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  if (!file) return;
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1');
  } catch {
    /* first write, or rotation raced. Either is fine. */
  }
  try {
    appendFileSync(file, line + '\n');
  } catch {
    /* never let logging break the daemon */
  }
}

export const debug = (e: string, f?: Record<string, unknown>) => log('debug', e, f);
export const info = (e: string, f?: Record<string, unknown>) => log('info', e, f);
export const warn = (e: string, f?: Record<string, unknown>) => log('warn', e, f);
export const error = (e: string, f?: Record<string, unknown>) => log('error', e, f);

/** Exposed so the rotation rule can be tested against a temporary directory. */
export const rotateForTest = rotateLaunchdLogs;
