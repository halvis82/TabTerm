import { describe, expect, it } from 'vitest';
import { contentSpace, measurable, spaceChanged, withinRendererNoise } from './fit-space.js';

/**
 * The rule that keeps a renderer swap from resizing a running program.
 *
 * A pane whose box has not moved keeps the size it has, whatever the addon now proposes. The
 * proposal moves when the renderer does, and a resize is what scrambles an agent drawing in place.
 */
describe('deciding whether a pane may be resized', () => {
  it('says yes the first time, because nothing has been worked out yet', () => {
    expect(spaceChanged(null, { width: 1463, height: 792 })).toBe(true);
  });

  it('says no when the space is the same, whatever the renderer now proposes', () => {
    const fitted = { width: 1463, height: 792 };
    expect(spaceChanged(fitted, { width: 1463, height: 792 })).toBe(false);
  });

  it('says yes when the pane is genuinely given more or less room', () => {
    const fitted = { width: 1463, height: 792 };
    expect(spaceChanged(fitted, { width: 1200, height: 792 })).toBe(true);
    expect(spaceChanged(fitted, { width: 1463, height: 600 })).toBe(true);
  });

  it('ignores a fraction of a pixel, which is not a change in the space available', () => {
    const none = { left: 0, right: 0, top: 0, bottom: 0 };
    // A box read back as 1463.4 and then 1463.2 is the same box, and rounding is what says so.
    expect(
      spaceChanged(
        contentSpace({ width: 1463.4, height: 792.1 }, none),
        contentSpace({ width: 1463.2, height: 791.9 }, none),
      ),
    ).toBe(false);
  });

  it('follows padding, because that is the room the start screen takes and gives back', () => {
    // Same bounding box, a strip for the terminal and then the whole pane. This is the regression
    // that left a launched pane stuck at three rows: from the outside nothing had moved.
    const box = { width: 1463, height: 457 };
    const strip = contentSpace(box, { left: 0, right: 0, top: 400, bottom: 0 });
    const whole = contentSpace(box, { left: 0, right: 0, top: 0, bottom: 0 });
    expect(strip.height).toBe(57);
    expect(whole.height).toBe(457);
    expect(spaceChanged(strip, whole)).toBe(true);
  });

  it('treats a pane that is not laid out as unmeasurable rather than as zero sized', () => {
    expect(measurable({ width: 0, height: 0 })).toBe(false);
    expect(measurable({ width: 0, height: 800 })).toBe(false);
    expect(measurable({ width: 1463, height: 792 })).toBe(true);
  });
});

describe('telling a renderer changing its mind from a pane changing size', () => {
  it('calls the renderer disagreement small, so the size is kept', () => {
    // 7.83 against 7.5 for the same box, which is what a renderer swap looks like.
    expect(withinRendererNoise({ cols: 187, rows: 44 }, { cols: 195, rows: 44 })).toBe(true);
    expect(withinRendererNoise({ cols: 195, rows: 44 }, { cols: 187, rows: 44 })).toBe(true);
  });

  it('calls a pane that was measured as a strip a real change, so it is corrected', () => {
    // The regression this exists for: a pane fitted while the start screen still had the room.
    expect(withinRendererNoise({ cols: 187, rows: 3 }, { cols: 187, rows: 44 })).toBe(false);
  });

  it('lets a genuine resize through', () => {
    expect(withinRendererNoise({ cols: 195, rows: 44 }, { cols: 120, rows: 44 })).toBe(false);
    expect(withinRendererNoise({ cols: 195, rows: 44 }, { cols: 195, rows: 20 })).toBe(false);
  });

  it('never divides by a size a terminal cannot have', () => {
    expect(withinRendererNoise({ cols: 0, rows: 0 }, { cols: 195, rows: 44 })).toBe(false);
  });
});
