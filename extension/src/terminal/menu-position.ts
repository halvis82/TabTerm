/**
 * Where a context menu goes so that all of it is on screen.
 *
 * The pointer is the preferred anchor, and the menu opens down and to the right of it because
 * that is where a person expects it. Near an edge that would put half the menu outside the
 * window, so it flips to the other side of the pointer rather than being clamped: clamping
 * leaves the menu under the cursor, which covers the thing that was right-clicked.
 *
 * Kept pure so the arithmetic can be tested without a browser, which is the part that is easy
 * to get wrong and impossible to notice until somebody right-clicks in a corner.
 */

export interface MenuBox {
  /** Where the pointer was. */
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Kept clear of the window edge, so the menu never looks glued to it. */
  margin?: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** Which way it actually opened, so a caller can animate from the right corner. */
  flippedX: boolean;
  flippedY: boolean;
}

export function placeMenu(box: MenuBox): MenuPlacement {
  const margin = box.margin ?? 6;

  const fitsRight = box.x + box.menuWidth + margin <= box.viewportWidth;
  const fitsLeft = box.x - box.menuWidth - margin >= 0;
  // Flip only when the other side genuinely has room. A menu wider than the window has no good
  // side, and pinning it to the left edge at least keeps its first characters readable.
  const flippedX = !fitsRight && fitsLeft;
  const flippedY =
    !(box.y + box.menuHeight + margin <= box.viewportHeight) &&
    box.y - box.menuHeight - margin >= 0;

  const left = flippedX ? box.x - box.menuWidth : box.x;
  const top = flippedY ? box.y - box.menuHeight : box.y;

  return {
    left: clamp(left, margin, Math.max(margin, box.viewportWidth - box.menuWidth - margin)),
    top: clamp(top, margin, Math.max(margin, box.viewportHeight - box.menuHeight - margin)),
    flippedX,
    flippedY,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
