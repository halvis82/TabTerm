import type { MergeableSession } from '@tabterm/shared';

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

    const hint = document.createElement('div');
    hint.className = 'pane-chooser-hint';
    hint.textContent = 'or just start typing';
    box.append(hint);

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

    if (this.#sessions.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'pane-chooser-heading';
      heading.textContent = 'Or bring a session here';
      body.append(heading);
      for (const session of this.#sessions.slice(0, MAX_SESSIONS)) {
        body.append(this.#sessionRow(session));
      }
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

  #sessionRow(session: MergeableSession): HTMLElement {
    const row = document.createElement('button');
    row.className = 'pane-chooser-session';
    row.dataset['session'] = session.sessionId;

    const name = document.createElement('span');
    name.className = 'pane-chooser-session-name';
    name.textContent = session.title;

    const where = document.createElement('span');
    where.className = 'pane-chooser-session-cwd';
    where.textContent = shorten(session.cwd, this.#opts.home);

    row.append(name, where);

    if (session.attached) {
      const badge = document.createElement('span');
      badge.className = 'pane-chooser-badge';
      badge.textContent = 'open in a tab';
      row.append(badge);
    }

    if (this.#confirming === session.sessionId) {
      // Said in full, because the cost is somebody else's tab going away.
      row.classList.add('is-confirming');
      const warn = document.createElement('span');
      warn.className = 'pane-chooser-warn';
      warn.textContent = 'Already open in another tab. Move it here and close that tab?';
      row.append(warn);
      row.addEventListener('click', () => this.#opts.onTakeSession(this.#opts.paneId, session));
      return row;
    }

    row.addEventListener('click', () => {
      if (session.attached) {
        this.#confirming = session.sessionId;
        this.render();
        return;
      }
      this.#opts.onTakeSession(this.#opts.paneId, session);
    });
    return row;
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
