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

    /*
     * A bare URL is handled by the web links provider, not here.
     *
     * Except a `file://` one, which nothing else handles and which names a path on this machine:
     * agents print `file:///Users/...` beside the plain path, and the path inside it is what
     * somebody wants opened.
     */
    const before = text.slice(Math.max(0, start - 8), start + token.length);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(before) && !/^file:\/\//i.test(before)) {
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

      const line = readLogicalLine(term, bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const urls = findUrls(line.text);
      const candidates = candidatesIn(line).filter(
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
        /*
         * The pointer is xterm's. The underline is not.
         *
         * xterm draws its link underline in the cell's own color, which is not the color the link
         * is being drawn in, so the two disagreed. Ours is drawn with the mark below, from one
         * color, and appears only while the pointer is actually on the link. The cursor used to
         * change for the whole screen the moment the modifier went down, which said "something
         * here is clickable" without saying what.
         */
        decorations: { pointerCursor: held, underline: false },
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
      /*
       * Longest first. A path broken across two rows is offered whole and as its first row's
       * fragment, and when both exist, the directory the fragment names and the file the whole
       * path names, the cell they share belongs to the longer one.
       */
      links.sort((a, b) => b.text.length - a.text.length);
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

/** A character a path can contain, which is what a row has to end and begin with to be joined. */
const PATH_CHAR = /[\w.@+~/-]/;

/**
 * Whether a row that is not marked as wrapped nonetheless continues the row above it.
 *
 * xterm marks a row as wrapped only when it wrapped the text itself. A program that lays out
 * its own output breaks a long path by hand instead: Claude Code fills a row to its last column
 * and then writes a newline, so the path arrives as two rows that the terminal has no reason
 * to connect. Reported from a narrow pane in a split, where the path was underlined on its first
 * row only and opened a directory rather than the file.
 *
 * The rule is deliberately loose, a filled row ending in a path character followed by a row
 * beginning with one, because the daemon decides what exists. Joining two rows of prose that
 * happen to meet this way costs one candidate that does not resolve, and the rows' own
 * candidates are still offered, so nothing that was a link stops being one.
 */
export function continuesHard(previous: string, next: string, cols: number): boolean {
  /*
   * Filled to the last column, or to the one before it.
   *
   * ink leaves the last column free: every wrapped row of a Claude Code answer in a 94 column
   * pane was 93 characters long, measured from a screenshot of paths that were not links. A
   * terminal that wrapped the text itself fills the row, so both widths mean "this row ran out
   * of room".
   */
  if (previous.length < cols - 1 || previous.length > cols) return false;
  const indent = hangingIndent(next);
  if (indent === null) return false;
  return PATH_CHAR.test(previous[previous.length - 1] ?? '') && PATH_CHAR.test(next[indent] ?? '');
}

/**
 * How far a continuation row is indented, or null when it is not a continuation at all.
 *
 * ink wraps a paragraph under its own first line: the rows of a bullet are indented two spaces,
 * the rows of a numbered item three, and the path in them starts after that. The second
 * screenshot of this had the continuation row begin with two spaces, which the first rule read
 * as "not a path character" and refused. Bounded, because a row that starts with a tab's worth
 * of space is a code block or a table, and those wrap nothing.
 */
export function hangingIndent(row: string): number | null {
  const indent = row.length - row.trimStart().length;
  if (indent >= row.length || indent > MAX_HANGING_INDENT) return null;
  return indent;
}

const MAX_HANGING_INDENT = 8;

export interface LogicalLine {
  /** Every row joined. A row xterm wrapped is padded to the width; a row a program broke is not. */
  text: string;
  /**
   * The rows it was read from, in order, each with its buffer index, where it starts in `text`,
   * and how many leading cells were left out of `text` as a hanging indent.
   */
  rows: { text: string; y: number; start: number; skip: number }[];
  /** Whether any of the joins was a guess rather than xterm's own wrap flag. */
  hardJoins: boolean;
  width: number;
  offsetToColumn: (offset: number) => { x: number; y: number } | null;
}

/**
 * Reassemble a logical line from the rows it is drawn on.
 *
 * A path near the right edge is split across rows, and matching per row would miss it or match
 * half of it. This joins the rows, whether xterm wrapped them or the program broke them by hand,
 * and can map any offset back to a row and column. `row` is zero-based.
 *
 * A row xterm wrapped is taken padded to the full width, which is what it is: the wrap happened
 * because the row was full. A row a program broke is taken as written, because ink stops one
 * column short, and the padding there put a space inside the path and broke it in two again.
 */
export function readLogicalLine(term: Terminal, row: number): LogicalLine | null {
  const buf = term.buffer.active;
  const width = term.cols;
  const trimmed = (y: number): string => buf.getLine(y)?.translateToString(true) ?? '';
  const continues = (y: number): boolean => {
    const line = buf.getLine(y);
    if (!line) return false;
    if (line.isWrapped) return true;
    return continuesHard(trimmed(y - 1), trimmed(y), width);
  };

  let first = row;
  while (first > 0 && continues(first)) first--;

  const found: { line: IBufferLine; y: number; wrappedNext: boolean }[] = [];
  let hardJoins = false;
  for (let y = first; y < buf.length; y++) {
    const l = buf.getLine(y);
    if (!l) break;
    if (y !== first) {
      if (!continues(y)) break;
      if (!l.isWrapped) hardJoins = true;
    }
    found.push({ line: l, y, wrappedNext: false });
    if (found.length > 12) break; // a path spanning more than this is not a path
  }
  if (found.length === 0) return null;
  for (let i = 0; i + 1 < found.length; i++) {
    const next = found[i + 1];
    const here = found[i];
    if (here && next) here.wrappedNext = next.line.isWrapped;
  }

  const rows: { text: string; y: number; start: number; skip: number }[] = [];
  let text = '';
  found.forEach((r, i) => {
    // The last row is never padded: nothing follows it that the padding would need to reach.
    const last = i === found.length - 1;
    let segment =
      !last && r.wrappedNext ? r.line.translateToString(false) : r.line.translateToString(true);
    // A row a program broke continues after its hanging indent, not at the indent.
    let skip = 0;
    if (i > 0 && !r.line.isWrapped) {
      skip = hangingIndent(segment) ?? 0;
      segment = segment.slice(skip);
    }
    rows.push({ text: segment, y: r.y, start: text.length, skip });
    text += segment;
  });

  return {
    text,
    rows,
    hardJoins,
    width,
    offsetToColumn(offset) {
      if (offset < 0 || offset >= text.length) return null;
      let row = rows[0];
      for (const r of rows) if (r.start <= offset) row = r;
      if (!row) return null;
      return { x: offset - row.start + row.skip, y: row.y + 1 };
    },
  };
}

/**
 * The path candidates on a logical line.
 *
 * From the joined text, and when a join was a guess, from each row on its own as well, so a
 * guess that was wrong costs nothing: the rows' own paths are still offered, and the daemon
 * says which of them exist.
 */
export function candidatesIn(line: LogicalLine): Candidate[] {
  const found = findCandidates(line.text);
  if (!line.hardJoins) return found;
  const seen = new Set(found.map((c) => `${String(c.start)}:${String(c.end)}`));
  for (const row of line.rows) {
    for (const c of findCandidates(row.text)) {
      const key = `${String(row.start + c.start)}:${String(row.start + c.end)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ text: c.text, start: row.start + c.start, end: row.start + c.end });
    }
  }
  return found;
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
 * The underline comes from here too rather than from xterm, which draws its own in the cell's
 * color and so disagreed with the color the link was being drawn in.
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
    decoration.onRender((element) => {
      // The underline, in the same color as the text rather than in the color the text used to be.
      element.style.borderBottom = `1px solid ${color}`;
      // The mark must never be the thing under the pointer, or hovering it would count as leaving.
      element.style.pointerEvents = 'none';
    });
    made.push(decoration);
  }
  return made;
}
