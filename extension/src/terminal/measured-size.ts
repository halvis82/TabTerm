/**
 * Whether a grid measured at attach is worth moving a terminal for.
 *
 * A grid is the room a pane has divided by the cell the **renderer** believes in, and those two
 * renderers do not agree: the DOM one reports the font's advance, the WebGL one reports it snapped
 * to whole device pixels. Read out of a real session, 7.83 against 7.5, which is 187 columns
 * against 195 for the same box.
 *
 * Attaching is exactly when the WebGL one may not be there yet. Every tab re-attaches at once when
 * the extension reloads or the daemon restarts, they contend for a capped number of GPU contexts,
 * and the ones that lose measure with the DOM renderer and then correct themselves a moment later.
 * That correction is a resize, and a resize is the one thing a program redrawing in place cannot
 * survive.
 *
 * The daemon already knows what to do with a size that is not worth believing: it keeps the size
 * the session has and tells the page, which follows it. That path was only ever reached when a
 * pane could not be measured at all. This is the other case, a measurement taken too early, and it
 * needs the same treatment.
 */
export interface MeasuredSize {
  cols: number;
  rows: number;
  estimated?: true;
}

export function trustMeasurement(
  size: { cols: number; rows: number },
  rendererReady: boolean,
): MeasuredSize {
  return rendererReady ? { cols: size.cols, rows: size.rows } : { ...size, estimated: true };
}
