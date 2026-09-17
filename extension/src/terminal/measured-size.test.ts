import { describe, expect, it } from 'vitest';
import { measurementIsTrustworthy, trustMeasurement } from './measured-size.js';

describe('a grid measured while attaching', () => {
  it('is believed once the renderer that decides the cell is there', () => {
    expect(trustMeasurement({ cols: 195, rows: 44 }, true)).toEqual({ cols: 195, rows: 44 });
  });

  it('is offered rather than applied when it is not', () => {
    // 187 is what the same box measures under the DOM renderer's cell. The daemon keeps the size
    // the session already has and tells this page, rather than resizing a running program.
    expect(trustMeasurement({ cols: 187, rows: 44 }, false)).toEqual({
      cols: 187,
      rows: 44,
      estimated: true,
    });
  });

  it('still carries a size, since a session being created has nothing else to go on', () => {
    const offered = trustMeasurement({ cols: 187, rows: 44 }, false);
    expect(offered.cols).toBe(187);
    expect(offered.rows).toBe(44);
  });
});

describe('measurementIsTrustworthy', () => {
  const grace = { graceMs: 10_000, now: 100_000 };

  it('believes a pane whose renderer is attached', () => {
    expect(
      measurementIsTrustworthy({ ...grace, rendererAttached: true, waitingSince: 99_999 }),
    ).toBe(true);
  });

  it('does not believe a pane that is still waiting for one', () => {
    expect(
      measurementIsTrustworthy({ ...grace, rendererAttached: false, waitingSince: 95_000 }),
    ).toBe(false);
  });

  /*
   * The case this function was extracted for.
   *
   * A hidden tab gives its context back on purpose, so a pane an hour old starts waiting again.
   * The grace used to be counted from when the pane was built, which meant an old pane was
   * trusted the instant its renderer was taken away, and measured the window with a cell that was
   * about to be replaced.
   */
  it('and an old pane that has just given its renderer back is waiting like any other', () => {
    const justReleased = grace.now - 50;
    expect(
      measurementIsTrustworthy({ ...grace, rendererAttached: false, waitingSince: justReleased }),
    ).toBe(false);
  });

  /*
   * Waiting, never refusing. A pane on a machine that will not give it a context must still be
   * able to follow the window, so the wait runs out and the measurement is believed.
   */
  it('believes a pane that has waited long enough, because one may never arrive', () => {
    expect(
      measurementIsTrustworthy({ ...grace, rendererAttached: false, waitingSince: 80_000 }),
    ).toBe(true);
  });

  it('and believes a pane that is not waiting for anything', () => {
    expect(
      measurementIsTrustworthy({ ...grace, rendererAttached: false, waitingSince: null }),
    ).toBe(true);
  });
});

/**
 * How long waiting is worth it depends on whether anything is coming.
 *
 * A machine with no WebGL never produces a renderer, and a pane there has to be believed
 * eventually or it could never follow the window. A machine that has produced one before is a
 * different case: the context is a moment away, and believing the DOM renderer's cell in the
 * meantime is how a terminal gets moved four percent and moved back. Read out of a real log: one
 * pane went 174 columns, attach 167, back to 174, on every single reattach.
 */
describe('waiting for a renderer that is actually coming', () => {
  const base = { rendererAttached: false, waitingSince: 1000, graceMs: 10_000 };

  it('believes the measurement once the grace is up, when nothing is coming', () => {
    expect(measurementIsTrustworthy({ ...base, now: 1000 + 10_001 })).toBe(true);
  });

  it('and waits longer when this browser is known to give out contexts', () => {
    expect(measurementIsTrustworthy({ ...base, now: 1000 + 10_001, rendererExpected: true })).toBe(
      false,
    );
  });

  /*
   * Longer, not forever. A pane can lose the race permanently when a browser runs out of
   * contexts, and one that never resizes again would be worse than one that resizes late.
   */
  it('and gives up on it in the end, so a pane always follows its window', () => {
    expect(measurementIsTrustworthy({ ...base, now: 1000 + 30_001, rendererExpected: true })).toBe(
      true,
    );
  });

  it('and a renderer that is here settles it whatever anybody expected', () => {
    expect(
      measurementIsTrustworthy({
        ...base,
        rendererAttached: true,
        now: 1000,
        rendererExpected: true,
      }),
    ).toBe(true);
  });
});
