import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LABEL_OPACITY,
  DEFAULT_LABEL_SCALE,
  obscuresOutput,
  saneOpacity,
  saneScale,
} from './label-look.js';

/**
 * How the name drawn over a pane looks, which somebody asked to be able to change.
 *
 * It is faint on purpose: it says which session this is without competing with what the session is
 * saying. How faint is a judgement about a screen and a pair of eyes, so it is a setting, and the
 * warning exists because far enough up it stops being a watermark and becomes something to read
 * past.
 */
describe('the settings for the name drawn over a pane', () => {
  it('leaves a profile that has never touched them exactly as it was', () => {
    expect(saneOpacity(undefined)).toBe(DEFAULT_LABEL_OPACITY);
    expect(saneScale(undefined)).toBe(DEFAULT_LABEL_SCALE);
  });

  /*
   * These reach a stylesheet, so anything that is not a number has to become one rather than
   * being written out as it arrived.
   */
  it('and turns anything that is not a number back into the default', () => {
    expect(saneOpacity('not a number')).toBe(DEFAULT_LABEL_OPACITY);
    expect(saneScale({})).toBe(DEFAULT_LABEL_SCALE);
    expect(saneOpacity(Number.NaN)).toBe(DEFAULT_LABEL_OPACITY);
  });

  it('allows the name to be turned off entirely', () => {
    expect(saneOpacity(0)).toBe(0);
  });

  /*
   * Bounded at the top, because a name at full strength over a terminal is a name instead of a
   * terminal, and the setting is meant to make it easier to read rather than to hide the output.
   */
  it('but never lets it become the thing you are reading', () => {
    expect(saneOpacity(5)).toBeLessThanOrEqual(0.9);
    expect(saneScale(99)).toBeLessThanOrEqual(2);
    expect(saneScale(0)).toBeGreaterThanOrEqual(0.4);
  });

  it('warns once the name is strong enough to sit over the output', () => {
    expect(obscuresOutput(DEFAULT_LABEL_OPACITY)).toBe(false);
    expect(obscuresOutput(0.3)).toBe(false);
    expect(obscuresOutput(0.45)).toBe(true);
    expect(obscuresOutput(0.6)).toBe(true);
  });
});
