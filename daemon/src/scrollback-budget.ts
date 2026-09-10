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
 * What a line of scrollback actually costs, measured in the emulator that holds it.
 *
 * The earlier number, 90, was the size of a line of output as text. That is not what a budget in
 * megabytes is trying to bound: the emulator does not keep text, it keeps a row of cells with an
 * attribute per cell, and it allocates that row whether or not anything was printed into it. So a
 * budget denominated in the text was out by roughly six times, and the setting understated what it
 * was spending by the same factor.
 *
 * Measured directly, at four widths, with a realistic mixture of short prompts and long coloured
 * build lines, heap read either side of writing ten thousand lines and the emulator disposed
 * between runs:
 *
 * | Columns | Per line |
 * | --- | --- |
 * | 80 | 504 B |
 * | 120 | 492 B |
 * | 187 | 537 B |
 * | 240 | 578 B |
 *
 * Nearly flat, because the per-row overhead dominates the cells. 520 is the middle of it, and at
 * the default budget it comes to 10,082 lines, which is what sessions were already getting from
 * the old fixed default. So the setting starts telling the truth without anybody's memory moving.
 */
const BYTES_PER_LINE = 520;

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
