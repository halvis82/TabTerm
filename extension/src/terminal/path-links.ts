import type { Terminal, IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';
import type { ResolvedPath } from '@tabterm/shared';

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
  describe: (resolved: ResolvedPath) => string;
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

export function createPathLinkProvider(term: Terminal, opts: PathLinkOptions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = readWrappedLine(term, bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }

      const candidates = findCandidates(line.text);
      if (candidates.length === 0) {
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
      for (const c of candidates) {
        const resolved = opts.lookup(c.text);
        if (!resolved?.exists) continue;

        const startCol = line.offsetToColumn(c.start);
        const endCol = line.offsetToColumn(c.end - 1);
        if (startCol === null || endCol === null) continue;

        links.push({
          text: c.text,
          range: {
            start: { x: startCol.x + 1, y: startCol.y },
            end: { x: endCol.x + 1, y: endCol.y },
          },
          activate: (event) => opts.activate(resolved, event),
          hover: () => {
            /* tooltip handled by the page */
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
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
