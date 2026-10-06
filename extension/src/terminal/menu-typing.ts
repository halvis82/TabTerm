/**
 * Choosing an entry in an open menu by typing at it.
 *
 * A menu is opened with the mouse and then, often, the hand is already on the keyboard. Typing
 * `n` picks the first entry beginning with `n`, typing `name` narrows to the one that is, and
 * Return runs it. It is the behavior of every native menu on this machine, and it is the reason
 * the keystrokes must not reach the terminal underneath: what somebody types at a menu is aimed
 * at the menu.
 *
 * Kept apart from the menu element so the rule can be checked without a browser, and so the two
 * menus this product draws cannot disagree about it.
 */

/** What is being typed at a menu right now, and which entry that lands on. */
export class MenuTyping {
  #typed = '';
  #lastAt = 0;

  /**
   * Two seconds without a key, and what was typed is forgotten.
   *
   * Asked for as two seconds. Any key counts as typing, including one that matched nothing, so
   * the pause is measured from the last thing somebody pressed rather than the last thing that
   * landed. The entry that was found stays outlined past the pause: forgetting the letters is
   * not the same as losing the place, and only a new match moves it.
   */
  static readonly FORGET_AFTER_MS = 2000;

  /** What has been typed so far, for a caller that wants to show it. */
  get typed(): string {
    return this.#typed;
  }

  /**
   * Take a character and say which entry it lands on, or -1 when nothing new was found.
   *
   * A character that matches nothing is **dropped**, rather than added to the prefix. Otherwise
   * one stray key makes every later keystroke miss too, which reads as the feature breaking; the
   * entry somebody had already narrowed to stays where it was, and -1 here means "leave the
   * outline where it is", never "take it away".
   */
  type(
    character: string,
    labels: readonly string[],
    now = Date.now(),
    enabled?: readonly boolean[],
  ): number {
    if (now - this.#lastAt > MenuTyping.FORGET_AFTER_MS) this.#typed = '';
    this.#lastAt = now;
    const attempt = this.#typed + character.toLowerCase();
    const hit = MenuTyping.match(attempt, labels, enabled);
    if (hit === -1) return -1;
    this.#typed = attempt;
    return hit;
  }

  /** Take the last character back, for somebody who mistyped one letter of a longer word. */
  backspace(labels: readonly string[], enabled?: readonly boolean[]): number {
    this.#typed = this.#typed.slice(0, -1);
    this.#lastAt = Date.now();
    return this.#typed === '' ? -1 : MenuTyping.match(this.#typed, labels, enabled);
  }

  /** Start again, for when the menu has been used or moved on from. */
  reset(): void {
    this.#typed = '';
    this.#lastAt = 0;
  }

  /**
   * The first entry that begins with what was typed, or -1.
   *
   * Beginning with, not containing: that is what a menu does everywhere, and "containing" makes
   * the entry that lights up unpredictable from the letters typed. A disabled entry is never the
   * answer, because choosing it would do nothing and the typing would look broken.
   */
  static match(typed: string, labels: readonly string[], enabled?: readonly boolean[]): number {
    if (typed === '') return -1;
    const wanted = typed.toLowerCase();
    for (const [i, label] of labels.entries()) {
      if (enabled && enabled[i] === false) continue;
      if (label.trim().toLowerCase().startsWith(wanted)) return i;
    }
    return -1;
  }
}

/** Whether a key press is somebody typing at the menu rather than reaching for a shortcut. */
export function isTypedAtMenu(key: string, ctrl: boolean, meta: boolean, alt: boolean): boolean {
  if (ctrl || meta || alt) return false;
  // One character, so Shift+a and a space count, and every named key (Tab, ArrowUp, F5, Enter)
  // does not: those have names longer than themselves.
  return [...key].length === 1;
}
