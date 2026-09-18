import type { Terminal } from '@xterm/xterm';

/**
 * Finding the landmarks somebody left in the scrollback.
 *
 * A landmark is a solid full-width bar in the output, so it is detected by what it looks like
 * rather than by a hidden sentinel: no ordinary output paints every cell of a line the same
 * explicit color. That means a landmark is found again after a reload, a reattach, or a daemon
 * restart without anything having to remember where it was, and it stops being found the moment
 * its lines fall off the end of the scrollback, which is exactly when it stops being reachable.
 *
 * Two cells per line, not every cell. A full scan of a large scrollback would be a per-line loop
 * over hundreds of columns for a result nobody is waiting on.
 */

export interface FoundMarker {
  /** Absolute buffer line, which is what a decoration and a scroll both need. */
  row: number;
  /** The bar's color, as 24-bit RGB, so the marker beside the scrollbar can match it. */
  color: number;
}

/** A bar has to be at least this wide to be one, so a short colored run is not mistaken for it. */
const MIN_WIDTH = 16;

/**
 * The color of the bar on this line, if it is one.
 *
 * Sampled near the start rather than at the last column. A bar is printed at the width the
 * session had when it was printed, so a terminal that has since been widened leaves the far
 * columns untouched, and requiring the last cell to match missed every landmark printed before
 * a resize.
 */
function barColor(term: Terminal, row: number): number | null {
  const line = term.buffer.active.getLine(row);
  if (!line || term.cols < MIN_WIDTH) return null;

  const first = line.getCell(0);
  const inside = line.getCell(MIN_WIDTH - 1);
  if (!first || !inside) return null;
  // Explicit 24-bit at both samples. A palette or default background is ordinary output.
  if (!first.isBgRGB() || !inside.isBgRGB()) return null;
  const color = first.getBgColor();
  return color === inside.getBgColor() ? color : null;
}

/**
 * Every landmark in the buffer, one entry per landmark rather than per line.
 *
 * A landmark is several lines tall, and one marker beside the scrollbar per line would be three
 * markers for one place. Consecutive bars of the same color are the same landmark.
 */
export function findMarkers(term: Terminal): FoundMarker[] {
  const found: FoundMarker[] = [];
  let previous: number | null = null;

  for (let row = 0; row < term.buffer.active.length; row++) {
    const color = barColor(term, row);
    if (color !== null && color !== previous) found.push({ row, color });
    previous = color;
  }
  return found;
}

/** Where a click at a fraction down the ruler lands, given the buffer it represents. */
export function rowForRulerFraction(fraction: number, bufferLength: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.min(bufferLength - 1, Math.max(0, Math.round(clamped * (bufferLength - 1))));
}

/** The landmark nearest a row, so a click near a marker goes to it rather than beside it. */
/**
 * Where to scroll so a marked line is readable, rather than jammed against the top edge.
 *
 * A jump used to put the marked line two rows from the top, which is enough for a shell: the mark
 * is on the command line and the command is what you came for.
 *
 * It is not enough for a pane running an agent. The mark is made when Return is pressed, and an
 * agent's cursor at that moment sits inside its input box at the bottom of the screen, several rows
 * **below** the line the prompt itself ends up on. Landing the mark at the top therefore scrolled
 * the prompt off it, and the one thing the mark was for was the one thing not on screen. Reported
 * as: click the markers and "i no longer see the prompts in view because we'd be too far down".
 *
 * A third of the screen, so the context above a mark scales with the pane rather than being a
 * number that suits one window size. Two rows is the floor, for a pane too short to have thirds.
 */
export function landingRowFor(row: number, viewportRows: number): number {
  const context = Math.max(2, Math.floor(viewportRows / 3));
  return Math.max(0, row - context);
}

export function nearestMarker(markers: readonly FoundMarker[], row: number): FoundMarker | null {
  let best: FoundMarker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const distance = Math.abs(marker.row - row);
    if (distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }
  return best;
}

function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * A rail of landmarks beside the scrollbar.
 *
 * Drawn here rather than with xterm's own overview ruler, which is painted **on top of the
 * native scrollbar**. Chrome handles a scrollbar click itself and dispatches no DOM event, so
 * markers there could be seen and never clicked. This sits just inside the scrollbar, so it is
 * clickable without taking the scrollbar away.
 */
export class MarkerRail {
  readonly #rail: HTMLElement;
  #markers: FoundMarker[] = [];
  /**
   * How tall the pane is, as of the last time the rail was built.
   *
   * Kept because the click handler needs it and is bound once, at construction, while the terminal
   * it belongs to is resized constantly. A sensible starting value rather than zero, so a click
   * that somehow precedes the first sync still lands somewhere reasonable.
   */
  #viewportRows = 24;

  constructor(container: HTMLElement, onJump: (row: number) => void) {
    this.#rail = document.createElement('div');
    this.#rail.className = 'marker-rail';
    this.#rail.addEventListener('mousedown', (e) => {
      const pip = (e.target as HTMLElement).closest('.marker-pip');
      const row = pip ? Number((pip as HTMLElement).dataset['row']) : NaN;
      if (!Number.isFinite(row)) return;
      // A landmark is worth context above it, and how much depends on the pane. See `landingRowFor`.
      e.preventDefault();
      e.stopPropagation();
      onJump(landingRowFor(row, this.#viewportRows));
    });
    container.append(this.#rail);
  }

  get markers(): readonly FoundMarker[] {
    return this.#markers;
  }

  /**
   * `extra` is the highlights, which are found by the layer that owns them rather than by
   * looking at the buffer. They share the rail because "somewhere I marked" is one idea, and
   * having to look in two places for it would be two features where there should be one.
   */
  /**
   * `inputs` are lines somebody pressed Return on, which is a different kind of thing.
   *
   * A landmark and a highlight are places somebody deliberately marked, and they share the rail
   * because "somewhere I marked" is one idea. Every command typed is not that: it is automatic,
   * there are hundreds of them, and putting them in the same list would make the rail a stripe
   * and make "how many marks are there" a question with a useless answer. So they are drawn on
   * the same rail in their own lane and counted separately.
   */
  sync(
    term: Terminal,
    extra: readonly FoundMarker[] = [],
    inputs: readonly FoundMarker[] = [],
  ): void {
    this.#viewportRows = term.rows;
    this.#markers = [...findMarkers(term), ...extra].sort((a, b) => a.row - b.row);
    this.#rail.replaceChildren();
    // Hidden entirely when there is nothing to show, rather than sitting there as an empty
    // stripe beside every terminal anybody ever opens.
    this.#rail.classList.toggle('has-markers', this.#markers.length > 0);

    /*
     * The scroll area, not the last row.
     *
     * A row is placed at its own fraction of the buffer, which is the same mapping the native
     * scrollbar uses for its thumb: xterm's scroll area is one row tall per buffer line, so a pip
     * at `row / length` sits exactly where the top of the thumb is when that row is the first one
     * in view. Against `length - 1` it was a row short of that, and the rail is only worth having
     * if pressing where it points goes where it says.
     */
    const length = Math.max(1, term.buffer.active.length);
    for (const marker of this.#markers) {
      const pip = document.createElement('div');
      pip.className = 'marker-pip';
      pip.dataset['row'] = String(marker.row);
      pip.style.top = `${String((marker.row / length) * 100)}%`;
      pip.style.background = hex(marker.color);
      pip.title = 'Jump to this marker';
      this.#rail.append(pip);
    }

    /*
     * Input in its own lane, so the rail says which is which at a glance.
     *
     * Thinner and to one side: what somebody is looking for on this rail is a landmark, and the
     * input marks are context for where they are rather than a competing set of targets.
     */
    for (const mark of inputs) {
      const pip = document.createElement('div');
      pip.className = 'input-pip';
      pip.dataset['row'] = String(mark.row);
      pip.style.top = `${String((mark.row / length) * 100)}%`;
      pip.title = 'Something was typed here';
      this.#rail.append(pip);
    }
    if (inputs.length > 0) this.#rail.classList.add('has-markers');
  }

  dispose(): void {
    this.#rail.remove();
  }
}
