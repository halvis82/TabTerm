import { describe, expect, it } from 'vitest';
import { CARD, DIALOG, PANEL, clearBelow, shortcutsAllowed, topLayer } from './layers.js';

/** A stand-in for the page, holding whichever surfaces a case is about. */
const page = (...open: string[]) => {
  const has = (sel: string) => open.includes(sel);
  return {
    querySelector: (sel: string) => (has(sel) ? { hidden: false } : null),
    querySelectorAll: (sel: string) => (has(sel) ? [{ remove: () => undefined }] : []),
  };
};

describe('which surface is on top', () => {
  it('is nothing on a clear page', () => {
    expect(topLayer(page())).toBeNull();
  });

  it('is the dialog when one is up, whatever else is', () => {
    // It is modal: a question that has to be answered before anything else means anything.
    expect(topLayer(page(DIALOG, CARD, PANEL))).toBe('dialog');
  });

  it('then the card', () => {
    expect(topLayer(page(CARD, PANEL))).toBe('card');
  });

  it('then the panel', () => {
    expect(topLayer(page(PANEL))).toBe('panel');
  });

  it('and a hidden panel is not on top of anything', () => {
    // The panel hides rather than closing, so its element is always there to be found.
    const hidden = {
      querySelector: (sel: string) => (sel === PANEL ? { hidden: true } : null),
      querySelectorAll: () => [],
    };
    expect(topLayer(hidden)).toBeNull();
  });
});

describe('what the keyboard is allowed to do', () => {
  it('leaves shortcuts alone while a dialog is up', () => {
    // Command K toggling the menu behind an open dialog, on every press, is what this stops.
    expect(shortcutsAllowed(page(DIALOG))).toBe(false);
  });

  it('allows them over a card or the panel', () => {
    expect(shortcutsAllowed(page(CARD))).toBe(true);
    expect(shortcutsAllowed(page(PANEL))).toBe(true);
    expect(shortcutsAllowed(page())).toBe(true);
  });
});

describe('opening one takes the others away', () => {
  it('a dialog removes a card and any dialog already there', () => {
    const removed: string[] = [];
    const doc = {
      querySelector: () => null,
      querySelectorAll: (sel: string) => [
        {
          remove: () => {
            removed.push(sel);
          },
        },
      ],
    };
    clearBelow('dialog', doc);
    expect(removed).toEqual([CARD, DIALOG]);
  });

  it('a card removes another card but leaves a dialog alone', () => {
    // Nothing opens a card while a dialog is up, and removing one from under a question would
    // be answering it on somebody's behalf.
    const removed: string[] = [];
    const doc = {
      querySelector: () => null,
      querySelectorAll: (sel: string) => [
        {
          remove: () => {
            removed.push(sel);
          },
        },
      ],
    };
    clearBelow('card', doc);
    expect(removed).toEqual([CARD]);
  });
});
