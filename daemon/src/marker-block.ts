import { cleanLabelColor, cleanPaneLabel } from '@tabterm/shared';

/**
 * A landmark somebody can find again by eye.
 *
 * Written into the session's **output**, never to the PTY. That distinction is the whole design:
 * output is what the terminal has already printed, so a landmark behaves like the rest of the
 * scrollback. It scrolls with the work it marks, and it survives a reload and a daemon restart
 * because it sits in the ring and on disk with everything else.
 *
 * The alternative, sending `echo` to the shell, would put a command in somebody's history, run
 * in whatever program happens to be in the foreground, and be impossible while a command is
 * already running.
 */

/** Bounded, so a landmark stays a landmark rather than becoming a page of screen. */
const BAR_LINES = 3;
const DEFAULT_COLOR = '#7aa2f7';
const ESC = String.fromCharCode(27);

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Black or white, whichever can actually be read on this background.
 *
 * Perceived brightness rather than a plain average, because green looks far lighter than blue at
 * the same numeric value and a label in the wrong ink is unreadable.
 */
function readableInk(hex: string): string {
  const [r, g, b] = rgb(hex);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 140 ? ESC + '[38;2;20;20;20m' : ESC + '[38;2;250;250;250m';
}

/**
 * The bytes for one landmark.
 *
 * A solid full-width bar, which is what makes it findable by eye at any scroll position. The
 * padding is written concealed (SGR 8): the cells look exactly the same, since they are spaces
 * on a colored background, and the attribute is what tells a landmark apart from any other
 * full-width colored row. "No ordinary output paints every cell of a line the same color" was
 * the earlier assumption, and an agent's input box does precisely that: Claude Code draws its
 * prompt as a full-width gray row, and the page painted it as a landmark. The attribute survives
 * a reload and a daemon restart, because the serializer carries it with the colors.
 */
export function markerBlock(opts: { label: string; color?: string; cols: number }): string {
  const color = cleanLabelColor(opts.color) ?? DEFAULT_COLOR;
  const [r, g, b] = rgb(color);
  /**
   * One column short of the terminal, deliberately.
   *
   * A line written to the last column wraps on its own, so the newline after it produced a
   * second, blank line: a three line landmark arrived as six, and each bar was read as a
   * separate landmark.
   */
  const width = Math.max(20, Math.min(400, Math.floor(opts.cols) - 1));
  const background = ESC + '[48;2;' + String(r) + ';' + String(g) + ';' + String(b) + 'm';
  const reset = ESC + '[0m';
  const conceal = ESC + '[8m';
  const reveal = ESC + '[28m';

  const label = cleanPaneLabel(opts.label);
  const middle = label === '' ? '' : ' ' + label + ' ';
  const left = Math.max(0, Math.floor((width - middle.length) / 2));
  const shown = middle.slice(0, Math.max(0, width - left));
  const right = Math.max(0, width - left - shown.length);

  const blank = background + conceal + ' '.repeat(width) + reset + '\r\n';
  // The label itself is revealed, between concealed padding on either side of it.
  const middleLine =
    background +
    readableInk(color) +
    conceal +
    ' '.repeat(left) +
    (shown === '' ? '' : reveal + shown + conceal) +
    ' '.repeat(right) +
    reset +
    '\r\n';

  // A newline first, so a landmark never lands halfway along a line still being written.
  const above = Math.floor((BAR_LINES - 1) / 2);
  const below = BAR_LINES - 1 - above;
  return '\r\n' + blank.repeat(above) + middleLine + blank.repeat(below);
}
