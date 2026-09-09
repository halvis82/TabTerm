/**
 * Types for the one script a test imports.
 *
 * `generate-char-width.mjs` is plain JavaScript because it runs by hand and by itself, with no
 * build step between writing it and running it. The staleness test recomputes the table through
 * this rather than shelling out, so a failure names the range that differs instead of an exit code.
 */
export function widthCorrections(): [first: number, last: number, width: 1 | 2][];
export function unicode11Provider(): {
  readonly version: string;
  wcwidth(codepoint: number): 0 | 1 | 2;
  charProperties(codepoint: number, preceding: number): number;
};
