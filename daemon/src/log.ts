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
