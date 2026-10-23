import type { IBufferRange, IDisposable, Terminal } from '@xterm/xterm';

/**
 * A copy button that appears beside a link while Command is held over it.
 *
 * Holding Command over a URL or a path already lights it up and makes it clickable. Asked for:
 * "can we just have a very dynamic copy button appear next to it very smooth looking and
 * disappears if we let go of cmd". So the same moment that offers to open a link offers to copy
 * it, without a trip to the right-click menu.
 *
 * One button for the whole page, placed against the cell where the link ends. It copies the link
 * as it reads on screen, which is what somebody pointing at it expects to get. It fades in and
 * out rather than popping, and it goes the moment it stops being about the thing under the
 * pointer: Command let go, the pointer gone somewhere else, the screen scrolled under it.
 */

/** Long enough to move the pointer from the end of a link onto the button beside it. */
const GRACE_MS = 220;
/** How long "copied" is shown before the button goes. */
const COPIED_MS = 650;
/** The fade, kept in step with the CSS transition. */
const FADE_MS = 140;

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class LinkCopyButton {
  readonly #el: HTMLButtonElement;
  #text = '';
  #hideTimer: number | undefined;
  #removeTimer: number | undefined;
  #watching: IDisposable[] = [];
  #copied = false;
  #pointerOn = false;

  constructor(root: HTMLElement = document.body) {
    this.#el = document.createElement('button');
    this.#el.className = 'link-copy';
    this.#el.type = 'button';
    this.#el.hidden = true;
    this.#el.tabIndex = -1;
    this.#reset();
    // Never takes the keyboard from the terminal: the press is the whole interaction.
    this.#el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.#el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#copy();
    });
    /*
     * Whether the pointer is on the button, read when the grace runs out rather than relied on to
     * cancel it. The terminal hears the pointer leave it after the button hears it arrive, so a
     * cancel on arrival was undone by the leave that followed it.
     */
    this.#el.addEventListener('pointerenter', () => {
      this.#pointerOn = true;
      clearTimeout(this.#hideTimer);
    });
    this.#el.addEventListener('pointerleave', () => {
      this.#pointerOn = false;
      this.hideSoon();
    });
    root.append(this.#el);
  }

  /** What is being offered, for a check to read. */
  get state(): { shown: boolean; text: string; copied: boolean } {
    return {
      shown: this.#el.classList.contains('is-shown'),
      text: this.#text,
      copied: this.#copied,
    };
  }

  /** Offer to copy `text`, placed just after the end of `range` in `term`. */
  show(term: Terminal, range: IBufferRange, text: string): void {
    if (this.#copied) return;
    clearTimeout(this.#hideTimer);
    clearTimeout(this.#removeTimer);
    const place = placeAfter(term, range);
    if (!place) return;
    if (this.#text !== text) this.#reset();
    this.#text = text;
    this.#el.title = `Copy ${text}`;
    this.#el.style.left = `${String(Math.round(place.x))}px`;
    this.#el.style.top = `${String(Math.round(place.y))}px`;
    this.#el.hidden = false;
    // The next frame, so the fade has a starting point to fade from.
    requestAnimationFrame(() => this.#el.classList.add('is-shown'));

    for (const d of this.#watching) d.dispose();
    // A screen that moves takes the link out from under the button.
    this.#watching = [term.onScroll(() => this.hide()), term.onResize(() => this.hide())];
  }

  /** The pointer left the link. Wait a moment, in case it is on its way to the button. */
  hideSoon(): void {
    if (this.#copied) return;
    clearTimeout(this.#hideTimer);
    this.#hideTimer = window.setTimeout(() => {
      if (!this.#pointerOn) this.hide();
    }, GRACE_MS);
  }

  /** Fade out now: Command was let go, or what it pointed at moved. */
  hide(): void {
    clearTimeout(this.#hideTimer);
    for (const d of this.#watching) d.dispose();
    this.#watching = [];
    if (this.#el.hidden) return;
    this.#el.classList.remove('is-shown');
    clearTimeout(this.#removeTimer);
    this.#removeTimer = window.setTimeout(() => {
      this.#el.hidden = true;
      this.#copied = false;
      this.#pointerOn = false;
      this.#reset();
    }, FADE_MS);
  }

  #copy(): void {
    if (this.#copied || this.#text === '') return;
    this.#copied = true;
    void navigator.clipboard.writeText(this.#text).catch(() => undefined);
    this.#el.classList.add('is-copied');
    this.#el.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
    clearTimeout(this.#hideTimer);
    // Then it goes, the same fade as any other way of leaving. Nothing can bring it back
    // until it has, since `show` waits for `#copied` to clear at the end of the fade.
    this.#hideTimer = window.setTimeout(() => this.hide(), COPIED_MS);
  }

  #reset(): void {
    this.#el.classList.remove('is-copied');
    this.#el.innerHTML = `${COPY_ICON}<span>Copy</span>`;
  }
}

/**
 * Where the button goes for a link: just after its last cell, centered on that row.
 *
 * Above the end of the link instead when the row has no room left to the right, so it is never
 * pushed off the edge of the pane. Null when the link is not on screen.
 */
function placeAfter(term: Terminal, range: IBufferRange): { x: number; y: number } | null {
  const screen = term.element?.querySelector('.xterm-screen');
  if (!(screen instanceof HTMLElement)) return null;
  const box = screen.getBoundingClientRect();
  if (box.width === 0 || term.cols === 0 || term.rows === 0) return null;
  const cellW = box.width / term.cols;
  const cellH = box.height / term.rows;
  const row = range.end.y - 1 - term.buffer.active.viewportY;
  if (row < 0 || row >= term.rows) return null;
  const width = 64;
  const rowTop = box.top + row * cellH;
  const after = box.left + range.end.x * cellW + 6;
  if (after + width <= box.right) return { x: after, y: rowTop + cellH / 2 };
  return {
    x: Math.max(box.left, box.left + range.end.x * cellW - width),
    y: rowTop - cellH / 2 - 4,
  };
}
