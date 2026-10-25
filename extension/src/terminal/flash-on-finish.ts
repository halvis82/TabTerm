import type { FaviconState } from './titles.js';
import { isSticky, needsAttention } from './status-machine.js';

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
    return new Set(
      Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [],
    );
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
  readonly #restore: () => void;

  /**
   * Two callbacks, because stopping is not a third frame of the flash.
   *
   * It used to stop by painting its own off frame, which is one of the two attention icons, so
   * a tab that had been noticed sat on a green tick forever: the ordinary painter declines to
   * draw while a flash is running, and nothing told it the flash had ended.
   */
  constructor(paint: (on: boolean) => void, restore: () => void) {
    this.#paint = paint;
    this.#restore = restore;
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
      /**
       * Brisk, and then brisker.
       *
       * 650ms read as a slow pulse rather than as something wanting attention. 420 was still
       * too slow to catch out of the corner of an eye, so this is 40 per cent faster again. A
       * hidden tab's throttling stretches whatever is chosen here, which is a reason to ask for
       * a shorter interval rather than a longer one.
       */
    }, 250);

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
      // Cleared before restoring, so whatever repaints sees a flash that is no longer running.
      this.#restore();
    }
    this.#stopListening?.();
    this.#stopListening = null;
  }
}

/**
 * The pane that finished, marked in the page as well as in the icon.
 *
 * Asked for because somebody already on the tab is looking at the terminal and not at the icon,
 * and in a tab of several panes the icon cannot say which pane it was. So the pane itself glows
 * along its edge, pulsing a few times and then holding faintly, green for a success and red for a
 * failure. It follows the same per-session setting as the flash, and goes the same way: the first
 * key, click or movement of the pointer on the tab.
 *
 * A short grace for movement only, because a pointer already moving when the command ends would
 * otherwise take the glow away before it had been drawn once. A key or a click is always meant.
 */
const GLOW_GRACE_MS = 500;

export class PaneGlow {
  readonly #panes = new Set<HTMLElement>();
  #since = 0;
  #stopListening: (() => void) | null = null;

  /** Panes glowing now, for a check to read. */
  get glowing(): HTMLElement[] {
    return [...this.#panes];
  }

  glow(pane: HTMLElement, failed: boolean): void {
    pane.classList.remove('finish-glow', 'is-failed');
    // Read back, so a pane that glows again restarts its pulses rather than holding.
    void pane.offsetWidth;
    pane.classList.add('finish-glow');
    pane.classList.toggle('is-failed', failed);
    this.#panes.add(pane);
    this.#since = performance.now();
    if (this.#stopListening) return;

    const onEvent = (e: Event): void => {
      if (document.visibilityState === 'hidden') return;
      if (e.type === 'pointermove' && performance.now() - this.#since < GLOW_GRACE_MS) return;
      this.clear();
    };
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel'];
    for (const name of events) window.addEventListener(name, onEvent, true);
    this.#stopListening = () => {
      for (const name of events) window.removeEventListener(name, onEvent, true);
    };
  }

  clear(): void {
    for (const pane of this.#panes) pane.classList.remove('finish-glow', 'is-failed');
    this.#panes.clear();
    this.#stopListening?.();
    this.#stopListening = null;
  }
}

/**
 * One frame of the flash, as the slices of the icon.
 *
 * A tab of one pane flashes its whole icon. A tab of several keeps the split icon and flashes only
 * the half that finished, so the other half still says what its pane is doing. Asked for as the
 * flash being "compatible with the split screen icon". The half that finished is the one whose
 * state is waiting to be seen, an outcome or a request; the first half when none is.
 */
export function flashFrame(picture: readonly FaviconState[], on: boolean): FaviconState[] {
  const flash: FaviconState = on ? 'attention' : 'attention-alt';
  if (picture.length < 2) return [flash];
  const finished = picture.findIndex((s) => isSticky(s) || needsAttention(s));
  return picture.map((s, i) => (i === (finished === -1 ? 0 : finished) ? flash : s));
}
