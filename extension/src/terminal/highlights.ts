import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import { anchor, highlightStyle, locate, type Highlight } from './highlight-anchor.js';
import { addOrToggle, connected, rangeAt, type Range } from './highlight-ranges.js';

/**
 * Highlights drawn over a session's output.
 *
 * A highlight is a background behind text somebody picked out by hand, so they can find it again
 * later. It is drawn as an xterm decoration on the `bottom` layer, which puts it behind the
 * characters rather than over them, and it appears on the same rail as the landmarks, because
 * "somewhere I marked" is one idea and deserves one place to look.
 *
 * Nothing is written into the session. A landmark is printed output and survives on its own; a
 * highlight cannot be, because the text it covers was printed long ago and cannot be repainted
 * at the source.
 *
 * **A live highlight is held by an xterm marker**, which is tied to one buffer line and moves
 * with it as output arrives. That is what keeps it exactly where it was put. The first version
 * recomputed the position from the text on every redraw, so a highlight on a shell prompt
 * reappeared on every later prompt and jumped to any later copy of the same text. Recomputing
 * was never going to work: a terminal repeats itself constantly, and text is not an identity.
 *
 * The text is still recorded, but only as the durable half, for finding the line again after a
 * reload when there is no marker left. See `highlight-anchor.ts`.
 */

const KEY = 'tabterm.highlights';

/**
 * How many sessions' highlights to keep.
 *
 * A session that has ended is never coming back, and nothing tells this page when one ends while
 * the tab is closed. Without a bound the record would grow by one dead key per session forever.
 * Oldest written goes first, which is the closest thing to least recently used that storage with
 * no timestamps can offer.
 */
const MAX_SESSIONS = 50;

const isHighlight = (v: unknown): v is Highlight => {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h['text'] === 'string' &&
    typeof h['occurrence'] === 'number' &&
    typeof h['color'] === 'string'
  );
};

export async function loadHighlights(sessionId: string): Promise<Highlight[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const all = stored[KEY] as Record<string, unknown> | undefined;
    const mine = all?.[sessionId];
    return Array.isArray(mine) ? mine.filter(isHighlight) : [];
  } catch {
    return [];
  }
}

export async function saveHighlights(
  sessionId: string,
  highlights: readonly Highlight[],
): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const all = (stored[KEY] as Record<string, unknown> | undefined) ?? {};
    if (highlights.length === 0) {
      // Removed rather than stored empty, or the record grows one dead key per session forever.
      delete all[sessionId];
    } else {
      // Deleted first so a session that is written again moves to the end rather than staying
      // where it was, which is what makes the trim below drop the least recent.
      delete all[sessionId];
      all[sessionId] = highlights;
    }
    const keys = Object.keys(all);
    for (const dead of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete all[dead];
    await chrome.storage.local.set({ [KEY]: all });
  } catch {
    // Not being able to remember a highlight is worth less than the terminal still working.
  }
}

/** Every line of the buffer as text, which is what an anchor is matched against. */
export function bufferLines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return lines;
}

/**
 * The lines a selection covers, one piece per line, with the column each piece starts at.
 *
 * Taken from the buffer rather than from the selection string, because `getSelection()` returns
 * text with no idea which column it came from, and a highlight has to be drawn where the text is.
 */
export function selectionPieces(term: Terminal): { row: number; col: number; text: string }[] {
  const range = term.getSelectionPosition();
  if (!range) return [];
  const pieces: { row: number; col: number; text: string }[] = [];
  for (let row = range.start.y; row <= range.end.y; row++) {
    const line = term.buffer.active.getLine(row);
    if (!line) continue;
    const from = row === range.start.y ? range.start.x : 0;
    const to = row === range.end.y ? range.end.x : line.length;
    const raw = line.translateToString(false, from, to);

    /**
     * Clipped to characters that were actually printed.
     *
     * A terminal line is a fixed grid, so a drag to the right edge selects the blank cells past
     * the end of the text as readily as the text itself. Highlighting those drew a colored band
     * over nothing, and the empty stretch after a prompt could be "highlighted" to no visible
     * effect at all. The blanks at both ends are removed and the column moved to match.
     */
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text === '') continue;
    pieces.push({ row, col: from + lead, text });
  }
  return pieces;
}

/** A highlight held in place by a marker on its own line. One merged range, never a layer. */
interface Pinned {
  highlight: Highlight;
  marker: IMarker;
  range: Range;
  decoration: IDecoration | null;
}

export class HighlightLayer {
  #pinned: Pinned[] = [];
  readonly #term: Terminal;
  readonly #onChange: (highlights: readonly Highlight[]) => void;

  constructor(term: Terminal, onChange: (highlights: readonly Highlight[]) => void) {
    this.#term = term;
    this.#onChange = onChange;
  }

  get highlights(): readonly Highlight[] {
    // A marker is disposed when its line falls off the end of the scrollback, which is exactly
    // when the highlight stops being reachable. Those are dropped rather than remembered.
    return this.#live().map((p) => p.highlight);
  }

  #live(): Pinned[] {
    return this.#pinned.filter((p) => !p.marker.isDisposed);
  }

  /** What is highlighted, by buffer row, which is what the range operations work on. */
  #byRow(): Map<number, Range[]> {
    const rows = new Map<number, Range[]>();
    for (const p of this.#live()) {
      const list = rows.get(p.marker.line) ?? [];
      list.push(p.range);
      rows.set(p.marker.line, list);
    }
    return rows;
  }

  /**
   * Pin one range to the buffer line it is on.
   *
   * The marker is the identity from here on. It moves with its line as the scrollback grows and
   * is disposed with it, so the highlight can neither drift onto later output nor be recomputed
   * onto a later copy of the same text.
   */
  #pin(row: number, range: Range, color: string): Pinned | null {
    const buffer = this.#term.buffer.active;
    const marker = this.#term.registerMarker(row - (buffer.baseY + buffer.cursorY));
    if (!marker) return null;
    const text = (buffer.getLine(row)?.translateToString(true) ?? '').slice(range.start, range.end);
    const lines = bufferLines(this.#term);
    const occurrence = Math.max(0, anchor(lines, row, range.start, text));
    return { highlight: { text, occurrence, color }, marker, range, decoration: null };
  }

  /** Restored from storage, without announcing a change nobody made. */
  restore(highlights: readonly Highlight[]): void {
    const lines = bufferLines(this.#term);
    for (const highlight of highlights) {
      const at = locate(lines, highlight);
      // Not there any more, so there is no honest place to draw it. Dropped, never guessed.
      if (!at) continue;
      const held = this.#pin(at.row, { start: at.col, end: at.col + at.length }, highlight.color);
      if (held) this.#pinned.push(held);
    }
    this.#redraw();
  }

  /**
   * Highlight what is selected, or take it off when it is exactly what is already there.
   *
   * Per line, and merged with whatever that line already has, so painting over a highlight
   * widens it instead of stacking another translucent layer on the overlap.
   *
   * Returns how many lines changed, zero when nothing was selected.
   */
  add(color: string): number {
    const pieces = selectionPieces(this.#term);
    if (pieces.length === 0) return 0;

    let changed = 0;
    for (const piece of pieces) {
      const wanted: Range = { start: piece.col, end: piece.col + piece.text.length };
      const onRow = this.#live().filter((p) => p.marker.line === piece.row);
      const next = addOrToggle(
        onRow.map((p) => p.range),
        wanted,
      );

      // Everything on this row is replaced by the merged result, which is what stops a stack.
      for (const p of onRow) {
        p.decoration?.dispose();
        p.marker.dispose();
      }
      this.#pinned = this.#pinned.filter((p) => !onRow.includes(p));

      for (const range of next) {
        // A range that was already there keeps the color it was given; a new one takes this one.
        const previous = onRow.find((p) => p.range.start === range.start)?.highlight.color;
        const held = this.#pin(piece.row, range, previous ?? color);
        if (held) this.#pinned.push(held);
      }
      changed++;
    }
    this.#redraw();
    this.#onChange(this.highlights);
    return changed;
  }

  /** Is there a highlight under this point? What `Remove highlight` is offered for. */
  covers(row: number, column: number): boolean {
    return rangeAt(this.#byRow().get(row) ?? [], column) !== null;
  }

  /**
   * Take off the whole run of highlight a point is part of.
   *
   * Everything continuous with it, across rows as well as along one, whenever it was made. A
   * block of color reads as one thing, so it comes off as one thing.
   */
  removeAt(row: number, column: number): boolean {
    const run = connected(this.#byRow(), row, column);
    if (run.length === 0) return false;

    const going = this.#live().filter((p) =>
      run.some((x) => x.row === p.marker.line && x.range.start === p.range.start),
    );
    if (going.length === 0) return false;
    for (const p of going) {
      p.decoration?.dispose();
      p.marker.dispose();
    }
    this.#pinned = this.#pinned.filter((p) => !going.includes(p));
    this.#onChange(this.highlights);
    return true;
  }

  clear(): void {
    if (this.#pinned.length === 0) return;
    for (const p of this.#pinned) {
      p.decoration?.dispose();
      p.marker.dispose();
    }
    this.#pinned = [];
    this.#onChange(this.highlights);
  }

  /** Where the highlights are now, for the rail beside the scrollbar. */
  places(): { row: number; color: number }[] {
    const seen = new Set<number>();
    const out: { row: number; color: number }[] = [];
    for (const p of this.#live()) {
      // One pip per row. A row highlighted in three places is still one place to scroll to.
      if (seen.has(p.marker.line)) continue;
      seen.add(p.marker.line);
      out.push({ row: p.marker.line, color: Number.parseInt(p.highlight.color.slice(1), 16) });
    }
    return out;
  }

  /**
   * Draw anything not drawn yet, and forget anything whose line has gone.
   *
   * A decoration follows its own marker, so nothing has to be rebuilt when the buffer scrolls.
   */
  draw(): void {
    this.#redraw();
  }

  #redraw(): void {
    const alive: Pinned[] = [];
    for (const p of this.#pinned) {
      if (p.marker.isDisposed) {
        p.decoration?.dispose();
        continue;
      }
      if (!p.decoration) {
        const style = highlightStyle(p.highlight.color);
        const decoration = this.#term.registerDecoration({
          marker: p.marker,
          x: p.range.start,
          width: p.range.end - p.range.start,
          // Over the text, and translucent, so the characters read through it. An opaque block
          // hid the very thing the highlight was pointing at.
          layer: 'top',
        });
        if (decoration) {
          decoration.onRender((element: HTMLElement) => {
            element.style.background = style.background;
            /**
             * Edges down the sides only.
             *
             * A full outline drew a line between one highlighted row and the next, so a block
             * spanning several rows looked like several stripes. The sides are what makes a
             * highlight visible at low alpha; the top and bottom only ever separated it from
             * itself.
             */
            element.style.boxShadow = `inset 1px 0 0 ${style.border}, inset -1px 0 0 ${style.border}`;
            element.style.pointerEvents = 'none';
          });
          p.decoration = decoration;
        }
      }
      alive.push(p);
    }
    this.#pinned = alive;
  }

  dispose(): void {
    for (const p of this.#pinned) {
      p.decoration?.dispose();
      p.marker.dispose();
    }
    this.#pinned = [];
  }
}
