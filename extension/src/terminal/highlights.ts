import type { IDecoration, Terminal } from '@xterm/xterm';
import { highlightAt, highlightsForSelection, locate, type Highlight } from './highlight-anchor.js';

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
 * at the source. So the position is remembered as text rather than as a row, and the record is
 * kept per session in extension storage. See `highlight-anchor.ts` for why that is stable.
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
    typeof h['fromEnd'] === 'number' &&
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
    const text = line.translateToString(false, from, to);
    pieces.push({ row, col: from, text });
  }
  return pieces;
}

export class HighlightLayer {
  #highlights: Highlight[] = [];
  #drawn: IDecoration[] = [];
  readonly #term: Terminal;
  readonly #onChange: (highlights: readonly Highlight[]) => void;

  constructor(term: Terminal, onChange: (highlights: readonly Highlight[]) => void) {
    this.#term = term;
    this.#onChange = onChange;
  }

  get highlights(): readonly Highlight[] {
    return this.#highlights;
  }

  /** Restored from storage, without announcing a change nobody made. */
  restore(highlights: readonly Highlight[]): void {
    this.#highlights = [...highlights];
    this.draw();
  }

  /** Highlight what is selected, and say so. Returns how many lines were covered. */
  add(color: string): number {
    const made = highlightsForSelection(
      bufferLines(this.#term),
      selectionPieces(this.#term),
      color,
    );
    if (made.length === 0) return 0;
    this.#highlights.push(...made);
    this.draw();
    this.#onChange(this.#highlights);
    return made.length;
  }

  /** Take off the highlight under a point, if there is one. */
  removeAt(row: number, col: number): boolean {
    const hit = highlightAt(bufferLines(this.#term), this.#highlights, row, col);
    if (!hit) return false;
    this.#highlights = this.#highlights.filter((h) => h !== hit);
    this.draw();
    this.#onChange(this.#highlights);
    return true;
  }

  clear(): void {
    if (this.#highlights.length === 0) return;
    this.#highlights = [];
    this.draw();
    this.#onChange(this.#highlights);
  }

  /** Where the highlights are now, for the rail beside the scrollbar. */
  places(): { row: number; color: number }[] {
    const lines = bufferLines(this.#term);
    const out: { row: number; color: number }[] = [];
    for (const h of this.#highlights) {
      const at = locate(lines, h);
      if (at) out.push({ row: at.row, color: Number.parseInt(h.color.slice(1), 16) });
    }
    return out;
  }

  /**
   * Redraw every highlight.
   *
   * All of them, every time, rather than tracking which moved. A decoration is anchored to a
   * marker that is relative to the cursor line, so every one of them is wrong as soon as the
   * buffer scrolls, and rebuilding a handful of decorations is cheaper than being subtly wrong.
   */
  draw(): void {
    for (const d of this.#drawn) d.dispose();
    this.#drawn = [];

    const buffer = this.#term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    const lines = bufferLines(this.#term);

    for (const h of this.#highlights) {
      const at = locate(lines, h);
      if (!at) continue;
      const marker = this.#term.registerMarker(at.row - cursorLine);
      if (!marker) continue;
      const decoration = this.#term.registerDecoration({
        marker,
        x: at.col,
        width: at.length,
        backgroundColor: h.color,
        // Behind the characters. On top it would be a block of color where the text was.
        layer: 'bottom',
      });
      if (decoration) this.#drawn.push(decoration);
    }
  }

  dispose(): void {
    for (const d of this.#drawn) d.dispose();
    this.#drawn = [];
  }
}
