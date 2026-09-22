/**
 * Finding text in a terminal, because the browser cannot.
 *
 * Chrome's find reads the page. This terminal is a canvas drawn by WebGL, so there is nothing in
 * the page to read and the browser's bar opens and matches nothing. Drawing with elements instead
 * would not fix it either: xterm renders the rows in view, and the scrollback is the part worth
 * searching. So the search has to be asked of the emulator, which is the only thing that holds all
 * of it, and that means this bar rather than the browser's.
 *
 * It searches the focused pane. A terminal is a thing you are looking at, and searching four of
 * them at once would answer with matches in panes that are not in front of you.
 */
export interface FindTarget {
  find(term: string, opts?: { back?: boolean }): boolean;
  clearFind(): void;
  focus(): void;
}

export interface FindBarOptions {
  /** The pane to search, asked for at the moment of searching rather than held. */
  target: () => FindTarget | null;
  root: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  next: HTMLElement;
  previous: HTMLElement;
  close: HTMLElement;
  /**
   * Where the Escape key is caught while the bar is open.
   *
   * Passed in rather than reached for, so this class can be checked without a browser, which is
   * the whole reason the rest of it can be.
   */
  window?: {
    addEventListener: (name: string, fn: (e: KeyboardEvent) => void, capture: boolean) => void;
    removeEventListener: (name: string, fn: (e: KeyboardEvent) => void, capture: boolean) => void;
  };
}

export class FindBar {
  readonly #opts: FindBarOptions;
  #term = '';

  constructor(opts: FindBarOptions) {
    this.#opts = opts;

    opts.input.addEventListener('input', () => {
      this.#term = opts.input.value;
      /*
       * Searched backwards, so the first match is the **last thing printed**.
       *
       * A terminal is read from the bottom: what somebody is looking for is nearly always
       * something they have just seen go past, and starting at the top of a ten thousand line
       * scrollback answers with the oldest copy of it. Asked for by name, and it is what every
       * terminal does. Return then walks up into the history and Shift Return comes back down.
       */
      this.#run(true);
    });

    opts.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        // Return goes further back, which is the direction the search started in. Shift comes
        // back towards what was printed most recently.
        this.#run(!e.shiftKey);
      }
    });

    /*
     * The bar goes when the keyboard leaves it, and takes nothing with it.
     *
     * Asked for: "it should only show that menu when it is focused. so when we go to the actual
     * terminal session instead like clicking on it or something, close the cmd f search menu."
     * What was typed stays in the box, so the next press opens with the same words, selected,
     * and typing replaces them.
     *
     * The keyboard is **not** taken back here, unlike closing it deliberately: somebody who
     * clicked into a terminal or a text box has already said where they want it, and pulling it
     * somewhere else would be a second thing happening that nobody asked for.
     */
    opts.input.addEventListener('blur', () => {
      if (this.isOpen) this.hide(false);
    });

    /*
     * A press on the bar's own controls keeps the keyboard in the box.
     *
     * Without this the press moves focus first, the blur above closes the bar, and the button is
     * gone before the click it was given arrives.
     */
    opts.root.addEventListener('mousedown', (e) => {
      if (e.target !== opts.input) e.preventDefault();
    });

    opts.next.addEventListener('click', () => this.#run(false));
    opts.previous.addEventListener('click', () => this.#run(true));
    opts.close.addEventListener('click', () => this.hide());
  }

  get isOpen(): boolean {
    return !this.#opts.root.hidden;
  }

  /**
   * Escape closes the bar, from anywhere, and the session never hears it.
   *
   * The bar's own box had this and the terminal behind it did not, so pressing Escape after
   * jumping to a match, or after clicking back into the output, sent an interrupt to whatever was
   * running. For an agent that is the key that stops it mid-answer. The same rule the pane menus
   * have, for the same reason: "it can cancel claude".
   *
   * In the capture phase and stopped immediately, so nothing downstream sees it, and bound only
   * while the bar is open.
   */
  #onEscape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.isOpen) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.hide();
  };

  /**
   * Open it, with what was last searched for still in the box and selected.
   *
   * Selected rather than merely present: the commonest thing to do next is search for something
   * else, and typing then replaces it, while Return searches for the same thing again. A word
   * highlighted in the terminal wins over the remembered one, because pressing the key with
   * something selected is how somebody asks "where else is this".
   */
  show(selected: string): void {
    if (selected !== '' && !selected.includes('\n')) {
      this.#opts.input.value = selected;
      this.#term = selected;
    }
    this.#opts.root.hidden = false;
    this.#opts.input.focus();
    this.#opts.input.select();
    if (this.#term !== '') this.#run(true);
    this.#opts.window?.addEventListener('keydown', this.#onEscape, true);
  }

  /**
   * Close it. `giveKeyboardBack` is false when it closed because the keyboard already went
   * somewhere else, which is what losing focus means.
   */
  hide(giveKeyboardBack = true): void {
    this.#opts.window?.removeEventListener('keydown', this.#onEscape, true);
    this.#opts.root.hidden = true;
    this.#opts.count.textContent = '';
    this.#opts.target()?.clearFind();
    // Back to the terminal, or the next thing typed goes nowhere anybody can see.
    if (giveKeyboardBack) this.#opts.target()?.focus();
  }

  /** Called when the pane being searched has gone, so the bar does not point at nothing. */
  paneGone(): void {
    if (this.isOpen) this.hide();
  }

  #run(back: boolean): void {
    const target = this.#opts.target();
    if (!target) return;
    if (this.#term === '') {
      target.clearFind();
      this.#opts.count.textContent = '';
      return;
    }
    const found = target.find(this.#term, { back });
    // Said plainly rather than left to the highlight, which is off screen when there is no match.
    if (!found) this.#opts.count.textContent = 'no matches';
  }

  /** What the emulator counted, once it has. Shown as "3 of 12", or nothing while it is working. */
  showResults(results: { resultIndex: number; resultCount: number } | undefined): void {
    if (this.#term === '') {
      this.#opts.count.textContent = '';
      return;
    }
    if (results === undefined || results.resultCount === 0) {
      this.#opts.count.textContent = 'no matches';
      return;
    }
    this.#opts.count.textContent = `${String(results.resultIndex + 1)} of ${String(results.resultCount)}`;
  }
}
