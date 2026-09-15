import type { LayoutNode } from '@tabterm/shared';

/**
 * Whether a set of claimed pane widths can be true of the layout the daemon is holding.
 *
 * The daemon knows the shape of the workspace: which panes sit beside which, and at what ratio the
 * divider between them stands. So it can check an arriving claim against something it already
 * knows, rather than believing whatever a page says about a pane it cannot see.
 *
 * This exists because of a real failure, measured in a real log. An attach carried one size and it
 * was applied to every session in the workspace: forty-two times in one day, a tab whose panes were
 * 116 and 42 columns had **both** told they were 116, and the narrow one was corrected forty
 * milliseconds later. A shell survives that. An agent redraws its entire interface on a resize, so
 * it drew at the wrong width, drew again at the right one, and left the first frame stranded
 * between the lines of the second.
 *
 * That particular fault is fixed at its source. This is the backstop under it, and it is worth
 * having separately because the source is a message from somewhere else: an older extension, a
 * page mid-reload, or a client nobody has written yet. A daemon that can tell a claim is impossible
 * should not act on it whatever sent it.
 *
 * Only provable contradictions. Claims are compared against the ratio the layout records, with room
 * for the fact that a column is not a pixel and dividers have width, so a genuine measurement never
 * trips it. When it does fire nothing is refused: the sizes are treated as not-yet-measured, which
 * is a state the attach path already has, so the sessions keep the sizes they are running at until
 * the page measures properly a moment later.
 */

/** How far a claimed split may sit from the recorded one before it stops being a measurement. */
export const RATIO_TOLERANCE = 0.12;

/**
 * The width a subtree would have, if the claims were true.
 *
 * Side by side, widths add. Stacked, every pane is the same width, so the widest claim is the
 * subtree's width and a disagreement between them is not this function's business. Undefined when
 * anything inside was not claimed, because a partial answer cannot be checked against anything.
 */
function claimedWidth(node: LayoutNode, claims: ReadonlyMap<string, number>): number | undefined {
  if (node.type === 'terminal') return claims.get(node.paneId);
  const first = claimedWidth(node.children[0], claims);
  const second = claimedWidth(node.children[1], claims);
  if (first === undefined || second === undefined) return undefined;
  return node.direction === 'horizontal' ? first + second : Math.max(first, second);
}

/**
 * Whether these claimed widths contradict the layout.
 *
 * True only when some side-by-side split is claimed at a ratio the layout does not have. The
 * example that prompted it: two panes at 116 and 42 columns sit at a ratio near 0.73, and an attach
 * claiming 116 for both claims 0.5, which is not a measurement of this workspace.
 */
export function claimsContradictLayout(
  layout: LayoutNode,
  claims: ReadonlyMap<string, number>,
  tolerance = RATIO_TOLERANCE,
): boolean {
  const walk = (node: LayoutNode): boolean => {
    if (node.type === 'terminal') return false;
    if (node.direction === 'horizontal') {
      const first = claimedWidth(node.children[0], claims);
      const second = claimedWidth(node.children[1], claims);
      if (first !== undefined && second !== undefined && first + second > 0) {
        const claimed = first / (first + second);
        if (Math.abs(claimed - node.ratio) > tolerance) return true;
      }
    }
    return walk(node.children[0]) || walk(node.children[1]);
  };
  return walk(layout);
}
