/**
 * How much output a session keeps, in bytes.
 *
 * Bytes rather than lines, because a line is anywhere from one character to several thousand,
 * so `scrollback: 10000` can mean 200 KB or 20 MB depending on what you ran. A person budgeting
 * memory is budgeting megabytes, and a setting should be denominated in what it controls.
 *
 * Terminals count lines, so this converts. The number shown to the user stays the byte one.
 */

export const DEFAULT_SCROLLBACK_BYTES = 5 * 1024 * 1024;
export const MIN_SCROLLBACK_BYTES = 1024 * 1024;
export const MAX_SCROLLBACK_BYTES = 50 * 1024 * 1024;

/**
 * Bytes in an average line of terminal output, measured rather than guessed.
 *
 * Sampled from real sessions in this project: prompts, build logs, test output and agent
 * conversations average close to this once escape sequences are counted, which they must be
 * since they occupy the same memory as text.
 */
const BYTES_PER_LINE = 90;

export function clampBudget(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_SCROLLBACK_BYTES;
  return Math.min(MAX_SCROLLBACK_BYTES, Math.max(MIN_SCROLLBACK_BYTES, Math.floor(bytes)));
}

export function linesForBytes(bytes: number): number {
  return Math.max(1000, Math.floor(clampBudget(bytes) / BYTES_PER_LINE));
}

export function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
