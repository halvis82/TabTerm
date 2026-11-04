/**
 * Finding text in a terminal, because the browser cannot.
 *
 * Chrome's find reads the page. This terminal is a canvas drawn by WebGL, so there is nothing in
 * the page to read and the browser's bar opens and matches nothing. Drawing with elements instead
 * would not fix it either: xterm renders the rows in view, and the scrollback is the part worth
 * searching. So the search has to be asked of the emulator, which is the only thing that holds all
 * of it, and that means this bar rather than the browser's.
 *
 * It searches the focused pane first, and then the other panes in the same tab. Searching only the
 * focused one answered "no matches" for words plainly on screen in the pane beside it, which was
 * reported as the bar being blind to them. So when the focused pane has none, or Return has gone
 * past its oldest match, the bar moves on to the next pane in the tab that has some and focuses
 * it, and the count says how many more are in the other panes. Those panes are counted without
 * being searched, so nothing in them moves until the bar arrives.
 *
 * **All terminals**, a box beside it, searches every running terminal's history as well, in a tab
 * or in the background, for "where did I see that". Off unless ticked, and remembered. The pane in
 * front is still searched as before; the other terminals' matches are listed under the bar, and
 * pressing one opens that terminal on that match.
 */
import type { SessionMatches } from '@tabterm/shared';

export interface FindTarget {
  find(term: string, opts?: { back?: boolean }): boolean;
  /** The match `n` places back from the end, so a match listed elsewhere can be landed on. */
  findNth?(term: string, n: number): boolean;
  clearFind(): void;
  focus(): void;
  /** How many matches it holds, without moving anything. Absent where it cannot be counted. */
  countMatches?(term: string): number;
}

/** Searching every terminal. See the note at the top. */
export interface FindAllOptions {
  box: HTMLInputElement;
  results: HTMLElement;
  /** Ask for matches. The answer comes back through `showAll`. */
  search: (query: string) => void;
  /** Open a terminal on one of its matches. */
  open: (session: SessionMatches, fromEnd: number, query: string) => void;
  /** Whether the box is ticked, to keep for next time. */
  remember: (on: boolean) => void;
  /** Whether a terminal is the one in front, which is searched already. */
  isHere?: (sessionId: string) => boolean;
}

/** How long typing has to pause before every terminal is searched. */
const SEARCH_ALL_AFTER_MS = 250;

export interface FindBarOptions {
  /** The pane to search, asked for at the moment of searching rather than held. */
  target: () => FindTarget | null;
  root: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  next: HTMLElement;
  previous: HTMLElement;
  close: HTMLElement;
  all?: FindAllOptions;
  /** The other panes in this tab, in reading order after the focused one. */
  others?: () => FindTarget[];
  /** Make another pane the focused one, which is what the bar searches. */
  moveTo?: (target: FindTarget) => void;
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
  #allTimer: ReturnType<typeof setTimeout> | undefined;
  /** Where the focused pane's search stands, for knowing when Return has gone past its last. */
  #last: { resultIndex: number; resultCount: number } | undefined;
  /** Matches in the tab's other panes, said after the count. */
  #elsewhere = 0;
  /** Set while the bar moves to another pane, whose focus would otherwise close it. */
  #moving = false;

  constructor(opts: FindBarOptions) {
    this.#opts = opts;

    const all = opts.all;
    if (all) {
      all.results.hidden = !all.box.checked;
      all.box.addEventListener('change', () => {
        all.remember(all.box.checked);
        all.results.hidden = !all.box.checked;
        if (all.box.checked) this.#searchAll(true);
        else all.results.replaceChildren();
        opts.input.focus();
      });
    }
    opts.input.addEventListener('input', () => {
      this.#term = opts.input.value;
      this.#last = undefined;
      this.#searchAll(false);
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
      if (this.isOpen && !this.#moving) this.hide(false);
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
    this.#searchAll(true);
    this.#opts.window?.addEventListener('keydown', this.#onEscape, true);
  }

  /**
   * Ticked or not, as kept from last time, or as just changed in another tab.
   *
   * The box is one setting for every tab. It was read when a tab loaded and not again, so a tab
   * opened before it was ticked went on searching only itself, and a result opened in that tab
   * arrived without the list it came from.
   */
  setAll(on: boolean): void {
    const all = this.#opts.all;
    if (!all) return;
    if (all.box.checked === on && all.results.hidden === !on) return;
    all.box.checked = on;
    all.results.hidden = !on;
    if (!on) all.results.replaceChildren();
    else if (this.isOpen) this.#searchAll(true);
  }

  /** Give the keyboard to the box, for a tab coming to the front with the bar open. */
  focusInput(): void {
    if (this.isOpen) this.#opts.input.focus();
  }

  /**
   * Open on a given match, as a terminal opened from a search of all of them is: the words in the
   * box and that match in front.
   */
  showAt(query: string, fromEnd: number): boolean {
    this.#opts.input.value = query;
    this.#term = query;
    this.#last = undefined;
    this.#opts.root.hidden = false;
    this.#opts.window?.addEventListener('keydown', this.#onEscape, true);
    // The keyboard too, so Return goes on to the next match, as in the tab the search was made in.
    this.#opts.input.focus();
    this.#searchAll(true);
    const target = this.#opts.target();
    if (!target) return false;
    return target.findNth ? target.findNth(query, fromEnd) : target.find(query, { back: true });
  }

  #searchAll(now: boolean): void {
    const all = this.#opts.all;
    clearTimeout(this.#allTimer);
    if (!all?.box.checked) return;
    const query = this.#term.trim();
    if (query.length < 2) {
      all.results.replaceChildren();
      return;
    }
    this.#allTimer = setTimeout(() => all.search(query), now ? 0 : SEARCH_ALL_AFTER_MS);
  }

  /** What every terminal had, drawn under the bar. An answer to an older query is let go. */
  showAll(query: string, sessions: readonly SessionMatches[]): void {
    const all = this.#opts.all;
    if (!all?.box.checked || query !== this.#term.trim()) return;
    const doc = all.results.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      cls: string,
      text = '',
    ): HTMLElementTagNameMap[K] => {
      const e = doc.createElement(tag);
      e.className = cls;
      if (text !== '') e.textContent = text;
      return e;
    };
    if (sessions.length === 0) {
      all.results.replaceChildren(el('p', 'find-all-empty', 'No running terminal has this.'));
      return;
    }
    const groups = sessions.map((session) => {
      const group = el('div', 'find-all-group');
      const head = el('div', 'find-all-title');
      const folder = /^\/Users\/[^/]+\/?$/.test(session.cwd)
        ? '~'
        : session.cwd.replace(/\/+$/, '').split('/').pop() || session.cwd;
      head.append(
        el('span', 'find-all-name', session.name ?? session.process ?? 'Terminal'),
        el('span', 'find-all-where', folder),
        el(
          'span',
          'find-all-count',
          `${all.isHere?.(session.sessionId) === true ? 'here · ' : ''}${String(session.count)}`,
        ),
      );
      group.append(head);
      for (const match of session.matches) {
        const line = el('button', 'find-all-line');
        line.type = 'button';
        line.title = match.text;
        line.append(...marked(doc, match.text, query));
        line.addEventListener('click', () => all.open(session, match.fromEnd, query));
        group.append(line);
      }
      return group;
    });
    all.results.replaceChildren(...groups);
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
      this.#elsewhere = 0;
      this.#opts.count.textContent = '';
      return;
    }
    const others = this.#opts.others?.() ?? [];
    // Return goes back through the tab in reading order, Shift and Return the other way.
    const order = back ? others : [...others].reverse();
    const next = order.find((o) => (o.countMatches?.(this.#term) ?? 0) > 0);
    const here = target.countMatches?.(this.#term);
    const last = this.#last;
    const pastTheLast =
      last !== undefined &&
      last.resultCount > 0 &&
      (back ? last.resultIndex === 0 : last.resultIndex === last.resultCount - 1);
    if (next && (here === 0 || pastTheLast)) {
      this.#move(target, next, back);
      return;
    }
    this.#countElsewhere();
    const found = target.find(this.#term, { back });
    // Said plainly rather than left to the highlight, which is off screen when there is no match.
    if (!found) this.#opts.count.textContent = 'no matches';
  }

  /** On to another pane in the tab, which takes focus and the search, with the bar kept open. */
  #move(from: FindTarget, to: FindTarget, back: boolean): void {
    from.clearFind();
    this.#moving = true;
    try {
      this.#opts.moveTo?.(to);
      this.#opts.input.focus();
    } finally {
      this.#moving = false;
    }
    this.#last = undefined;
    this.#countElsewhere();
    to.find(this.#term, { back });
  }

  #countElsewhere(): void {
    this.#elsewhere = (this.#opts.others?.() ?? []).reduce(
      (sum, o) => sum + (o.countMatches?.(this.#term) ?? 0),
      0,
    );
  }

  /** What the emulator counted, once it has. Shown as "3 of 12", or nothing while it is working. */
  showResults(results: { resultIndex: number; resultCount: number } | undefined): void {
    this.#last = results;
    if (this.#term === '') {
      this.#opts.count.textContent = '';
      return;
    }
    const elsewhere =
      this.#elsewhere > 0
        ? ` · ${this.#elsewhere.toLocaleString('en-US')} in ${this.#elsewhere === 1 ? 'another pane' : 'other panes'}`
        : '';
    if (results === undefined || results.resultCount === 0) {
      this.#opts.count.textContent = elsewhere === '' ? 'no matches' : `none here${elsewhere}`;
      return;
    }
    this.#opts.count.textContent = `${String(results.resultIndex + 1)} of ${String(results.resultCount)}${elsewhere}`;
  }
}

/** A line with each place the words appear marked, as text nodes and `mark`s. */
function marked(doc: Document, text: string, query: string): Node[] {
  const out: Node[] = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) out.push(doc.createTextNode(text.slice(from, at)));
    const mark = doc.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    out.push(mark);
    from = at + needle.length;
  }
  if (from < text.length) out.push(doc.createTextNode(text.slice(from)));
  return out;
}
