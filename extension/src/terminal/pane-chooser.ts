import type { LiveSession, MergeableSession } from '@tabterm/shared';
import { buildSessionCard } from '../launcher/sessions-view.js';

/**
 * What an empty pane offers instead of a bare prompt.
 *
 * Splitting a tab produces empty shells in the home directory, and the first thing anybody does
 * with one is go somewhere. So a pane with nothing in it offers the two things it cannot already
 * do by typing: browse for a folder, and take a session that already exists.
 *
 * There is deliberately **no path box**. You are already sitting at a prompt, so typing a path
 * is what `cd` is for; a box for it would be a worse version of the terminal underneath. A
 * picker and a list of running sessions are the parts typing cannot replace.
 *
 * It sits at the **bottom** of the pane, because a terminal fills from the top and the panel
 * must never cover the line being typed. It is over the pane rather than replacing it, on the
 * same principle as the start screen: the shell underneath is already running and already has
 * the keyboard, so typing goes straight to it and this goes away on the first command.
 *
 * Bringing a session here **moves** it. A session lives in exactly one workspace, so the tab it
 * came from is left with nothing, and that is said before it happens rather than discovered
 * afterwards.
 */

export interface PaneChooserOptions {
  container: HTMLElement;
  paneId: string;
  home: string;
  onChooseDir: (paneId: string, path: string) => void;
  /** Ask the daemon what is inside a directory. The answer arrives at `setListing`. */
  onListFolder: (path: string) => void;
  onTakeSession: (paneId: string, session: MergeableSession) => void;
  onRefreshSessions: () => void;
  /**
   * Everything running, so a session can be offered as the card it has on the start screen.
   *
   * A row of text cannot tell four shells in the same repository apart. The card carries the
   * last lines of the actual screen, which is the thing somebody recognises, and it is the same
   * component so the two cannot drift.
   */
  liveSessions: () => readonly LiveSession[];
  /** Put away, without choosing anything. */
  onDismiss?: (paneId: string) => void;
}

/** A shortlist, not an inventory. A pane is a small place to read one. */
const MAX_SESSIONS = 4;

export class PaneChooser {
  readonly #opts: PaneChooserOptions;
  readonly #el: HTMLElement;
  #sessions: readonly MergeableSession[] = [];
  #dismissed = false;
  #confirming: string | null = null;
  /** The directory being browsed, or null when the picker is closed. */
  #browsing: string | null = null;
  #folders: readonly string[] = [];

  constructor(opts: PaneChooserOptions) {
    this.#opts = opts;
    this.#el = document.createElement('div');
    this.#el.className = 'pane-chooser';
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
    this.#el.remove();
  }

  setSessions(sessions: readonly MergeableSession[]): void {
    /**
     * What is worth offering, in the order worth offering it.
     *
     * An untouched shell is left out: taking one gains nothing and costs whoever opened it their
     * tab. The rest are sorted so a session somebody is looking at comes first, because a short
     * list that omits the one you meant is worse than no list.
     */
    this.#sessions = sessions
      .filter((session) => session.hasRun)
      .slice()
      .sort((a, b) => Number(b.attached) - Number(a.attached));
    if (!this.#dismissed) this.render();
  }

  /** Folders inside the directory being browsed. */
  setListing(path: string, folders: readonly string[]): void {
    if (this.#dismissed || this.#browsing === null) return;
    if (path !== this.#browsing) return;
    this.#folders = folders;
    this.render();
  }

  render(): void {
    if (this.#dismissed) return;
    this.#el.replaceChildren();

    const box = document.createElement('div');
    box.className = 'pane-chooser-box';
    box.append(this.#browsing === null ? this.#chooserBody() : this.#browserBody());

    const foot = document.createElement('div');
    foot.className = 'pane-chooser-foot';
    const hint = document.createElement('span');
    hint.className = 'pane-chooser-hint';
    hint.textContent = 'or just start typing';
    foot.append(hint);

    /**
     * A way to put it away without choosing anything.
     *
     * It is a large thing to appear over a pane that already works: the prompt is right there
     * and typing dismisses it, but that is only obvious once you know. A button says so.
     */
    const dismiss = document.createElement('button');
    dismiss.className = 'pane-chooser-dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.title = 'Hide this and use the prompt';
    dismiss.addEventListener('click', () => {
      this.dismiss();
      this.#opts.onDismiss?.(this.#opts.paneId);
    });
    foot.append(dismiss);
    box.append(foot);

    this.#el.append(box);
  }

  #chooserBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'pane-chooser-rows';

    const browse = document.createElement('button');
    browse.className = 'pane-chooser-browse';
    browse.textContent = 'Open a folder';
    browse.addEventListener('click', () => this.#browse(`${this.#opts.home}/`));
    body.append(browse);

    /**
     * The sessions this pane could take, as the cards they have on the start screen.
     *
     * Matched by id against what the daemon says is mergeable, so the list is still the daemon's
     * answer about what may be moved; only the drawing comes from the other place.
     */
    const mergeable = new Map(this.#sessions.map((m) => [m.sessionId, m]));
    const cards = this.#opts
      .liveSessions()
      .filter((live) => mergeable.has(live.sessionId))
      .slice(0, MAX_SESSIONS);

    if (cards.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'pane-chooser-heading';
      heading.textContent = 'Or bring a session here';
      body.append(heading);

      const grid = document.createElement('div');
      grid.className = 'session-grid pane-chooser-grid';
      for (const live of cards) {
        const target = mergeable.get(live.sessionId);
        if (!target) continue;
        const card = buildSessionCard(live, {
          sessions: () => [],
          home: this.#opts.home,
          onOpen: () => {
            /**
             * Taking a session that a tab is showing moves it, so it asks first.
             *
             * The tab it came from is left with nothing, which is somebody else's window
             * changing because of a click in this one.
             */
            if (live.attached && this.#confirming !== live.sessionId) {
              this.#confirming = live.sessionId;
              this.render();
              return;
            }
            this.#opts.onTakeSession(this.#opts.paneId, target);
          },
        });
        // Also carries the name the chooser's own checks and styles use: it is a session row
        // here, drawn as a card, rather than a card that happens to be in a chooser.
        card.classList.add('pane-chooser-session');
        card.dataset['session'] = live.sessionId;
        if (this.#confirming === live.sessionId) {
          card.classList.add('is-confirming');
          const warn = document.createElement('div');
          warn.className = 'pane-chooser-warn';
          warn.textContent = 'Already open in another tab. Move it here and close that tab?';
          card.append(warn);
        }
        grid.append(card);
      }
      body.append(grid);
    }
    return body;
  }

  #browserBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'pane-chooser-rows';

    const path = this.#browsing ?? this.#opts.home;

    const header = document.createElement('div');
    header.className = 'pane-chooser-heading';
    header.textContent = shorten(path, this.#opts.home);
    body.append(header);

    /**
     * Every folder, in a region that scrolls.
     *
     * It used to show the first eight, which is a browser that cannot reach most folders: a
     * directory of projects routinely has more than that, and the one being looked for was
     * usually not among the ones shown. The list scrolls instead, and the heading and the
     * buttons stay put so `Open here` cannot be scrolled out of reach.
     */
    const list = document.createElement('div');
    list.className = 'pane-chooser-folders';

    // Up first, because going back is the thing most often wanted while browsing.
    const up = document.createElement('button');
    up.className = 'pane-chooser-folder';
    up.textContent = '..';
    up.addEventListener('click', () => this.#browse(`${parentOf(path)}/`));
    list.append(up);

    for (const folder of this.#folders) {
      const row = document.createElement('button');
      row.className = 'pane-chooser-folder';
      row.textContent = folder;
      row.addEventListener('click', () => this.#browse(`${trimSlash(path)}/${folder}/`));
      list.append(row);
    }
    body.append(list);

    const actions = document.createElement('div');
    actions.className = 'pane-chooser-actions';

    const open = document.createElement('button');
    open.className = 'pane-chooser-accept';
    open.textContent = 'Open here';
    open.addEventListener('click', () =>
      this.#opts.onChooseDir(this.#opts.paneId, trimSlash(path)),
    );

    const cancel = document.createElement('button');
    cancel.className = 'pane-chooser-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      this.#browsing = null;
      this.#folders = [];
      this.render();
    });

    actions.append(cancel, open);
    body.append(actions);
    return body;
  }

  #browse(path: string): void {
    this.#browsing = path;
    this.#folders = [];
    this.render();
    this.#opts.onListFolder(path);
  }
}

function shorten(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function parentOf(path: string): string {
  const trimmed = trimSlash(path);
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}
