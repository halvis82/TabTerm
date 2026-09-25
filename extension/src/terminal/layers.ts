/**
 * What is on top, and what the keyboard belongs to.
 *
 * Three things in this product float above the page: the command panel, a modal dialog such as
 * the one for writing an action or a layout template, and a template's own card on the start
 * screen. They were each written on their own, so they could all be open at once and each of them
 * answered the keyboard as though it were alone. Reported as an edit dialog drawn over the menu,
 * as Command K toggling the menu behind a dialog on every press, and as Escape doing nothing to a
 * card.
 *
 * One rule instead: the topmost layer owns the keyboard, and opening a layer takes the others
 * away. Kept as a small piece of its own so every surface asks the same question rather than each
 * carrying its own idea of what is open.
 */

/** A modal dialog: writing an action, or editing a layout template. */
export const DIALOG = '.template-backdrop';

/** A template's card on the start screen, which is a popover rather than a dialog. */
export const CARD = '.template-card';

/** The command panel, which is furniture rather than a dialog and hides rather than closing. */
export const PANEL = '.cmd-panel';

export type Layer = 'dialog' | 'card' | 'panel';

/**
 * Which layer is on top right now, or null when the page is clear.
 *
 * A dialog beats a card because it is modal, and both beat the panel, which is the only one of
 * the three somebody leaves open while working.
 */
export interface PageLike {
  querySelector: (selectors: string) => { readonly hidden?: boolean } | null;
  querySelectorAll: (selectors: string) => Iterable<{ remove: () => void }>;
}

/** The real page, seen through the small shape above. */
const thePage = (): PageLike => document;

export function topLayer(doc: PageLike = thePage()): Layer | null {
  if (doc.querySelector(DIALOG)) return 'dialog';
  if (doc.querySelector(CARD)) return 'card';
  const panel = doc.querySelector(PANEL);
  // The panel hides rather than closing, so finding its element says nothing on its own.
  if (panel && panel.hidden !== true) return 'panel';
  return null;
}

/**
 * Whether a page shortcut may act.
 *
 * Nothing that opens or toggles a surface runs while a dialog is up: a dialog is a question, and
 * answering it is the only thing to do until it is gone. Command K toggling the menu **behind**
 * an open dialog is what this exists to stop.
 */
export function shortcutsAllowed(doc: PageLike = thePage()): boolean {
  return topLayer(doc) !== 'dialog';
}

/**
 * Take away whatever a new layer would otherwise sit on top of.
 *
 * Called by the thing being opened rather than by the thing being closed, because only the opener
 * knows it is about to become the top layer.
 */
export function clearBelow(opening: Layer, doc: PageLike = thePage()): void {
  if (opening === 'dialog' || opening === 'card') {
    for (const el of doc.querySelectorAll(CARD)) el.remove();
  }
  if (opening === 'dialog') {
    for (const el of doc.querySelectorAll(DIALOG)) el.remove();
  }
}
