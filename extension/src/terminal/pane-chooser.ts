import type { LiveSession } from '@tabterm/shared';
import { FolderPicker } from '../launcher/folder-picker.js';
import { buildSessions, isInATab, placeSessions } from '../launcher/sessions-view.js';

/**
 * What an empty pane offers instead of a bare prompt.
 *
 * Splitting a tab produces empty shells, and the first thing anybody does with one is go
 * somewhere. So a pane with nothing in it offers the two things it cannot already do as easily
 * by typing: pick a folder, and bring a session that already exists into it.
 *
 * **A folder** is picked with the start screen's own picker, starting in the folder this pane's
 * shell is in: a box that Tab completes, with the folders inside wherever it points shown under
 * it. Asked for as "the same folder picker as the homepage".
 *
 * **A session** is one large button, and pressing it floats out a bubble over most of the tab
 * holding the start screen's Running now list, grouped by tab the same way. It used to be a row
 * of small cards scrolling at the bottom of the pane, and the list was the daemon's answer about
 * what could be moved, crossed with what was live, with untouched shells taken out and the rest
 * cut at eight, so sessions that plainly existed were missing from it. Now it is every session
 * the start screen lists, which is every live one outside this tab, in a tab or in the
 * background. Choosing one is the only thing a card does here: no menu, no closing, no dragging.
 *
 * It sits at the **bottom** of the pane, because a terminal fills from the top and the panel
 * must never cover the line being typed. The shell underneath already has the keyboard, so
 * typing goes straight to it and this goes away on the first command.
 *
 * Bringing a session here **moves** it. A session lives in exactly one workspace, so it leaves
 * wherever it was. Taking one that a tab is showing asks first, because that is somebody else's
 * window changing from a click in this one.
 */

export interface PaneChooserOptions {
  container: HTMLElement;
  paneId: string;
  home: string;
  /** The folder this pane's shell is in, which is where the picker starts. */
  startDir: () => string;
  onChooseDir: (paneId: string, path: string) => void;
  /** Ask the daemon to complete a path. The answer arrives at `pathCompletion`. */
  onCompletePath: (partial: string) => void;
  /** Command Shift G in the folder box. See `choose-folder-key.ts`. */
  onChooseFolder?: (from: string) => Promise<string | null>;
  onTakeSession: (paneId: string, session: LiveSession) => void;
  onRefreshSessions: () => void;
  /**
   * A right click on this overlay is a right click on the pane under it.
   *
   * Without this the chooser swallowed the gesture: a pane that had just been split was plainly
   * visible and had no menu at all.
   */
  onContextMenu?: (paneId: string, x: number, y: number) => void;
  /** Every live session outside this tab, the same list the start screen draws. */
  liveSessions: () => readonly LiveSession[];
  /** Put away, without choosing anything. */
  onDismiss?: (paneId: string) => void;
}

export class PaneChooser {
  readonly #opts: PaneChooserOptions;
  readonly #el: HTMLElement;
  readonly #picker: FolderPicker;
  #dismissed = false;
  #bubble: SessionBubble | null = null;

  constructor(opts: PaneChooserOptions) {
    this.#opts = opts;
    this.#el = document.createElement('div');
    this.#el.className = 'pane-chooser';
    this.#el.addEventListener('contextmenu', (e) => {
      // Not when there is a real target for it, like the box somebody is typing a path into.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      opts.onContextMenu?.(opts.paneId, e.clientX, e.clientY);
    });
    this.#picker = new FolderPicker({
      home: opts.home,
      start: opts.startDir() || opts.home,
      onCompletePath: opts.onCompletePath,
      onOpen: (path) => opts.onChooseDir(opts.paneId, path),
      ...(opts.onChooseFolder ? { onChooseFolder: opts.onChooseFolder } : {}),
    });
    opts.container.append(this.#el);
    this.render();
    opts.onRefreshSessions();
  }

  get dismissed(): boolean {
    return this.#dismissed;
  }

  /** Once a pane has been used it is a terminal, and a terminal does not grow a panel back. */
  dismiss(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    this.#bubble?.close();
    this.#el.remove();
  }

  /** The daemon's answer about a path, for the folder picker. */
  pathCompletion(reply: { partial: string; completed: string; matches: readonly string[] }): void {
    if (!this.#dismissed) this.#picker.pathCompletion(reply);
  }

  /**
   * Bring the button up to date with what is running.
   *
   * Only the button. This is called whenever the list of sessions changes, which is often, and
   * rebuilding the panel took the path box out of the page and put a new one back, so the
   * keyboard left it in the middle of a word.
   */
  render(): void {
    if (this.#dismissed) return;
    if (!this.#take) this.#build();
    const take = this.#take;
    const count = this.#takeCount;
    if (!take || !count) return;
    const others = this.#opts.liveSessions();
    take.disabled = others.length === 0;
    count.textContent = others.length === 0 ? 'nothing else is running' : describeCount(others);
    // The list behind the bubble changed, so the bubble shows the new one.
    this.#bubble?.refresh();
  }

  #take: HTMLButtonElement | null = null;
  #takeCount: HTMLElement | null = null;

  #build(): void {
    const box = document.createElement('div');
    box.className = 'pane-chooser-box';

    const folders = document.createElement('section');
    folders.className = 'pane-chooser-section';
    const heading = document.createElement('div');
    heading.className = 'pane-chooser-heading';
    heading.textContent = 'Open a folder';
    folders.append(heading, this.#picker.element);
    box.append(folders);

    const take = document.createElement('button');
    take.className = 'pane-chooser-take';
    const label = document.createElement('span');
    label.className = 'pane-chooser-take-label';
    label.textContent = 'Bring a session here';
    const count = document.createElement('span');
    count.className = 'pane-chooser-take-count';
    take.append(label, count);
    take.addEventListener('click', () => this.#openBubble(take));
    box.append(take);
    this.#take = take;
    this.#takeCount = count;

    const foot = document.createElement('div');
    foot.className = 'pane-chooser-foot';
    const hint = document.createElement('span');
    hint.className = 'pane-chooser-hint';
    hint.textContent = 'or just start typing';
    // A way to put it away without choosing anything, for anybody who does not know that typing
    // does it.
    const dismiss = document.createElement('button');
    dismiss.className = 'pane-chooser-dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.title = 'Hide this and use the prompt';
    dismiss.addEventListener('click', () => {
      this.dismiss();
      this.#opts.onDismiss?.(this.#opts.paneId);
    });
    foot.append(hint, dismiss);
    box.append(foot);

    this.#el.replaceChildren(box);
  }

  #openBubble(from: HTMLElement): void {
    this.#bubble?.close();
    this.#opts.onRefreshSessions();
    this.#bubble = new SessionBubble({
      from,
      home: this.#opts.home,
      sessions: this.#opts.liveSessions,
      onTake: (session) => {
        this.#bubble?.close();
        this.#opts.onTakeSession(this.#opts.paneId, session);
      },
      onClosed: () => {
        this.#bubble = null;
      },
    });
  }
}

/** "3 in tabs, 2 in the background", so the button says what is behind it. */
function describeCount(sessions: readonly LiveSession[]): string {
  const inTabs = sessions.filter(isInATab).length;
  const background = sessions.length - inTabs;
  const parts: string[] = [];
  if (inTabs > 0) parts.push(`${String(inTabs)} in ${inTabs === 1 ? 'a tab' : 'tabs'}`);
  if (background > 0) parts.push(`${String(background)} in the background`);
  return parts.join(', ');
}

export interface SessionBubbleOptions {
  /** The button it floats out of, which is where it grows from. */
  from: HTMLElement;
  /** What it says at the top. "Bring a session here" over an empty pane. */
  title?: string;
  sub?: string;
  home: string;
  sessions: () => readonly LiveSession[];
  onTake: (session: LiveSession) => void;
  onClosed: () => void;
}

/** How long the bubble takes to grow or fold away, in step with the stylesheet. */
const BUBBLE_MS = 160;

/**
 * Every session that could be brought here, over most of the tab.
 *
 * The start screen's Running now, built by the same function, so it is grouped by tab the same way
 * and a session already showing in a tab says so. Nothing on it but choosing: no menu on a right
 * click, no close, no drag. A press anywhere outside it, or Escape, puts it away, and it folds
 * back into the button it came out of, so it never stands between somebody and the terminal.
 */
export class SessionBubble {
  readonly #opts: SessionBubbleOptions;
  readonly #scrim: HTMLElement;
  readonly #bubble: HTMLElement;
  readonly #list: HTMLElement;
  #confirming: string | null = null;
  #closed = false;
  readonly #onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  constructor(opts: SessionBubbleOptions) {
    this.#opts = opts;
    this.#scrim = document.createElement('div');
    this.#scrim.className = 'take-scrim';
    // A press outside the bubble puts it away. Inside, it is the bubble's.
    this.#scrim.addEventListener('pointerdown', (e) => {
      if (e.target === this.#scrim) this.close();
    });

    this.#bubble = document.createElement('div');
    this.#bubble.className = 'take-bubble';
    this.#bubble.setAttribute('role', 'dialog');
    this.#bubble.setAttribute('aria-label', opts.title ?? 'Bring a session here');
    // No menu of its own and none of the page's: choosing is the only thing on offer here.
    this.#bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    /*
     * The colour behind a tab's cards opens that tab on the start screen. Here it would take
     * whichever card is first, which is not a choice anybody made, so only a card answers.
     */
    this.#bubble.addEventListener(
      'click',
      (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest('.session-wash') && !target.closest('.session-card')) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );

    const head = document.createElement('div');
    head.className = 'take-bubble-head';
    const title = document.createElement('div');
    title.className = 'take-bubble-title';
    title.textContent = opts.title ?? 'Bring a session here';
    const sub = document.createElement('div');
    sub.className = 'take-bubble-sub';
    sub.textContent =
      opts.sub ??
      'Click one to move it into this pane. Sessions already in this tab are not listed.';
    const close = document.createElement('button');
    close.className = 'take-bubble-close';
    close.textContent = '×';
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => this.close());
    const titles = document.createElement('div');
    titles.append(title, sub);
    head.append(titles, close);

    this.#list = document.createElement('div');
    this.#list.className = 'take-bubble-list';
    this.#bubble.append(head, this.#list);
    this.#scrim.append(this.#bubble);

    // Grown out of the button, so it reads as the button opening rather than a page appearing.
    const from = opts.from.getBoundingClientRect();
    document.body.append(this.#scrim);
    const box = this.#bubble.getBoundingClientRect();
    this.#bubble.style.transformOrigin = `${String(from.left + from.width / 2 - box.left)}px ${String(
      from.top + from.height / 2 - box.top,
    )}px`;
    this.refresh();
    requestAnimationFrame(() => this.#scrim.classList.add('is-open'));
    document.addEventListener('keydown', this.#onKey, true);
  }

  refresh(): void {
    if (this.#closed) return;
    const sessions = this.#opts.sessions();
    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'take-bubble-empty';
      empty.textContent = 'Nothing else is running.';
      this.#list.replaceChildren(empty);
      return;
    }
    const section = buildSessions({
      sessions: () => sessions,
      home: this.#opts.home,
      onOpen: (session) => this.#choose(session),
    });
    for (const card of section.querySelectorAll<HTMLElement>('.session-card')) {
      card.classList.add('pane-chooser-session');
      const id = card.dataset['sessionId'] ?? '';
      card.dataset['session'] = id;
      if (id === this.#confirming) this.#markConfirming(card);
    }
    this.#list.replaceChildren(section);
    placeSessions(this.#list);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    document.removeEventListener('keydown', this.#onKey, true);
    this.#scrim.classList.remove('is-open');
    setTimeout(() => this.#scrim.remove(), BUBBLE_MS);
    this.#opts.onClosed();
  }

  #choose(session: LiveSession): void {
    /**
     * Taking a session that a tab is showing moves it, so it asks first.
     *
     * The tab it came from is left without it, which is somebody else's window changing because
     * of a click in this one. A second press on the same card is the answer.
     */
    if (isInATab(session) && this.#confirming !== session.sessionId) {
      this.#confirming = session.sessionId;
      for (const card of this.#list.querySelectorAll<HTMLElement>('.session-card')) {
        card.classList.remove('is-confirming');
        card.querySelector('.pane-chooser-warn')?.remove();
        if (card.dataset['sessionId'] === session.sessionId) this.#markConfirming(card);
      }
      return;
    }
    this.#opts.onTake(session);
  }

  #markConfirming(card: HTMLElement): void {
    card.classList.add('is-confirming');
    const warn = document.createElement('div');
    warn.className = 'pane-chooser-warn';
    warn.textContent = 'Open in another tab. Click again to move it here.';
    card.append(warn);
  }
}
