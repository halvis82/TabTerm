import { WIDTH_CORRECTIONS } from './char-width-data.js';

/**
 * How wide a character is, kept the same on both copies of a session's screen.
 *
 * The daemon and the page each run a terminal emulator over the same bytes, and reattach is exact
 * only while the two agree cell for cell. A width table is part of that agreement, so it cannot be
 * something one side picks up and the other does not. See docs/07-terminal-fidelity.md.
 *
 * The table also has to match the programs being hosted. An agent draws a table by padding each
 * cell to a column count it works out itself, using a current width table, and a terminal that
 * disagrees puts that padding in the wrong place. That is not hypothetical: every row of an
 * agent's box drawing holding U+2705 came out one column short, because xterm's built-in table is
 * from Unicode 6 and calls it one column wide. Unicode 9 made it two.
 */

/** The shape xterm asks of a width table, without needing xterm to say so. */
export interface UnicodeWidthProvider {
  readonly version: string;
  wcwidth(codepoint: number): 0 | 1 | 2;
  charProperties(codepoint: number, preceding: number): number;
}

/** An xterm addon, of which only the one call that hands over its provider is used. */
export interface UnicodeWidthAddon {
  activate(terminal: unknown): void;
}

/** A terminal that can be told which width table to use. */
export interface UnicodeCapableTerminal {
  readonly unicode: {
    register(provider: UnicodeWidthProvider): void;
    activeVersion: string;
  };
}

/**
 * The version this provider announces.
 *
 * Deliberately not '11'. The corrections carry the addon's table past what it knows, so calling it
 * 11 would name it after data it no longer only contains.
 */
export const CURRENT_UNICODE_VERSION = '16';

/**
 * The width for a codepoint the 2018 table gets wrong, or undefined where it is already right.
 *
 * Binary search over 42 ranges. Width is read once per codepoint on the output path, so this is
 * measured rather than assumed: 5M lookups in 37.6 ms, which is 0.075 ms to width a full 200x50
 * screen. Small enough that correctness decided this and speed did not.
 */
export function correctedWidth(codepoint: number): 1 | 2 | undefined {
  let low = 0;
  let high = WIDTH_CORRECTIONS.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = WIDTH_CORRECTIONS[mid];
    if (range === undefined) break;
    if (codepoint < range[0]) high = mid - 1;
    else if (codepoint > range[1]) low = mid + 1;
    else return range[2];
  }
  return undefined;
}

/**
 * Take the provider out of an addon without attaching it to a terminal.
 *
 * `activate` wants a terminal only to reach `unicode.register`, so a stub carrying that one method
 * yields the provider. Borrowing the addon's table this way rather than copying it keeps one
 * source for the zero-width and base-width data, which is the part nobody should be hand-writing.
 */
export function providerFrom(addon: UnicodeWidthAddon): UnicodeWidthProvider {
  let captured: UnicodeWidthProvider | null = null;
  addon.activate({ unicode: { register: (p: UnicodeWidthProvider) => (captured = p) } });
  if (captured === null) throw new Error('unicode addon registered no provider');
  return captured;
}

/**
 * Every width this table has been asked for, by codepoint, so it is worked out once.
 *
 * Width is read for **every character of output**, on both sides, and working it out means a
 * lookup in the addon's ranges and then a binary search through the corrections. Measured on the
 * daemon's own output path: sixteen megabytes cost 700 ms of processor with the table installed
 * and 228 ms without it, so two thirds of what it costs to keep a server-side screen was this
 * question being asked again for characters it had already answered for.
 *
 * A byte per codepoint across the basic plane is 64 KB, once for the whole process rather than
 * once per terminal, which is why it is keyed by version: two providers announcing the same
 * version are the same static table, and the corrections above are a module constant. Anything
 * beyond the basic plane is rare enough to sit in a map.
 */
const NOT_YET = 0xff;
const BMP = 0x10000;
const widthTables = new Map<string, { bmp: Uint8Array; astral: Map<number, 0 | 1 | 2> }>();

function tableFor(version: string): { bmp: Uint8Array; astral: Map<number, 0 | 1 | 2> } {
  let table = widthTables.get(version);
  if (!table) {
    table = { bmp: new Uint8Array(BMP).fill(NOT_YET), astral: new Map() };
    widthTables.set(version, table);
  }
  return table;
}

/** The addon's table, corrected to the current one. */
export function currentWidths(base: UnicodeWidthProvider): UnicodeWidthProvider {
  const table = tableFor(base.version);
  const work = (codepoint: number): 0 | 1 | 2 => {
    const width = base.wcwidth(codepoint);
    // Zero width means combining or control, which is not a width question and stays the
    // addon's answer. Nothing here can make a character appear or vanish.
    if (width === 0) return 0;
    return correctedWidth(codepoint) ?? width;
  };
  const provider: UnicodeWidthProvider = {
    version: CURRENT_UNICODE_VERSION,
    wcwidth(codepoint: number): 0 | 1 | 2 {
      if (codepoint >= 0 && codepoint < BMP) {
        const seen = table.bmp[codepoint];
        if (seen !== NOT_YET) return seen as 0 | 1 | 2;
        const width = work(codepoint);
        table.bmp[codepoint] = width;
        return width;
      }
      const seen = table.astral.get(codepoint);
      if (seen !== undefined) return seen;
      const width = work(codepoint);
      table.astral.set(codepoint, width);
      return width;
    },
    charProperties(codepoint: number, preceding: number): number {
      /*
       * Called with this provider as `this` on purpose.
       *
       * The packed value it returns is built out of `this.wcwidth`, and the constructor for it is
       * internal to xterm, so there is nothing to reimplement against. Rebinding is what carries
       * the corrections into the value the renderer actually reads. If a later addon stops
       * deriving it that way, the rendered-width checks in char-width.test.ts fail rather than the
       * corrections quietly going nowhere.
       */
      return base.charProperties.call(provider, codepoint, preceding);
    },
  };
  return provider;
}

/**
 * Give a terminal the current width table.
 *
 * Both the page and the daemon call exactly this, which is the point: a width table only one of
 * them believes in would put the two copies of the screen out of step.
 */
export function installCurrentWidths(term: UnicodeCapableTerminal, addon: UnicodeWidthAddon): void {
  term.unicode.register(currentWidths(providerFrom(addon)));
  term.unicode.activeVersion = CURRENT_UNICODE_VERSION;
}
