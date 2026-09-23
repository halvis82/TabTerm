/**
 * How far a scroll moves the terminal, in rows, from how far the pointer moved, in pixels.
 *
 * A trackpad sends a stream of small pixel deltas, a few at a time, and the natural thing for a
 * terminal to do with them is move the content by exactly that many pixels. The emulator's own
 * answer is not that: it converts to rows, and then **damps anything under fifty pixels to thirty
 * percent** of itself. A wheel mouse never notices, because one notch is a hundred pixels or more.
 * A trackpad is nothing but small deltas, so a slow drag barely moves and a fast flick suddenly
 * moves properly, which is what "scrolling is weird and unnatural" is made of.
 *
 * So the pixels are taken at face value and the remainder is carried. Scrolling half a row twice
 * moves one row, which is what every other scroller on the machine does.
 *
 * Only pixel deltas. A wheel mouse reports in lines or pages and the emulator's handling of those
 * is right: a notch is a notch.
 */
export class WheelRows {
  /** The part of a row left over from the last scroll, carried rather than thrown away. */
  #carried = 0;

  /**
   * Rows to scroll for this much pointer movement, positive being towards the newest output.
   *
   * `cellHeight` is what a row measures on screen. A height of zero means the terminal has not
   * been laid out, and the honest answer then is to do nothing rather than divide by it.
   */
  take(deltaPixels: number, cellHeight: number): number {
    if (cellHeight < 1 || deltaPixels === 0) return 0;
    this.#carried += deltaPixels / cellHeight;
    const whole = Math.trunc(this.#carried);
    this.#carried -= whole;
    // Plus zero, so half a row up and half a row back answers zero rather than negative zero,
    // which is the same number everywhere except in a comparison.
    return whole + 0;
  }

  /** Forget the remainder, for when the scroll it belonged to is over. */
  reset(): void {
    this.#carried = 0;
  }
}
