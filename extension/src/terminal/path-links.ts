import type {
  Terminal,
  IBufferLine,
  IBufferRange,
  IDecoration,
  ILink,
  ILinkProvider,
} from '@xterm/xterm';
import type { ResolvedPath } from '@tabterm/shared';
import { linkColorFor } from './link-color.js';

/**
 * Clickable file and directory paths.
 *
 * Terminal output is untrusted, so a match here is a candidate only. The daemon resolves it
 * against the session's working directory and confirms it exists before anything becomes
 * clickable. Nothing opens without an explicit click. See docs/05-security.md §4.
 */

/**
 * Path-shaped tokens.
 *
 * Deliberately loose, because the daemon filters by actually stat-ing. Being permissive here
 * costs one round trip; being strict here means missing real paths.
 */
const PATH_TOKEN =
  /(?:~|\.{1,2})?(?:\/[\w.@+~-]+)+\/?(?::\d+(?::\d+)?)?|(?:[\w.@+-]+\/)+[\w.@+-]+(?::\d+(?::\d+)?)?/g;

/** Trailing punctuation a human would not consider part of the path. */
const TRAILING = /[.,;:)\]}'"]+$/;

export interface PathLinkOptions {
  resolve: (candidates: string[]) => void;
  lookup: (candidate: string) => ResolvedPath | undefined;
  activate: (resolved: ResolvedPath, event: MouseEvent) => void;
  openUrl: (url: string) => void;
  /**
   * Links are inert unless a modifier is held.
   *
   * A terminal is a place where you select text constantly, and paths appear in almost every
   * line of output. Making them permanently clickable turns ordinary selection into a minefield
   * of accidental opens. Requiring Command matches how editors handle the same problem.
   */
  modifierHeld: () => boolean;
}

interface Candidate {
  text: string;
  start: number;
  end: number;
}

export function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  PATH_TOKEN.lastIndex = 0;
  for (let m = PATH_TOKEN.exec(text); m !== null; m = PATH_TOKEN.exec(text)) {
    let token = m[0];
    const start = m.index;
    const stripped = token.replace(TRAILING, '');
    if (stripped.length < 2) continue;
    token = stripped;

    // A bare URL is handled by the web links provider, not here.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(Math.max(0, start - 8), start + token.length))) {
      continue;
    }
    out.push({ text: token, start, end: start + token.length });
  }
  return out;
}

/**
 * Only a left click follows a link.
 *
 * Without this, right-clicking a URL both opened it and showed the context menu, because the
 * link is activated by the mouse event without regard to which button produced it. Right-click
 * is how a person asks what their options are, and it must never be the thing that decides.
 */
function isPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0;
}

/** Bare URLs, handled here too so that links and paths behave identically. */
const URL_TOKEN = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;

export function findUrls(text: string): Candidate[] {
  const out: Candidate[] = [];
  URL_TOKEN.lastIndex = 0;
  for (let m = URL_TOKEN.exec(text); m !== null; m = URL_TOKEN.exec(text)) {
    const token = m[0].replace(TRAILING, '');
    if (token.length < 8) continue;
    out.push({ text: token, start: m.index, end: m.index + token.length });
  }
  return out;
}

export function createPathLinkProvider(term: Terminal, opts: PathLinkOptions): ILinkProvider {
  /** The decorations painting the link currently under the pointer, if any. */
  let highlight: IDecoration[] = [];
  const clearHighlight = (): void => {
    for (const d of highlight) d.dispose();
    highlight = [];
  };

  return {
    provideLinks(bufferLineNumber, callback) {
      /*
       * Answered whether or not the modifier is down, and marked only when it is.
       *
       * xterm asks its link providers when the pointer moves to a different line, and keeps the
       * answer for that line until it does. Answering "nothing here" while Command was up meant
       * that pressing Command afterwards changed nothing: the pointer was already on the line, so
       * nothing asked again, and you had to move away and come back. Reported exactly that way.
       *
       * Answering with a link that has no decorations and does nothing when clicked leaves xterm
       * holding one, and a link it is holding is re-asked for when the rows under it are drawn.
       * So `refreshLinks()` on the way down is enough to light it up under a pointer that never
       * moved. Nothing is visible and nothing opens until Command is actually held.
       */
      const held = opts.modifierHeld();

      const line = readWrappedLine(term, bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }

      const urls = findUrls(line.text);
      const candidates = findCandidates(line.text).filter(
        // A path inside a URL is part of the URL, not a separate file reference.
        (c) => !urls.some((u) => c.start >= u.start && c.end <= u.end),
      );
      if (candidates.length === 0 && urls.length === 0) {
        callback(undefined);
        return;
      }

      // Ask the daemon about anything not already known. The answer arrives asynchronously and
      // the next hover picks it up, so a path becomes clickable a moment after it is printed.
      const unknown = candidates
        .filter((c) => opts.lookup(c.text) === undefined)
        .map((c) => c.text);
      if (unknown.length > 0) opts.resolve(unknown);

      const links: ILink[] = [];

      const rangeFor = (c: Candidate) => {
        const startCol = line.offsetToColumn(c.start);
        const endCol = line.offsetToColumn(c.end - 1);
        if (startCol === null || endCol === null) return null;
        return {
          start: { x: startCol.x + 1, y: startCol.y },
          end: { x: endCol.x + 1, y: endCol.y },
        };
      };

      const hoverable = (link: ILink): ILink => ({
        ...link,
        // Pointer and underline are xterm's own, and they appear only while the pointer is
        // actually on the link. The cursor used to change for the whole screen the moment the
        // modifier went down, which said "something here is clickable" without saying what.
        decorations: { pointerCursor: held, underline: held },
        hover: () => {
          clearHighlight();
          if (!held) return;
          highlight = paintRange(term, link.range, colorFor(term, link.range));
        },
        leave: clearHighlight,
      });

      for (const u of urls) {
        const range = rangeFor(u);
        if (!range) continue;
        links.push(
          hoverable({
            text: u.text,
            range,
            activate: (event) => {
              if (!held || !isPrimaryClick(event)) return;
              opts.openUrl(u.text);
            },
          }),
        );
      }

      for (const c of candidates) {
        const resolved = opts.lookup(c.text);
        if (!resolved?.exists) continue;

        const range = rangeFor(c);
        if (!range) continue;

        links.push(
          hoverable({
            text: c.text,
            range,
            activate: (event) => {
              // A link exists without the modifier so that pressing it later can light one up.
              // Clicking one without it is an ordinary click in a terminal and stays that way.
              if (!held || !isPrimaryClick(event)) return;
              opts.activate(resolved, event);
            },
          }),
        );
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * Read what the first character of a link is drawn in, and pick a color that will show against it.
 *
 * The first character rather than all of them, because a path is drawn in one color in practice
 * and one decoration covers the row. A cell that cannot be read at all answers as ordinary text,
 * which is the safe way round: blue on plain text is right far more often than red is.
 */
function colorFor(term: Terminal, range: IBufferRange): string {
  const line = term.buffer.active.getLine(range.start.y - 1);
  const cell = line?.getCell(range.start.x - 1);
  if (!cell) return linkColorFor(null);
  return linkColorFor({
    isDefault: cell.isFgDefault(),
    isPalette: cell.isFgPalette(),
    color: cell.getFgColor(),
  });
}

/**
 * Reassemble a logical line from its wrapped rows.
 *
 * A path near the right edge is split across rows, and matching per row would miss it or match
 * half of it. This joins the rows and can map any offset back to a row and column.
 */
function readWrappedLine(
  term: Terminal,
  bufferLineNumber: number,
): { text: string; offsetToColumn: (offset: number) => { x: number; y: number } | null } | null {
  const buf = term.buffer.active;
  const index = bufferLineNumber - 1;

  let first = index;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;

  const rows: { line: IBufferLine; y: number }[] = [];
  for (let y = first; y < buf.length; y++) {
    const l = buf.getLine(y);
    if (!l) break;
    if (y !== first && !l.isWrapped) break;
    rows.push({ line: l, y });
    if (rows.length > 12) break; // a path spanning more than this is not a path
  }
  if (rows.length === 0) return null;

  const text = rows.map((r) => r.line.translateToString(false)).join('');
  const width = term.cols;

  return {
    text,
    offsetToColumn(offset) {
      if (offset < 0 || offset >= text.length) return null;
      const rowIndex = Math.floor(offset / width);
      const row = rows[rowIndex];
      if (!row) return null;
      return { x: offset % width, y: row.y + 1 };
    },
  };
}

/**
 * The color a link takes while the pointer is on it.
 *
 * xterm paints links with an underline and a pointer on its own, but not with a color, and a
 * terminal already underlines plenty of things. A box was tried first and was too loud, so this is
 * xterm's underline plus a color change on exactly the characters that will open.
 *
 * The color is chosen against the text rather than fixed, because agent output is full of color
 * and a path an agent printed is very often already blue. See `link-color.ts`.
 *
 * One decoration per row, because a decoration is a rectangle and a link that wraps is not one.
 * Returns whatever was created, which may be nothing: decorations are refused while the
 * alternate screen is active, and a link inside a full-screen program is not worth chasing.
 */
function paintRange(term: Terminal, range: IBufferRange, color: string): IDecoration[] {
  const buffer = term.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  const made: IDecoration[] = [];

  for (let y = range.start.y; y <= range.end.y; y++) {
    // Ranges are 1-based; markers are relative to the line the cursor is on.
    const marker = term.registerMarker(y - 1 - cursorLine);
    if (!marker) continue;

    const startX = y === range.start.y ? range.start.x - 1 : 0;
    const endX = y === range.end.y ? range.end.x : term.cols;
    const width = Math.max(1, endX - startX);

    const decoration = term.registerDecoration({
      marker,
      x: startX,
      width,
      height: 1,
      foregroundColor: color,
      layer: 'top',
    });
    if (!decoration) {
      marker.dispose();
      continue;
    }
    // The mark must never be the thing under the pointer, or hovering it would count as leaving.
    decoration.onRender((element) => {
      element.style.pointerEvents = 'none';
    });
    made.push(decoration);
  }
  return made;
}
