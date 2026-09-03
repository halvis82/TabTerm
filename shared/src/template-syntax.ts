/**
 * A layout, written down.
 *
 * `1+2` is two panes side by side. `1/2` is two stacked. Brackets group, so `(1+2)/3` is two
 * side by side above a third, and `(1/2)+3` is two stacked beside a third.
 *
 * The numbers are **names, not counts**. Each one names a command, and using the same number
 * twice means both panes run it, which makes "a build in both halves" one thing to write rather
 * than two to keep in step.
 *
 * Every pane is still its own terminal. A session is never in two panes at once, which is a rule
 * the whole product rests on; what is shared is the command, not the shell.
 *
 * The grammar is deliberately tiny:
 *
 *     shape  := row
 *     row    := column ('+' column)*      side by side
 *     column := atom ('/' atom)*          stacked
 *     atom   := number | '(' row ')'
 *
 * Nothing else is allowed, because everything else is a thing to explain. A template is a
 * sentence somebody types once and reads later, and the whole value of it is being obvious then.
 */

export type ShapeNode =
  | { kind: 'session'; id: number }
  | { kind: 'split'; direction: 'horizontal' | 'vertical'; children: ShapeNode[] };

export interface ParsedShape {
  shape: ShapeNode;
  /** Every distinct number, in the order they first appear. One command box each. */
  sessions: number[];
}

export class ShapeError extends Error {}

/** Parse a shape, or say what is wrong with it in words somebody can act on. */
export function parseShape(text: string): ParsedShape {
  const source = text.trim();
  if (source === '') throw new ShapeError('Write a shape, such as 1+2 or (1+2)/3');

  let at = 0;
  const peek = (): string => source[at] ?? '';
  const skipSpace = (): void => {
    while (peek() === ' ') at++;
  };

  const parseAtom = (): ShapeNode => {
    skipSpace();
    if (peek() === '(') {
      at++;
      const inner = parseRow();
      skipSpace();
      if (peek() !== ')') throw new ShapeError('A bracket was opened and never closed');
      at++;
      return inner;
    }
    const start = at;
    while (/[0-9]/.test(peek())) at++;
    if (at === start) {
      const found = peek() === '' ? 'the end' : `"${peek()}"`;
      throw new ShapeError(`Expected a number and found ${found}`);
    }
    const id = Number(source.slice(start, at));
    if (id < 1 || id > 9) throw new ShapeError('Numbers run from 1 to 9');
    return { kind: 'session', id };
  };

  const parseColumn = (): ShapeNode => {
    const children = [parseAtom()];
    for (;;) {
      skipSpace();
      if (peek() !== '/') break;
      at++;
      children.push(parseAtom());
    }
    return children.length === 1
      ? (children[0] as ShapeNode)
      : { kind: 'split', direction: 'vertical', children };
  };

  const parseRow = (): ShapeNode => {
    const children = [parseColumn()];
    for (;;) {
      skipSpace();
      if (peek() !== '+') break;
      at++;
      children.push(parseColumn());
    }
    return children.length === 1
      ? (children[0] as ShapeNode)
      : { kind: 'split', direction: 'horizontal', children };
  };

  const shape = parseRow();
  skipSpace();
  if (at < source.length) throw new ShapeError(`Did not understand "${source.slice(at)}"`);

  const sessions: number[] = [];
  const walk = (node: ShapeNode): void => {
    if (node.kind === 'session') {
      if (!sessions.includes(node.id)) sessions.push(node.id);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(shape);
  if (previewPanes(shape).length > 6) {
    throw new ShapeError('Six panes is as many as a tab can usefully hold');
  }
  return { shape, sessions };
}

/** Parsed, or the reason it is not, for showing under the box as it is typed. */
export function checkShape(text: string): { shape: ParsedShape } | { error: string } {
  try {
    return { shape: parseShape(text) };
  } catch (e) {
    return { error: e instanceof ShapeError ? e.message : 'That is not a shape' };
  }
}

/**
 * The panes a shape makes, as fractions of the tab, for drawing a preview.
 *
 * A preview is the whole point of a syntax: nobody should have to run a template to find out
 * what it builds. Fractions rather than pixels, so the same numbers draw a thumbnail and a
 * full-size box.
 */
export interface PreviewPane {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function previewPanes(shape: ShapeNode): PreviewPane[] {
  const out: PreviewPane[] = [];
  const place = (node: ShapeNode, x: number, y: number, width: number, height: number): void => {
    if (node.kind === 'session') {
      out.push({ id: node.id, x, y, width, height });
      return;
    }
    const count = node.children.length;
    node.children.forEach((child, i) => {
      if (node.direction === 'horizontal') {
        place(child, x + (width / count) * i, y, width / count, height);
      } else {
        place(child, x, y + (height / count) * i, width, height / count);
      }
    });
  };
  place(shape, 0, 0, 1, 1);
  return out;
}
