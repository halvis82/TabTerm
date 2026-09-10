/**
 * Dropping a file onto a TabTerm window.
 *
 * A native terminal is handed the path of a dragged file and types it. A web page is not: Chrome
 * gives the page the bytes and the name and withholds where the file came from, on purpose. So the
 * copy the daemon writes is the path, and this half decides what a drag means and what lands at
 * the prompt.
 *
 * Kept apart from the page so both decisions can be tested without a browser.
 */

/** As many as one drop may carry, so a folder emptied onto the window cannot flood a prompt. */
export const MAX_DROPPED_FILES = 8;

/**
 * Whether a drag is carrying files, as opposed to text or a link or nothing at all.
 *
 * `types` rather than `files`, because during a drag the browser says what is being carried but
 * not what it is: `dataTransfer.files` is empty until the drop actually happens. Reading `types`
 * is the only way to light the window up before the file is let go.
 */
export function dragCarriesFiles(types: readonly string[] | undefined): boolean {
  return (types ?? []).includes('Files');
}

/**
 * Whether the window should be showing that it will take a drop.
 *
 * Counted rather than set and cleared, because `dragleave` fires every time the pointer crosses
 * into a child element, and a window with a terminal and a launcher in it is nothing but child
 * elements. Set and cleared, the highlight flickered off at every boundary the pointer crossed.
 */
export class DragDepth {
  #depth = 0;

  enter(): boolean {
    this.#depth++;
    return this.#depth === 1;
  }

  leave(): boolean {
    this.#depth = Math.max(0, this.#depth - 1);
    return this.#depth === 0;
  }

  /** A drop, or a drag that left the window entirely, ends it whatever the count says. */
  end(): void {
    this.#depth = 0;
  }

  get active(): boolean {
    return this.#depth > 0;
  }
}

/** Control characters, minus the newlines handled separately. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * What a drop of plain text should stage.
 *
 * The same rule the context menu follows, and for the same reason: one line, no trailing newline,
 * so it is staged rather than run. A newline in dropped text would otherwise run whatever came
 * after it before anybody had read it, and an escape sequence could make the screen disagree with
 * what is about to run. See docs/05-security.md.
 */
export function droppedText(raw: string): string | null {
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(CONTROL, '')
    .trim();
  return cleaned === '' ? null : cleaned.slice(0, 4000);
}
