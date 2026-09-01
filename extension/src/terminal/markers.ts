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

  constructor(container: HTMLElement, onJump: (row: number) => void) {
    this.#rail = document.createElement('div');
    this.#rail.className = 'marker-rail';
    this.#rail.addEventListener('mousedown', (e) => {
      const pip = (e.target as HTMLElement).closest('.marker-pip');
      const row = pip ? Number((pip as HTMLElement).dataset['row']) : NaN;
      if (!Number.isFinite(row)) return;
      // A landmark is worth a little context above it, so the jump lands just before it.
      e.preventDefault();
      e.stopPropagation();
      onJump(Math.max(0, row - 2));
    });
    container.append(this.#rail);
  }

  get markers(): readonly FoundMarker[] {
    return this.#markers;
  }

  sync(term: Terminal): void {
    this.#markers = findMarkers(term);
    this.#rail.replaceChildren();
    // Hidden entirely when there is nothing to show, rather than sitting there as an empty
    // stripe beside every terminal anybody ever opens.
    this.#rail.classList.toggle('has-markers', this.#markers.length > 0);

    const length = Math.max(1, term.buffer.active.length - 1);
    for (const marker of this.#markers) {
      const pip = document.createElement('div');
      pip.className = 'marker-pip';
      pip.dataset['row'] = String(marker.row);
      pip.style.top = `${String((marker.row / length) * 100)}%`;
      pip.style.background = hex(marker.color);
      pip.title = 'Jump to this marker';
      this.#rail.append(pip);
    }
  }

  dispose(): void {
    this.#rail.remove();
  }
}
