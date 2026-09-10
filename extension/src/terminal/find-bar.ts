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
}

export class FindBar {
  readonly #opts: FindBarOptions;
  #term = '';

  constructor(opts: FindBarOptions) {
    this.#opts = opts;

    opts.input.addEventListener('input', () => {
      this.#term = opts.input.value;
      // Searched as it is typed, from the top, so the first match is the first one above.
      this.#run(false);
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
        this.#run(e.shiftKey);
      }
    });

    opts.next.addEventListener('click', () => this.#run(false));
    opts.previous.addEventListener('click', () => this.#run(true));
    opts.close.addEventListener('click', () => this.hide());
  }

  get isOpen(): boolean {
    return !this.#opts.root.hidden;
  }

  /**
   * Open it, and take whatever is selected as the thing to look for.
   *
   * Selecting a word and pressing the key is how somebody asks "where else is this", and making
   * them type it again is the difference between a feature and a chore.
   */
  show(selected: string): void {
    if (selected !== '' && !selected.includes('\n')) {
      this.#opts.input.value = selected;
      this.#term = selected;
    }
    this.#opts.root.hidden = false;
    this.#opts.input.focus();
    this.#opts.input.select();
    if (this.#term !== '') this.#run(false);
  }

  hide(): void {
    this.#opts.root.hidden = true;
    this.#opts.count.textContent = '';
    this.#opts.target()?.clearFind();
    // Back to the terminal, or the next thing typed goes nowhere anybody can see.
    this.#opts.target()?.focus();
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
