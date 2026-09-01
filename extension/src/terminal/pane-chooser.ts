import type { MergeableSession } from '@tabterm/shared';

/**
 * What an empty pane offers instead of a bare prompt.
 *
 * Splitting a tab used to produce two empty shells in the home directory, and the first thing
 * anybody does with one is go somewhere. So a pane with nothing in it offers the two things
 * worth doing: pick a folder, or bring a session that already exists here.
 *
 * It sits over the pane rather than replacing it, on the same principle as the start screen: the
 * shell underneath is already running and already has the keyboard, so typing goes straight to it
 * and this gets out of the way. Nothing here is a mode.
 *
 * Bringing a session here **moves** it. A session lives in exactly one workspace, so the tab it
 * came from is left with nothing, and that is said before it happens rather than discovered
 * afterwards.
 */

export interface PaneChooserOptions {
  /** Where to draw, which is the pane's own element. */
  container: HTMLElement;
  paneId: string;
  home: string;
  onChooseDir: (paneId: string, path: string) => void;
  onCompletePath: (partial: string) => void;
  /** Move a session into this pane. `closeSource` when a tab is currently showing it. */
  onTakeSession: (paneId: string, session: MergeableSession) => void;
  onRefreshSessions: () => void;
}

export class PaneChooser {
  readonly #opts: PaneChooserOptions;
  readonly #el: HTMLElement;
  #input: HTMLInputElement | null = null;
  #sessions: readonly MergeableSession[] = [];
  #completion: { prefix: string; matches: readonly string[] } | null = null;
  #dismissed = false;
  #confirming: string | null = null;

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

  /**
   * Take it away for good.
   *
   * Once a pane has been used it is a terminal, and a terminal does not grow a panel back.
   */
  dismiss(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    this.#el.remove();
  }

  setSessions(sessions: readonly MergeableSession[]): void {
    // An untouched shell is not worth offering: taking one gains nothing and costs whoever
    // opened it their tab.
    this.#sessions = sessions.filter((s) => s.hasRun);
    if (!this.#dismissed) this.render();
  }

  /**
   * Apply what the daemon completed.
   *
   * The full path comes back as `completed`; `matches` are the basenames beneath it, and are
   * worth showing only when the completion could not decide, which is what a shell does.
   */
  setCompletion(reply: { partial: string; completed: string; matches: readonly string[] }): void {
    if (this.#dismissed || !this.#input) return;
    // An answer to a keystroke that has since been replaced is not an answer to anything.
    if (this.#input.value.trim() !== reply.partial) return;

    if (reply.completed !== reply.partial) this.#input.value = reply.completed;
    this.#completion =
      reply.matches.length > 1 ? { prefix: reply.completed, matches: reply.matches } : null;
    this.render();
  }

  render(): void {
    if (this.#dismissed) return;
    const typed = this.#input?.value ?? '';
    const hadFocus = document.activeElement === this.#input;
    this.#el.replaceChildren();

    const box = document.createElement('div');
    box.className = 'pane-chooser-box';

    const input = document.createElement('input');
    input.className = 'pane-chooser-input';
    input.placeholder = 'Open a folder';
    input.spellcheck = false;
    input.value = typed;
    input.addEventListener('keydown', (e) => this.#onKey(e, input));
    this.#input = input;
    box.append(input);

    if (this.#completion && this.#completion.matches.length > 1) {
      const list = document.createElement('div');
      list.className = 'pane-chooser-matches';
      for (const match of this.#completion.matches.slice(0, 6)) {
        const chip = document.createElement('button');
        chip.className = 'pane-chooser-match';
        chip.textContent = match;
        chip.addEventListener('click', () => {
          // Replace the fragment being completed, not the whole path.
          const base = input.value.slice(0, input.value.lastIndexOf('/') + 1);
          input.value = `${base}${match}`;
          this.#completion = null;
          this.render();
          this.#input?.focus();
        });
        list.append(chip);
      }
      box.append(list);
    }

    if (this.#sessions.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'pane-chooser-heading';
      heading.textContent = 'Or bring a session here';
      box.append(heading);

      for (const session of this.#sessions.slice(0, 6)) {
        box.append(this.#sessionRow(session));
      }
    }

    const hint = document.createElement('div');
    hint.className = 'pane-chooser-hint';
    hint.textContent = 'or just start typing';
    box.append(hint);

    this.#el.append(box);
    if (hadFocus) input.focus();
  }

  #sessionRow(session: MergeableSession): HTMLElement {
    const row = document.createElement('button');
    row.className = 'pane-chooser-session';
    // Which session this row is, so the row can be identified without reading its label.
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

  #onKey(e: KeyboardEvent, input: HTMLInputElement): void {
    // The pane's own keys, not the terminal's, while the cursor is deliberately in this box.
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      this.#opts.onCompletePath(input.value.trim() || '~/');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const path = input.value.trim();
      if (path) this.#opts.onChooseDir(this.#opts.paneId, path);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss();
    }
  }
}

function shorten(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
