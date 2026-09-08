import type { LayoutNode, SplitDirection } from './model.js';
import { RATIO_MAX, RATIO_MIN } from './model.js';

/**
 * Pure operations on a workspace layout tree.
 *
 * No IO, no sessions, no rendering. Kept pure because every split, close, and move has to
 * leave a valid tree, and the only way to be sure of that is to test the operations in
 * isolation against random sequences. See docs/03-data-model.md §2.
 */

export class LayoutError extends Error {}

export function terminalNode(paneId: string, sessionId: string): LayoutNode {
  return { type: 'terminal', paneId, sessionId };
}

/** Every pane in the tree, left to right, top to bottom. */
export function panes(node: LayoutNode): { paneId: string; sessionId: string }[] {
  if (node.type === 'terminal') return [{ paneId: node.paneId, sessionId: node.sessionId }];
  return [...panes(node.children[0]), ...panes(node.children[1])];
}

export function findPane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'terminal') return node.paneId === paneId ? node : null;
  return findPane(node.children[0], paneId) ?? findPane(node.children[1], paneId);
}

export function paneCount(node: LayoutNode): number {
  return panes(node).length;
}

/**
 * Split a pane in two.
 *
 * The existing pane keeps its position as the first child, so splitting feels like the new
 * pane appearing beside what you were already looking at rather than the layout rearranging.
 */
export function splitPane(
  root: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  newPaneId: string,
  newSessionId: string,
  ratio = 0.5,
): LayoutNode {
  if (findPane(root, paneId) === null) throw new LayoutError(`no such pane: ${paneId}`);

  const replace = (node: LayoutNode): LayoutNode => {
    if (node.type === 'terminal') {
      if (node.paneId !== paneId) return node;
      return {
        type: 'split',
        direction,
        ratio: clampRatio(ratio),
        children: [node, terminalNode(newPaneId, newSessionId)],
      };
    }
    return {
      ...node,
      children: [replace(node.children[0]), replace(node.children[1])],
    };
  };

  return replace(root);
}

/**
 * Remove a pane, collapsing its parent split into the surviving sibling.
 *
 * Returns null when the last pane goes, which means the workspace itself is finished.
 */
export function closePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (findPane(root, paneId) === null) throw new LayoutError(`no such pane: ${paneId}`);
  if (root.type === 'terminal') return root.paneId === paneId ? null : root;

  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'terminal') return node.paneId === paneId ? null : node;
    const left = prune(node.children[0]);
    const right = prune(node.children[1]);
    if (left === null) return right;
    if (right === null) return left;
    return { ...node, children: [left, right] };
  };

  return prune(root);
}

/**
 * Put a different session into a pane that already exists, keeping the pane and the shape.
 *
 * This is what "bring a session here" means. The pane offering that choice is an empty one, so
 * splitting it left the empty shell sitting beside the session somebody asked for, which is not
 * what they asked for. The pane id is kept so the split ratios around it survive.
 */
export function setPaneSession(root: LayoutNode, paneId: string, sessionId: string): LayoutNode {
  if (findPane(root, paneId) === null) throw new LayoutError(`no such pane: ${paneId}`);
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'terminal') return node.paneId === paneId ? { ...node, sessionId } : node;
    return { ...node, children: [walk(node.children[0]), walk(node.children[1])] };
  };
  return walk(root);
}

/**
 * Where a pane sits, in terms that survive it being removed.
 *
 * Closing a pane collapses the split that held it: the parent is replaced by the surviving
 * sibling, and every fact about where the closed one was is gone with it. Undo then had nothing
 * to work from and put the pane back beside whichever one happened to be focused, which is
 * usually not where it came from.
 *
 * Described by its **sibling** rather than by a path from the root, because a path is only valid
 * against the tree it was taken from and the tree changes while the offer is up. A sibling is a
 * pane id, and a pane id still means the same pane after anything else has moved.
 */
export interface PanePlace {
  /**
   * Every pane that was on the other side of the split, not just one of them.
   *
   * A sibling can be a whole subtree, and naming one pane inside it is not enough to find that
   * subtree again: "the node whose first pane is this one" matched the root as readily as the
   * subtree, so restoring wrapped the entire layout instead of half of it. The set says exactly
   * how much of the tree was the sibling, and the smallest node holding all of it is that
   * subtree however the rest has moved.
   */
  siblingPaneIds: string[];
  /** Which half of that split it was: `first` is left or top. */
  side: 'first' | 'second';
  direction: SplitDirection;
  ratio: number;
}

/** Where a pane sits right now, or null when it is the only one. */
export function placeOf(root: LayoutNode, paneId: string): PanePlace | null {
  const walk = (node: LayoutNode): PanePlace | null => {
    if (node.type === 'terminal') return null;
    for (const side of ['first', 'second'] as const) {
      const mine = side === 'first' ? node.children[0] : node.children[1];
      const other = side === 'first' ? node.children[1] : node.children[0];
      if (mine.type !== 'terminal' || mine.paneId !== paneId) continue;
      /**
       * The sibling is a pane, or the first pane inside whatever the sibling is.
       *
       * A sibling can be a whole subtree. Naming one pane inside it is enough to find the split
       * again later, because putting the restored pane back beside that pane rebuilds the same
       * shape from the outside: the subtree stays whole and gains a parent on the right side.
       */
      const siblingPaneIds = panes(other).map((p) => p.paneId);
      if (siblingPaneIds.length === 0) return null;
      return { siblingPaneIds, side, direction: node.direction, ratio: node.ratio };
    }
    return walk(node.children[0]) ?? walk(node.children[1]);
  };
  return walk(root);
}

/**
 * Put a pane back where it was, on the side it was on.
 *
 * `splitPane` cannot do this: it always puts the new pane second, which is right for a split
 * somebody asked for and wrong for an undo, where being on the left is part of what is being
 * restored.
 *
 * Falls back to `null` when the sibling has gone as well, which is the caller's cue to place it
 * the ordinary way rather than to fail. An undo that cannot be exact is still worth doing.
 */
export function restorePane(
  root: LayoutNode,
  place: PanePlace,
  paneId: string,
  sessionId: string,
): LayoutNode | null {
  /**
   * What is left of the sibling. Some of it may have been closed while the offer was up.
   *
   * The pane goes back beside whatever survives, which is the nearest thing to where it was, and
   * beside nothing at all is the caller's cue to place it the ordinary way instead.
   */
  const here = new Set(panes(root).map((p) => p.paneId));
  const survivors = place.siblingPaneIds.filter((id) => here.has(id));
  if (survivors.length === 0) return null;

  /**
   * The smallest node holding every surviving sibling, which is the sibling itself.
   *
   * Smallest, because a bigger one is also true of every ancestor up to the root: matching on
   * "contains the sibling" without this wrapped the whole layout, which put a three pane tab back
   * as the wrong shape with the right panes in it.
   */
  const holdsAll = (node: LayoutNode): boolean => {
    const ids = new Set(panes(node).map((p) => p.paneId));
    return survivors.every((id) => ids.has(id));
  };
  const smallest = (node: LayoutNode): LayoutNode => {
    if (node.type === 'terminal') return node;
    for (const child of node.children) if (holdsAll(child)) return smallest(child);
    return node;
  };
  if (!holdsAll(root)) return null;
  const sibling = smallest(root);

  const restored = terminalNode(paneId, sessionId);
  const wrapped: LayoutNode = {
    type: 'split',
    direction: place.direction,
    ratio: clampRatio(place.ratio),
    children: place.side === 'first' ? [restored, sibling] : [sibling, restored],
  };

  // The sibling may be the whole layout, in which case the wrap is the new root.
  if (sibling === root) return wrapped;

  const rebuild = (node: LayoutNode): LayoutNode => {
    if (node.type === 'terminal') return node;
    return {
      ...node,
      children: [
        node.children[0] === sibling ? wrapped : rebuild(node.children[0]),
        node.children[1] === sibling ? wrapped : rebuild(node.children[1]),
      ],
    };
  };
  return rebuild(root);
}

/** Insert an existing session as a new pane beside a target. This is what merge does. */
export function insertPane(
  root: LayoutNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
  sessionId: string,
): LayoutNode {
  return splitPane(root, targetPaneId, direction, newPaneId, sessionId);
}

/** Change the ratio of the split that directly contains a pane. */
export function setRatio(root: LayoutNode, paneId: string, ratio: number): LayoutNode {
  const clamped = clampRatio(ratio);
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'terminal') return node;
    const directlyContains =
      (node.children[0].type === 'terminal' && node.children[0].paneId === paneId) ||
      (node.children[1].type === 'terminal' && node.children[1].paneId === paneId);
    const next: LayoutNode = {
      ...node,
      children: [walk(node.children[0]), walk(node.children[1])],
    };
    return directlyContains ? { ...next, ratio: clamped } : next;
  };
  return walk(root);
}

/** Swap two panes in place, keeping the tree shape. */
export function swapPanes(root: LayoutNode, a: string, b: string): LayoutNode {
  const paneA = findPane(root, a);
  const paneB = findPane(root, b);
  if (paneA === null || paneB === null) throw new LayoutError('both panes must exist');
  if (a === b) return root;

  const swap = (node: LayoutNode): LayoutNode => {
    if (node.type === 'terminal') {
      if (node.paneId === a) return paneB;
      if (node.paneId === b) return paneA;
      return node;
    }
    return { ...node, children: [swap(node.children[0]), swap(node.children[1])] };
  };
  return swap(root);
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
}

/**
 * Reject a tree that could not have come from these operations.
 *
 * The layout arrives over the wire, so it is untrusted input like anything else. A malformed
 * tree must be refused rather than rendered. See docs/05-security.md.
 */
export function validateLayout(
  node: unknown,
  seen = new Set<string>(),
): asserts node is LayoutNode {
  if (typeof node !== 'object' || node === null) throw new LayoutError('node is not an object');
  const n = node as { type?: unknown };

  if (n.type === 'terminal') {
    const t = node as { paneId?: unknown; sessionId?: unknown };
    if (typeof t.paneId !== 'string' || t.paneId.length === 0) {
      throw new LayoutError('terminal node needs a paneId');
    }
    if (typeof t.sessionId !== 'string' || t.sessionId.length === 0) {
      throw new LayoutError('terminal node needs a sessionId');
    }
    if (seen.has(t.paneId)) throw new LayoutError(`duplicate paneId: ${t.paneId}`);
    seen.add(t.paneId);
    return;
  }

  if (n.type === 'split') {
    const s = node as { direction?: unknown; ratio?: unknown; children?: unknown };
    if (s.direction !== 'horizontal' && s.direction !== 'vertical') {
      throw new LayoutError('split needs a direction');
    }
    if (typeof s.ratio !== 'number' || !Number.isFinite(s.ratio)) {
      throw new LayoutError('split needs a numeric ratio');
    }
    if (s.ratio < RATIO_MIN || s.ratio > RATIO_MAX) {
      throw new LayoutError(`ratio ${String(s.ratio)} out of bounds`);
    }
    if (!Array.isArray(s.children) || s.children.length !== 2) {
      throw new LayoutError('split needs exactly two children');
    }
    validateLayout(s.children[0], seen);
    validateLayout(s.children[1], seen);
    return;
  }

  throw new LayoutError(`unknown node type: ${String(n.type)}`);
}

export function isValidLayout(node: unknown): node is LayoutNode {
  try {
    validateLayout(node);
    return true;
  } catch {
    return false;
  }
}

/** A label a person typed, bounded so it stays a label rather than becoming a paragraph. */
export const MAX_PANE_LABEL = 40;

/**
 * Clean up a pane label, or refuse it.
 *
 * Terminal output is untrusted and so is anything typed into a box, so this returns plain text
 * with no control characters and a bounded length. It is rendered with `textContent`, so this is
 * about legibility rather than safety, and a label containing a newline would break the layout
 * rather than the page.
 */
export function cleanPaneLabel(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Control characters become spaces. A label is drawn on one line over a pane, so a newline
    // is not a label, and a stray escape has no business reaching a style attribute.
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.trim().slice(0, MAX_PANE_LABEL);
}

/** Only `#rrggbb`. A color that is not one is dropped rather than guessed at. */
export function cleanLabelColor(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : undefined;
}
