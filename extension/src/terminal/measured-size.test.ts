import { describe, expect, it } from 'vitest';
import { trustMeasurement } from './measured-size.js';

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
