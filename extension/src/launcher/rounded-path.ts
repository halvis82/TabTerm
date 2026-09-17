/**
 * A rectilinear outline with every corner rounded, inward ones included.
 *
 * The colour behind a tab is not always a rectangle: a tab of seven panes is three across and
 * three down with one card on the last row, so its outline turns back on itself and has an inward
 * corner. `clip-path: polygon()` draws that shape with knife edges, which is what he saw.
 *
 * So the outline is drawn rather than clipped. Each corner is cut back by the radius along both of
 * its edges and joined with an arc, and which way the arc bends is read from the turn itself: a
 * corner that turns the same way as the rest of the outline is convex and bulges out, one that
 * turns the other way is the inward corner and bends in. Nothing has to be told which is which,
 * which is what keeps this honest for shapes nobody has thought of yet.
 *
 * Points are in the order the outline is walked, and the shape is closed. Screen coordinates, so
 * y grows downwards and a clockwise walk turns positive.
 */
export interface Point {
  x: number;
  y: number;
}

export function roundedPath(points: readonly Point[], radius: number): string {
  if (points.length < 3) return '';

  const at = (index: number): Point => {
    const point = points[(index + points.length) % points.length];
    return point ?? { x: 0, y: 0 };
  };

  const parts: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = at(i - 1);
    const corner = at(i);
    const next = at(i + 1);

    const into = { x: corner.x - previous.x, y: corner.y - previous.y };
    const away = { x: next.x - corner.x, y: next.y - corner.y };
    const intoLength = Math.hypot(into.x, into.y);
    const awayLength = Math.hypot(away.x, away.y);
    if (intoLength === 0 || awayLength === 0) continue;

    /*
     * Never more than half of either edge, or two corners of a short edge would each want the
     * same pixels and the outline would fold back on itself.
     */
    const r = Math.max(0, Math.min(radius, intoLength / 2, awayLength / 2));
    const enter = {
      x: corner.x - (into.x / intoLength) * r,
      y: corner.y - (into.y / intoLength) * r,
    };
    const leave = {
      x: corner.x + (away.x / awayLength) * r,
      y: corner.y + (away.y / awayLength) * r,
    };

    // Which way this corner turns. Positive is clockwise on a screen, where y grows downwards.
    const turn = into.x * away.y - into.y * away.x;
    const sweep = turn > 0 ? 1 : 0;

    parts.push(
      `${parts.length === 0 ? 'M' : 'L'} ${round(enter.x)} ${round(enter.y)}`,
      r === 0
        ? `L ${round(leave.x)} ${round(leave.y)}`
        : `A ${round(r)} ${round(r)} 0 0 ${String(sweep)} ${round(leave.x)} ${round(leave.y)}`,
    );
  }

  return parts.length === 0 ? '' : `${parts.join(' ')} Z`;
}

/** Two decimals is finer than a pixel and keeps the attribute readable. */
function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
