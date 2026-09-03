/**
 * Flashing the tab icon when a command finishes, per session.
 *
 * A notification is the right tool when you are in another application. This is for when you are
 * in another **tab**: something you can catch out of the corner of your eye without anything
 * appearing over what you are doing.
 *
 * **Kept per session, not per tab.** A tab can hold several terminals and a terminal can be
 * moved to a tab of its own later; the setting belongs to the thing that finishes commands. It
 * lives in extension storage beside the highlights, for the same reason: it describes how
 * somebody wants their own view to behave, and the daemon owns sessions rather than taste.
 *
 * **What Chrome allows.** A hidden tab's timers are throttled: about one a second at first, and
 * roughly one a minute once the tab has been hidden for five minutes. So the flash is brisk for
 * the first few minutes and then becomes a slow blink. That is a limit of the platform rather
 * than a choice, and it is still far better than a static icon, because the thing being
 * signalled is "this happened while you were away" rather than "this is happening now".
 */

const KEY = 'tabterm.flashOnFinish';

export async function flashingSessions(): Promise<Set<string>> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const list: unknown = stored[KEY];
    return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export async function setFlashing(sessionId: string, on: boolean): Promise<void> {
  try {
    const current = await flashingSessions();
    if (on) current.add(sessionId);
    else current.delete(sessionId);
    await chrome.storage.local.set({ [KEY]: [...current] });
  } catch {
    // A preference that could not be saved is worth less than the terminal still working.
  }
}

/**
 * Two colors, alternating, until somebody looks.
 *
 * Stopped by the tab being looked at, and, when it is already the tab in front, by any sign of
 * a person: a key, a click, the pointer moving, or leaving. Idling on the tab is not noticing,
 * which is why visibility alone is not enough to call it seen.
 */
export class TabFlasher {
  #timer = 0;
  #phase = 0;
  #stopListening: (() => void) | null = null;
  readonly #paint: (on: boolean) => void;

  constructor(paint: (on: boolean) => void) {
    this.#paint = paint;
  }

  get flashing(): boolean {
    return this.#timer !== 0;
  }

  start(): void {
    this.stop();
    this.#phase = 0;
    this.#timer = window.setInterval(() => {
      this.#phase++;
      this.#paint(this.#phase % 2 === 0);
    }, 650);

    const seen = (): void => this.stop();
    const events: [target: EventTarget, name: string][] = [
      [document, 'visibilitychange'],
      [window, 'pointermove'],
      [window, 'pointerdown'],
      [window, 'keydown'],
      [window, 'blur'],
    ];
    const onEvent = (): void => {
      // Becoming hidden is not being noticed: that is somebody leaving, and the whole point is
      // that it is still flashing when they come back.
      if (document.visibilityState === 'hidden') return;
      seen();
    };
    for (const [target, name] of events) target.addEventListener(name, onEvent);
    this.#stopListening = () => {
      for (const [target, name] of events) target.removeEventListener(name, onEvent);
    };
  }

  stop(): void {
    if (this.#timer !== 0) {
      clearInterval(this.#timer);
      this.#timer = 0;
      this.#paint(false);
    }
    this.#stopListening?.();
    this.#stopListening = null;
  }
}
