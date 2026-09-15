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

/**
 * Whether a measurement taken now is worth moving a terminal for.
 *
 * A grid is the room a pane has divided by the cell its **renderer** believes in, and the two
 * renderers do not agree: 7.83 against 7.5, which is 187 columns against 195 for the same box. So
 * the question is never "how big is this pane" on its own. It is "is the thing that decides the
 * cell the thing that will still be deciding it a moment from now".
 *
 * Two moments when the answer is no, and they are the same moment wearing different clothes:
 *
 * - **Starting up**, when every tab re-attaches at once and they contend for a capped number of
 *   GPU contexts. The ones that lose measure with the DOM renderer and correct themselves later
 * - **Coming back**, when a hidden tab has handed its context back on purpose and is waiting for
 *   another. This is the one that was missed. The grace was counted from when the pane was built,
 *   so a pane an hour old was trusted the instant its renderer was taken away, and a window
 *   resized while the tab was hidden went to the daemon in DOM columns and back in WebGL ones a
 *   second later. Two resizes for a window the person moved once, and an agent redraws its whole
 *   interface for each
 *
 * Waiting, never refusing. A pane that is never given a context must still be able to follow the
 * window, so the wait expires and the measurement is believed. While it waits nothing is broken:
 * the pane draws, and the daemon's size is the one that counts.
 */
export function measurementIsTrustworthy(state: {
  rendererAttached: boolean;
  /** When this pane started waiting for a renderer, or null when it is not waiting for one. */
  waitingSince: number | null;
  graceMs: number;
  now: number;
}): boolean {
  if (state.rendererAttached) return true;
  if (state.waitingSince === null) return true;
  return state.now - state.waitingSince > state.graceMs;
}
