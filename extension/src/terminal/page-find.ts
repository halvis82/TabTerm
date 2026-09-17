import type { FindTarget } from './find-bar.js';

/**
 * Finding text on the start screen, which is a page rather than a terminal.
 *
 * The find bar exists because a terminal is a canvas and the browser's own find has nothing to
 * read. On the start screen the opposite is true: everything is in the page, and the bar was
 * searching the strip of terminal along the bottom, which is empty. So looking for a word that was
 * plainly on screen, in the preview of a session, answered "no matches".
 *
 * Asked for as a way to find a session: "the actual content from previews from each session panes
 * should show up in the search". The previews are the only place some sessions are recognisable at
 * all, which is the whole reason they are drawn.
 *
 * This searches what is displayed, not a model behind it. A match is wrapped where it sits, so the
 * highlight is on the words somebody is looking at, and stepping through matches scrolls each one
 * into view the way a browser's find does.
 */
const HIT = 'find-hit';
const CURRENT = 'is-current';

export class PageFind implements FindTarget {
  readonly #root: () => HTMLElement | null;
  readonly #onResults: (results: { resultIndex: number; resultCount: number }) => void;
  #term = '';
  #hits: HTMLElement[] = [];
  #at = -1;

  constructor(
    root: () => HTMLElement | null,
    onResults: (results: { resultIndex: number; resultCount: number }) => void,
  ) {
    this.#root = root;
    this.#onResults = onResults;
  }

  find(term: string, opts: { back?: boolean } = {}): boolean {
    const root = this.#root();
    if (!root) return false;
    if (term !== this.#term) {
      this.#term = term;
      this.#mark(root, term);
      this.#at = this.#hits.length > 0 ? 0 : -1;
    } else if (this.#hits.length > 0) {
      /*
       * Wrapping round, which is what every find bar does and what makes the last match findable
       * from the first one without scrolling back by hand.
       */
      const step = opts.back === true ? -1 : 1;
      this.#at = (this.#at + step + this.#hits.length) % this.#hits.length;
    }
    this.#showCurrent();
    this.#onResults({ resultIndex: Math.max(0, this.#at), resultCount: this.#hits.length });
    return this.#hits.length > 0;
  }

  clearFind(): void {
    this.#term = '';
    this.#at = -1;
    for (const hit of this.#hits) {
      const parent = hit.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(hit.textContent ?? ''), hit);
      /*
       * Joined back up, or the next search sees "hii" as three separate text nodes and can no
       * longer match a word that a previous search cut in half.
       */
      parent.normalize();
    }
    this.#hits = [];
  }

  /**
   * Nothing, deliberately.
   *
   * The bar puts the keyboard back where it came from when it closes, which for a terminal is the
   * terminal. On the start screen there is no such place to put it: the page decides for itself
   * what should have the keyboard, and taking it into the folder box instead swallowed every key
   * the page's own listeners were watching for, because that box stops keys from travelling any
   * further. The check that Command Shift F still reaches the page is what caught it.
   */
  focus(): void {}

  /** Wrap every occurrence, in the order they appear on the page. */
  #mark(root: HTMLElement, term: string): void {
    this.clearFind();
    this.#term = term;
    if (term === '') return;
    const needle = term.toLowerCase();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        // The bar itself is on the page too, and matching the word being typed into it would be
        // a match nobody is looking for.
        if (parent.closest('#find')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[hidden]')) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue?.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const texts: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof Text) texts.push(node);
    }

    for (const text of texts) {
      const value = text.nodeValue ?? '';
      const parent = text.parentNode;
      if (!parent) continue;
      const pieces = document.createDocumentFragment();
      let at = 0;
      for (;;) {
        const found = value.toLowerCase().indexOf(needle, at);
        if (found === -1) break;
        if (found > at) pieces.append(document.createTextNode(value.slice(at, found)));
        const mark = document.createElement('mark');
        mark.className = HIT;
        mark.textContent = value.slice(found, found + needle.length);
        pieces.append(mark);
        this.#hits.push(mark);
        at = found + needle.length;
      }
      if (at < value.length) pieces.append(document.createTextNode(value.slice(at)));
      parent.replaceChild(pieces, text);
    }
  }

  #showCurrent(): void {
    for (const hit of this.#hits) hit.classList.remove(CURRENT);
    const current = this.#at >= 0 ? this.#hits[this.#at] : undefined;
    if (!current) return;
    current.classList.add(CURRENT);
    current.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}
