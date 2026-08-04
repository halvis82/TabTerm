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
