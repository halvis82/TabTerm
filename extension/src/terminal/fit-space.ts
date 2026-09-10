/**
 * The space a pane's grid was worked out against.
 *
 * A terminal's size has to follow the space it is given and nothing else. In particular it must
 * not follow the renderer: `proposeDimensions` divides the box by the renderer's cell width, and
 * the DOM and WebGL renderers disagree about that width, because one reports the font's advance
 * and the other reports it snapped to whole device pixels. On a Retina screen that is 7.83 against
 * 7.5, so the same box proposes 187 columns under one and 195 under the other.
 *
 * The renderer is not ours to hold still. It is released while a tab is hidden, and Chrome revokes
 * a context when another page wants one. Both were arriving at the daemon as a resize, which is
 * the one thing an in-place renderer cannot survive. See docs/07-terminal-fidelity.md.
 */
export interface FitSpace {
  width: number;
  height: number;
}

/**
 * The room a pane actually has, to whole pixels.
 *
 * The content box rather than the border box, because that is what the fit addon divides: it takes
 * the parent's client size and subtracts its padding. Keying on the outer box instead looks right
 * and is not, since the start screen leaves a pane the same bounding box and changes the padding
 * around the strip the terminal is squeezed into. A pane fitted to three rows then stayed at three
 * rows after something was launched into it, because from the outside nothing had moved.
 */
export function contentSpace(
  client: { width: number; height: number },
  padding: { left: number; right: number; top: number; bottom: number },
): FitSpace {
  return {
    width: Math.round(client.width - padding.left - padding.right),
    height: Math.round(client.height - padding.top - padding.bottom),
  };
}

/** Whether a pane has been given different space than the one its grid was worked out against. */
export function spaceChanged(fittedTo: FitSpace | null, now: FitSpace): boolean {
  if (fittedTo === null) return true;
  return fittedTo.width !== now.width || fittedTo.height !== now.height;
}

/** Whether a box can be measured at all. A pane that is not laid out has no space to report. */
export function measurable(space: FitSpace): boolean {
  return space.width >= 1 && space.height >= 1;
}

/**
 * Whether a proposal is small enough to be the renderer changing its mind rather than the pane
 * changing size.
 *
 * The two renderers disagree about the cell by a few percent: 7.83 against 7.5, which is 187
 * columns against 195, a shade over four. A pane that is genuinely holding a different amount is
 * not off by a few percent, it is off by a factor. A pane measured while it was still the strip
 * under a start screen proposed three rows where the truth was forty four.
 *
 * Freezing on the space alone was tried and is wrong, because it makes an early bad measurement
 * permanent: under load the first fit landed on the strip and the pane stayed three rows high for
 * good. So the size is held against small disagreements and always yields to large ones.
 */
export const RENDERER_DISAGREEMENT = 0.1;

export function withinRendererNoise(
  current: { cols: number; rows: number },
  proposed: { cols: number; rows: number },
): boolean {
  const near = (a: number, b: number): boolean =>
    a > 0 && Math.abs(a - b) / a <= RENDERER_DISAGREEMENT;
  return near(current.cols, proposed.cols) && near(current.rows, proposed.rows);
}
