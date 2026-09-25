/**
 * What each part of the start screen last said, so a part that says it again is recognised.
 *
 * Every part of this screen arrives whenever it **might** have changed rather than when it did:
 * a tab opening anywhere, a session starting, a folder being recorded. The screen rebuilds every
 * control it draws, so a press landing while a row is being replaced reaches nothing at all, and
 * anything half typed has to be carried across by hand. Saying the same thing again is not news
 * and must not cost a drawing.
 *
 * A separate thing from the screen so the rule can be checked without a browser, and so the two
 * places that need it cannot disagree about what "the same" means.
 */
export class RepeatedAnswers {
  readonly #saidBefore = new Map<string, string>();

  /**
   * True when this part is saying something new, which is the only time a drawing is owed.
   *
   * Compared as JSON, which is exact for the shapes this carries and makes no claim about order:
   * a list in a different order **is** different, because the screen would draw it differently.
   */
  isNews(key: string, value: unknown): boolean {
    const now = JSON.stringify(value) ?? '';
    if (this.#saidBefore.get(key) === now) return false;
    this.#saidBefore.set(key, now);
    return true;
  }

  /** Forget everything, for a screen that is starting again rather than carrying on. */
  reset(): void {
    this.#saidBefore.clear();
  }
}
