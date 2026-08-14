import { buildSessions } from './sessions-view.js';
import type {
  LayoutShape,
  LiveSession,
  LauncherState,
  LocalServer,
  RestorableSummary,
  ProjectConfigInfo,
  RecentDir,
  ResumableAgentSession,
} from '@tabterm/shared';

/**
 * The panel a fresh terminal tab opens with.
 *
 * It sits over a live shell rather than replacing it. The shell is already running in the home
 * directory and already has focus, so someone who wants to type just types and the panel gets
 * out of the way on the first keystroke. Nobody has to dismiss anything to start working.
 *
 * A section with nothing in it is not rendered at all, so an empty plugin list shows no plugin
 * heading rather than an empty one.
 */

export interface LauncherOptions {
  root: HTMLElement;
  onLaunchAgent: (path: string) => void;
  onChooseDir: (path: string) => void;
  onCreateLayout: (
    path: string,
    panes: number,
    direction: 'horizontal' | 'vertical',
    shape?: LayoutShape,
  ) => void;
  /** Save the current folder as a template that runs a command in each pane. */
  onAddTemplate: (path: string) => void;
  /** A drop carried no path, which is what a Finder drag does. See ADR-0014. */
  onDropRejected?: () => void;
  onPinDir: (path: string, pinned: boolean) => void;
  onForgetDir: (path: string) => void;
  /** Ask the daemon what a directory declares. Answers arrive via projectConfig(). */
  onInspectProject: (path: string) => void;
  onDecideProjectTrust: (info: ProjectConfigInfo, decision: 'trusted' | 'denied') => void;
  onOpenProject: (path: string) => void;
  onResumeAgent: (session: ResumableAgentSession) => void;
  onRestore: (workspaceId: string, replayCommands: boolean) => void;
  /** Open a session that already exists, wherever it currently is. */
  onOpenSession: (session: LiveSession) => void;
  /** Ask the daemon to complete a folder path. The answer arrives via pathCompletion(). */
  onCompletePath: (partial: string) => void;
  onCloseSession: (session: LiveSession) => void;
  onForgetRestorable: (workspaceId: string) => void;
  onOpenServer: (port: number) => void;
  onAttachServer: (server: LocalServer) => void;
  onStopServer: (server: LocalServer, restart: boolean) => void;
  onDismiss: () => void;
}

/**
 * How many rows each section shows.
 *
 * This is a shortcut, not an inventory. A start page that lists everything is a page you have to
 * read, and the whole point is to not have to: what is worth showing is the handful you would
 * plausibly want, and anything else is reachable by typing a path.
 */
const MAX_RECENT = 6;
const MAX_RESTORE = 3;
const MAX_RESUME = 3;

export class Launcher {
  readonly #opts: LauncherOptions;
  readonly #el: HTMLElement;
  #state: LauncherState | null = null;
  #dismissed = false;
  /** Per directory, what the daemon reported. Absent means not asked or nothing there. */
  readonly #projects = new Map<string, ProjectConfigInfo>();
  /**
   * Directories already asked about, including the ones that answered "nothing here".
   *
   * Separate from #projects precisely because a negative answer stores nothing, and "stores
   * nothing" and "never asked" have to be distinguishable or the question repeats forever.
   */
  readonly #asked = new Set<string>();
  #expanded: string | null = null;
  #resumable: readonly ResumableAgentSession[] = [];
  #servers: readonly LocalServer[] = [];
  #restorable: readonly RestorableSummary[] = [];
  #expandedRestore: string | null = null;
  /** Which server is asking for confirmation, and for what. */
  #confirming: { sessionId: string; restart: boolean } | null = null;

  constructor(opts: LauncherOptions) {
    this.#opts = opts;
    this.#el = document.createElement('div');
    this.#el.className = 'launcher';
    this.#el.hidden = true;
    opts.root.append(this.#el);
  }

  get dismissed(): boolean {
    return this.#dismissed;
  }

  /** Sessions the daemon says exist, refreshed whenever it tells us. */
  /** Whether the start screen is on screen, which means this tab has not been used yet. */
  get isShowing(): boolean {
    return !this.#dismissed && !this.#el.hidden;
  }

  setLiveSessions(sessions: readonly LiveSession[]): void {
    this.#liveSessions = [...sessions];
    if (!this.#dismissed) this.render();
  }

  setState(state: LauncherState): void {
    this.#state = state;
    if (!this.#dismissed) this.render();
  }

  /**
   * Called as soon as anything is sent to the shell.
   *
   * The panel never comes back on its own: once you have started working, having a panel
   * reappear over your terminal would be worse than never having shown it.
   */
  dismiss(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    this.#el.hidden = true;
    this.#el.replaceChildren();
    this.#opts.onDismiss();
  }

  #liveSessions: LiveSession[] = [];
  #dirInput: HTMLInputElement | null = null;
  /** Which layout Return will run. Open, because that is what almost everybody wants. */
  #selectedAction = 0;
  #completionList: HTMLElement | null = null;
  #browsing = false;
  #browsePath = '~/';
  #browserEl: HTMLElement | null = null;

  /**
   * The answer to a Tab press.
   *
   * The completion is filled in, and the alternatives are shown only when Tab could not decide,
   * which is what a shell does and what stops the list being permanent furniture.
   */
  pathCompletion(reply: { partial: string; completed: string; matches: readonly string[] }): void {
    // While browsing, a reply is a directory listing rather than a suggestion for the box.
    if (this.#browsing && reply.partial === this.#browsePath) {
      this.#renderBrowser(reply.matches);
      return;
    }
    const input = this.#dirInput;
    // A reply to a keystroke that has since been replaced is not an answer to anything.
    if (!input || input.value.trim() !== reply.partial) return;

    if (reply.completed !== reply.partial) input.value = reply.completed;
    this.#clearCompletion();
    if (reply.matches.length < 2) return;

    const list = document.createElement('div');
    list.className = 'launcher-completions';
    for (const match of reply.matches) {
      const item = document.createElement('button');
      item.className = 'launcher-completion';
      item.textContent = match;
      item.addEventListener('click', () => {
        const base = input.value.slice(0, input.value.lastIndexOf('/') + 1);
        input.value = `${base}${match}/`;
        this.#clearCompletion();
        input.focus();
      });
      list.append(item);
    }
    input.parentElement?.append(list);
    this.#completionList = list;
  }

  /**
   * The folder browser.
   *
   * Kept deliberately small: where you are, what is inside it, a way up, and a way to accept.
   * It reads through the same `complete-path` the box uses, so there is one implementation of
   * "what folders are in here" rather than two that can disagree.
   */
  #openBrowser(): void {
    const input = this.#dirInput;
    if (!input) return;
    const at = input.value.trim() || '~/';
    this.#browsePath = at.endsWith('/') ? at : `${at}/`;
    this.#opts.onCompletePath(this.#browsePath);
  }

  #closeBrowser(): void {
    this.#browsing = false;
    this.#browserEl?.remove();
    this.#browserEl = null;
  }

  /** Draw the listing for wherever the browser currently is. */
  #renderBrowser(entries: readonly string[]): void {
    const input = this.#dirInput;
    if (!input) return;
    this.#browserEl?.remove();

    const panel = document.createElement('div');
    panel.className = 'launcher-browser';

    const header = document.createElement('div');
    header.className = 'launcher-browser-path';
    header.textContent = this.#browsePath;
    panel.append(header);

    const list = document.createElement('div');
    list.className = 'launcher-browser-list';

    const go = (path: string): void => {
      this.#browsePath = path.endsWith('/') ? path : `${path}/`;
      this.#opts.onCompletePath(this.#browsePath);
    };

    // Up first, since it is the one entry that is always there and always in the same place.
    if (this.#browsePath !== '/' && this.#browsePath !== '~/') {
      const up = document.createElement('button');
      up.className = 'launcher-browser-item is-up';
      up.textContent = '..';
      up.addEventListener('click', () => {
        const trimmed = this.#browsePath.replace(/\/$/, '');
        const parent = trimmed.slice(0, trimmed.lastIndexOf('/'));
        go(parent === '' ? '/' : parent);
      });
      list.append(up);
    }

    for (const name of entries) {
      const item = document.createElement('button');
      item.className = 'launcher-browser-item';
      item.textContent = name;
      item.addEventListener('click', () => go(`${this.#browsePath}${name}`));
      list.append(item);
    }
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'launcher-browser-empty';
      empty.textContent = 'No folders in here';
      list.append(empty);
    }
    panel.append(list);

    const use = document.createElement('button');
    use.className = 'launcher-chip is-selected';
    use.textContent = 'Use this folder';
    use.addEventListener('click', () => {
      input.value = this.#browsePath.replace(/\/$/, '') || '/';
      this.#closeBrowser();
      input.focus();
    });
    panel.append(use);

    input.parentElement?.append(panel);
    this.#browserEl = panel;
  }

  #clearCompletion(): void {
    this.#completionList?.remove();
    this.#completionList = null;
  }

  render(): void {
    if (this.#dismissed || !this.#state) return;
    const state = this.#state;

    const sections: HTMLElement[] = [];

    /**
     * What is already running comes first.
     *
     * A session with no tab showing it is invisible everywhere else in the product, and it is
     * the thing most worth seeing on a page whose whole job is "what do you want to do".
     */
    if (this.#liveSessions.length > 0) {
      sections.push(
        buildSessions({
          sessions: () => this.#liveSessions,
          onOpen: (session) => this.#opts.onOpenSession(session),
          onClose: (session) => this.#opts.onCloseSession(session),
          home: state.home,
        }),
      );
    }

    // --- new layout in a directory ---------------------------------------
    sections.push(this.#layoutSection(state));
    const restorable = this.#restoreSection(state.home);
    if (restorable) sections.push(restorable);
    const servers = this.#serverSection(state.home);
    if (servers) sections.push(servers);
    const resume = this.#resumeSection(state.home);
    if (resume) sections.push(resume);

    // --- recent directories ----------------------------------------------
    if (state.recentDirs.length > 0) {
      sections.push(
        section(
          'Recent folders',
          state.recentDirs.slice(0, MAX_RECENT).map((d) => this.#dirRow(d, state.home)),
        ),
      );
    }

    // --- plugins ----------------------------------------------------------
    // Rendered only when there is something to render. An empty heading is noise.
    if (state.plugins.length > 0) {
      sections.push(
        section(
          'Plugins',
          state.plugins.map((p) => {
            const row = document.createElement('button');
            row.className = 'launcher-row';
            row.append(strong(p.title), dim(p.description ?? ''));
            return row;
          }),
        ),
      );
    }

    const hint = document.createElement('div');
    hint.className = 'launcher-hint';
    hint.textContent = 'Start typing to use the shell. Command+K for history and saved commands.';

    /**
     * The sections scroll, the hint does not.
     *
     * They used to be siblings inside a panel that clips and fades at its bottom edge, so the
     * hint was always the thing being faded out, and a long list of folders pushed it into the
     * part that is cut off entirely. Putting the scrolling and the fade on the body leaves the
     * hint readable wherever the list ends.
     */
    const body = document.createElement('div');
    body.className = 'launcher-body';
    body.replaceChildren(...sections);

    this.#el.replaceChildren(body, hint);
    this.#el.hidden = false;
  }

  #layoutSection(state: LauncherState): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'launcher-section';
    wrap.append(heading('Open a folder'));

    const form = document.createElement('div');
    form.className = 'launcher-form';

    /**
     * Browse for a folder.
     *
     * Not a native dialog: a Chrome extension cannot learn an absolute path from one, since
     * `webkitdirectory` reports paths relative to whatever was chosen and the File System Access
     * API returns an opaque handle. This asks the daemon instead, which can read the filesystem,
     * and reuses the same completion the box already uses: a path ending in a slash lists what
     * is inside it.
     */
    const browse = document.createElement('button');
    browse.className = 'launcher-browse';
    browse.type = 'button';
    browse.title = 'Browse for a folder';
    browse.textContent = 'Browse';
    browse.addEventListener('click', () => {
      this.#browsing = !this.#browsing;
      if (this.#browsing) this.#openBrowser();
      else this.#closeBrowser();
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'launcher-input';
    input.placeholder = '~/Projects/something';
    input.spellcheck = false;
    this.#dirInput = input;

    // Typing a path here must not reach the shell underneath.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const path = input.value.trim();
        if (path) this.#opts.onChooseDir(path);
      }
      if (e.key === 'Escape') this.dismiss();
      /**
       * Tab completes the folder, the way it does in a terminal.
       *
       * Answered by the daemon, since a page cannot read a disk. `preventDefault` matters as
       * much as the completion: Tab in a text field moves focus, and losing the box you were
       * typing in is a worse outcome than not completing.
       */
      if (e.key === 'Tab') {
        e.preventDefault();
        this.#opts.onCompletePath(input.value.trim() || '~/');
      }
    });
    // A new keystroke makes any pending suggestion stale.
    input.addEventListener('input', () => this.#clearCompletion());

    /**
     * Dropping a path in.
     *
     * `text/uri-list` and `text/plain` are what another application hands over when it drags
     * something it thinks of as a path, and they carry a real one. A file dragged from Finder
     * does **not**: HTML5 drag and drop yields a `File` with a name and no path, which ADR-0014
     * cut the feature over. So this takes what is genuinely offered and says plainly when a drop
     * carried nothing usable, rather than failing silently and looking broken.
     */
    input.addEventListener('dragover', (e) => {
      e.preventDefault();
      input.classList.add('is-drop-target');
    });
    input.addEventListener('dragleave', () => input.classList.remove('is-drop-target'));
    input.addEventListener('drop', (e) => {
      e.preventDefault();
      input.classList.remove('is-drop-target');
      const path = pathFromDrop(e.dataTransfer);
      if (path) {
        input.value = path;
        input.focus();
        this.#clearCompletion();
        return;
      }
      // Nothing usable, which is what a Finder drag produces. Say so where it was dropped.
      input.classList.add('is-drop-refused');
      setTimeout(() => input.classList.remove('is-drop-refused'), 1200);
      this.#opts.onDropRejected?.();
    });

    const buttons = document.createElement('div');
    buttons.className = 'launcher-buttons';

    /**
     * The layouts, with one selected.
     *
     * Choosing a folder no longer starts anything: it sets the path, and a layout button starts
     * it. `Open` is selected from the outset because it is what almost everybody wants, and the
     * selection moves with Tab so the whole box can be driven from the keyboard. The selected
     * one carries the outline, which is why `Open agent here` no longer looks like a default it
     * never was.
     */
    const actions: {
      label: string;
      run: (path: string) => void;
      title: string;
    }[] = [
      {
        label: 'Open',
        title: 'One terminal in this folder',
        run: (path) => this.#opts.onChooseDir(path),
      },
      {
        label: 'Split in 2',
        title: 'Two side by side',
        run: (path) => this.#opts.onCreateLayout(path, 2, 'horizontal', 'columns'),
      },
      {
        label: '1 + 2',
        title: 'One on the left, two stacked on the right',
        run: (path) => this.#opts.onCreateLayout(path, 3, 'horizontal', 'one-plus-two'),
      },
      {
        label: '4 panes',
        title: 'One in each corner',
        run: (path) => this.#opts.onCreateLayout(path, 4, 'horizontal', 'quad'),
      },
      {
        label: 'Open agent here',
        title: 'Start an agent CLI in this folder',
        run: (path) => this.#opts.onLaunchAgent(path),
      },
    ];

    const chips: HTMLButtonElement[] = [];
    const select = (index: number): void => {
      this.#selectedAction = (index + actions.length) % actions.length;
      chips.forEach((chip, i) => chip.classList.toggle('is-selected', i === this.#selectedAction));
    };

    for (const [index, action] of actions.entries()) {
      const chip = document.createElement('button');
      chip.className = 'launcher-chip';
      chip.textContent = action.label;
      /**
       * The number is shown, not just bound.
       *
       * A shortcut nobody can see is a shortcut nobody uses, and this is the one place where
       * the whole set is visible at once.
       */
      const key = document.createElement('kbd');
      key.textContent = String(index + 1);
      chip.append(key);
      chip.title = `${action.title}  (Control ${String(index + 1)})`;
      chip.addEventListener('click', () => {
        select(index);
        action.run(input.value.trim() || state.home);
      });
      // Clicking or tabbing to a chip selects it, so what Return will do is always visible.
      chip.addEventListener('focus', () => select(index));
      chips.push(chip);
      buttons.append(chip);
    }

    const addTemplate = document.createElement('button');
    addTemplate.className = 'launcher-chip launcher-add-template';
    addTemplate.textContent = '+';
    addTemplate.title = 'Save this layout as a template that runs a command in each pane';
    addTemplate.addEventListener('click', () => {
      this.#opts.onAddTemplate(input.value.trim() || state.home);
    });
    buttons.append(addTemplate);

    select(this.#selectedAction);

    /**
     * Tab moves between the layouts, Return runs the selected one.
     *
     * Handled on the input, because that is where somebody is typing when they decide. Tab in a
     * text field would otherwise move focus out of the box entirely, and the completion handler
     * above has first claim on it while there is a path fragment to complete.
     */
    input.addEventListener('keydown', (e) => {
      /**
       * Control and a number runs a layout directly.
       *
       * Tab belongs to path completion in this box and cannot also cycle these. Command is
       * Chrome's, which takes Command and a number for switching tabs and never delivers it to
       * a page. Option would work but types a character on macOS, so it only behaves if every
       * handler remembers to suppress it. Control is claimed by nothing here and produces
       * nothing on its own, which makes it the one that stays correct by default.
       */
      if (e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        if (index < actions.length) {
          e.preventDefault();
          select(index);
          actions[index]?.run(input.value.trim() || state.home);
        }
        return;
      }
      if (e.key === 'ArrowRight' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        select(this.#selectedAction + (e.shiftKey ? -1 : 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        actions[this.#selectedAction]?.run(input.value.trim() || state.home);
      }
    });

    const note = document.createElement('div');
    note.className = 'launcher-note';
    note.textContent = 'The folder is created if it does not exist.';

    form.append(browse, input, buttons);
    wrap.append(form, note);
    return wrap;
  }

  /** Workspaces that could be brought back after a restart. */
  setRestorable(workspaces: readonly RestorableSummary[]): void {
    this.#restorable = workspaces;
    if (!this.#dismissed) this.render();
  }

  /**
   * The restore offer.
   *
   * Deliberately blunt about what it does. A restart killed the processes and nothing can bring
   * them back, so the wording says "reopen" rather than "resume", and the panel spells out that
   * these will be new shells. A terminal that implies otherwise is lying to someone about
   * whether their build is still running.
   */
  #restoreSection(home: string): HTMLElement | null {
    if (this.#restorable.length === 0) return null;

    const rows = this.#restorable.slice(0, MAX_RESTORE).map((entry) => {
      const wrap = document.createElement('div');
      wrap.className = 'launcher-row-wrap';

      const main = document.createElement('button');
      main.className = 'launcher-row';
      const dirs = entry.panes.map((p) => shorten(p.cwd, home).split('/').pop() ?? '').join(', ');
      main.append(
        strong(`${String(entry.paneCount)} pane${entry.paneCount === 1 ? '' : 's'}`),
        dim(`${dirs} · ${relativeAge(entry.savedAt)}`),
      );
      main.addEventListener('click', () => {
        this.#expandedRestore =
          this.#expandedRestore === entry.workspaceId ? null : entry.workspaceId;
        this.render();
      });

      const forget = document.createElement('button');
      forget.className = 'launcher-icon';
      forget.title = 'Forget this layout';
      forget.textContent = '×';
      forget.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#opts.onForgetRestorable(entry.workspaceId);
      });

      wrap.append(main, forget);
      if (this.#expandedRestore !== entry.workspaceId) return wrap;

      const panel = document.createElement('div');
      panel.className = 'launcher-project';

      const warn = document.createElement('div');
      warn.className = 'launcher-project-warn';
      warn.textContent = 'These will be new shells. The original processes did not survive.';
      panel.append(warn);

      const list = document.createElement('ul');
      list.className = 'launcher-project-commands';
      for (const pane of entry.panes) {
        const li = document.createElement('li');
        li.textContent = pane.lastCommand
          ? `${shorten(pane.cwd, home)} — last ran: ${pane.lastCommand}`
          : shorten(pane.cwd, home);
        list.append(li);
      }
      panel.append(list);

      const buttons = document.createElement('div');
      buttons.className = 'launcher-buttons';

      const plain = document.createElement('button');
      plain.className = 'launcher-chip primary';
      plain.textContent = 'Reopen the layout';
      plain.addEventListener('click', () => this.#opts.onRestore(entry.workspaceId, false));
      buttons.append(plain);

      // Only offered when there is something to replay, and even then the command is typed at
      // the prompt rather than run, so a destructive one is seen before it happens.
      if (entry.panes.some((p) => p.lastCommand)) {
        const replay = document.createElement('button');
        replay.className = 'launcher-chip';
        replay.textContent = 'Reopen and retype the last commands';
        replay.title = 'The commands are placed at each prompt. You still press Enter.';
        replay.addEventListener('click', () => this.#opts.onRestore(entry.workspaceId, true));
        buttons.append(replay);
      }

      panel.append(buttons);
      const group = document.createElement('div');
      group.className = 'launcher-row-group';
      group.append(wrap, panel);
      return group;
    });

    return section('Reopen from before the restart', rows);
  }

  /** Local servers the daemon attributed to a session. */
  setServers(servers: readonly LocalServer[]): void {
    this.#servers = servers;
    // A server that disappeared cannot still be waiting on a confirmation.
    if (this.#confirming && !servers.some((s) => s.sessionId === this.#confirming?.sessionId)) {
      this.#confirming = null;
    }
    if (!this.#dismissed) this.render();
  }

  /**
   * Running servers, with what you would actually want to do about one.
   *
   * Stopping and restarting ask first. Everything else here is reversible; those two are not,
   * and a misplaced click would take down something the user is in the middle of using.
   */
  #serverSection(home: string): HTMLElement | null {
    if (this.#servers.length === 0) return null;

    const rows = this.#servers.map((server) => {
      const wrap = document.createElement('div');
      wrap.className = 'launcher-row-wrap';

      const main = document.createElement('button');
      main.className = 'launcher-row';
      main.append(
        strong(`localhost:${String(server.port)}`),
        dim(`${server.command ? `${server.command} · ` : ''}${shorten(server.cwd, home)}`),
      );
      main.addEventListener('click', () => this.#opts.onOpenServer(server.port));
      wrap.append(main);

      const chip = (label: string, title: string, run: () => void) => {
        const b = document.createElement('button');
        b.className = 'launcher-chip';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          run();
        });
        wrap.append(b);
      };

      chip('Terminal', 'Focus the tab running this server', () =>
        this.#opts.onAttachServer(server),
      );
      chip('Stop', 'Interrupt this server', () => {
        this.#confirming = { sessionId: server.sessionId, restart: false };
        this.render();
      });
      chip('Restart', 'Interrupt it and run the same command again', () => {
        this.#confirming = { sessionId: server.sessionId, restart: true };
        this.render();
      });

      if (this.#confirming?.sessionId !== server.sessionId) return wrap;

      const confirm = document.createElement('div');
      confirm.className = 'launcher-project';
      const text = document.createElement('div');
      text.className = 'launcher-project-warn';
      text.textContent = this.#confirming.restart
        ? `Restart whatever is serving port ${String(server.port)}?`
        : `Stop whatever is serving port ${String(server.port)}?`;
      const note = document.createElement('div');
      note.className = 'launcher-dim';
      note.textContent = 'An interrupt is sent to the terminal, the same as pressing Ctrl+C in it.';

      const buttons = document.createElement('div');
      buttons.className = 'launcher-buttons';
      const go = document.createElement('button');
      go.className = 'launcher-chip primary';
      go.textContent = this.#confirming.restart ? 'Restart it' : 'Stop it';
      const restart = this.#confirming.restart;
      go.addEventListener('click', () => {
        this.#confirming = null;
        this.#opts.onStopServer(server, restart);
      });
      const cancel = document.createElement('button');
      cancel.className = 'launcher-chip';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        this.#confirming = null;
        this.render();
      });
      buttons.append(go, cancel);
      confirm.append(text, note, buttons);

      const group = document.createElement('div');
      group.className = 'launcher-row-group';
      group.append(wrap, confirm);
      return group;
    });

    return section('Running servers', rows);
  }

  /** Agent sessions that could be picked back up. Shown, never resumed automatically. */
  setResumable(sessions: readonly ResumableAgentSession[]): void {
    this.#resumable = sessions;
    if (!this.#dismissed) this.render();
  }

  #resumeSection(home: string): HTMLElement | null {
    if (this.#resumable.length === 0) return null;
    const rows = this.#resumable.slice(0, MAX_RESUME).map((session) => {
      const row = document.createElement('button');
      row.className = 'launcher-row';
      row.append(
        strong(session.summary ?? `Session ${session.sessionId.slice(0, 8)}`),
        dim(shorten(session.cwd, home)),
      );
      row.title = session.sessionId;
      row.addEventListener('click', () => this.#opts.onResumeAgent(session));
      return row;
    });
    return section('Resume an agent session', rows);
  }

  /** Record what a directory declares, and show it. */
  projectConfig(cwd: string, config: ProjectConfigInfo | null): void {
    // A directory with no config is recorded as asked-and-answered, not forgotten. Deleting it
    // meant the next render asked again, the answer triggered another render, and so on: a
    // busy loop that sent thousands of messages a second. Nothing looked broken, because the
    // loop is invisible; what showed was every other message being starved behind it, which
    // presents as typing doing nothing.
    this.#asked.add(cwd);
    if (config) this.#projects.set(cwd, config);
    else this.#projects.delete(cwd);
    if (!this.#dismissed) this.render();
  }

  /**
   * The approval prompt.
   *
   * It shows every command the file declares, exactly as written, because approving a summary
   * is not approving anything. A changed file says so plainly rather than quietly re-asking:
   * the person needs to know they trusted this once already.
   */
  #projectPanel(dir: RecentDir, info: ProjectConfigInfo): HTMLElement {
    const box = document.createElement('div');
    box.className = 'launcher-project';

    const title = document.createElement('div');
    title.className = 'launcher-project-title';
    title.textContent = info.name;
    box.append(title);

    if (info.changedSince) {
      const warn = document.createElement('div');
      warn.className = 'launcher-project-warn';
      warn.textContent =
        info.changedSince === 'trusted'
          ? 'This file has changed since you approved it. Review it again.'
          : 'This file has changed since you rejected it.';
      box.append(warn);
    }

    const path = document.createElement('div');
    path.className = 'launcher-dim';
    path.textContent = info.path;
    box.append(path);

    const list = document.createElement('ul');
    list.className = 'launcher-project-commands';
    for (const argv of info.commands) {
      const li = document.createElement('li');
      // textContent, never innerHTML: this string came from a cloned repository.
      li.textContent = argv.length ? argv.join(' ') : '(shell)';
      list.append(li);
    }
    if (info.commands.length) box.append(list);

    const buttons = document.createElement('div');
    buttons.className = 'launcher-buttons';

    if (info.action === 'offer') {
      const open = document.createElement('button');
      open.className = 'launcher-chip primary';
      open.textContent = `Open (${String(info.paneCount)} panes)`;
      open.addEventListener('click', () => this.#opts.onOpenProject(dir.path));
      const revoke = document.createElement('button');
      revoke.className = 'launcher-chip';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => this.#opts.onDecideProjectTrust(info, 'denied'));
      buttons.append(open, revoke);
    } else {
      const approve = document.createElement('button');
      approve.className = 'launcher-chip primary';
      approve.textContent = 'Approve and open';
      approve.addEventListener('click', () => {
        this.#opts.onDecideProjectTrust(info, 'trusted');
        this.#opts.onOpenProject(dir.path);
      });
      const reject = document.createElement('button');
      reject.className = 'launcher-chip';
      reject.textContent = 'Never for this project';
      reject.addEventListener('click', () => this.#opts.onDecideProjectTrust(info, 'denied'));
      buttons.append(approve, reject);
    }

    box.append(buttons);
    return box;
  }

  #dirRow(dir: RecentDir, home: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'launcher-row-wrap';

    const main = document.createElement('button');
    main.className = 'launcher-row';
    main.append(strong(dir.name), dim(shorten(dir.path, home)));
    // Only when the directory is somewhere *inside* a repository. Repeating the name on the
    // root itself would say the same thing twice.
    if (dir.project && dir.project.root !== dir.path) {
      const badge = document.createElement('span');
      badge.className = 'launcher-badge';
      badge.textContent = dir.project.name;
      badge.title = dir.project.root;
      main.append(badge);
    }
    main.addEventListener('click', () => this.#opts.onChooseDir(dir.path));

    const pin = document.createElement('button');
    pin.className = `launcher-icon${dir.pinned ? ' on' : ''}`;
    pin.title = dir.pinned ? 'Unpin' : 'Pin';
    pin.textContent = dir.pinned ? '★' : '☆';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#opts.onPinDir(dir.path, !dir.pinned);
    });

    const forget = document.createElement('button');
    forget.className = 'launcher-icon';
    forget.title = 'Forget';
    forget.textContent = '×';
    forget.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#opts.onForgetDir(dir.path);
    });

    row.append(main, pin, forget);

    // Ask about each listed directory once, ever. Bounded by what is on screen, so this is a
    // handful of stat calls on tab open rather than a scan.
    if (!this.#asked.has(dir.path)) {
      this.#asked.add(dir.path);
      this.#opts.onInspectProject(dir.path);
    }

    const info = this.#projects.get(dir.path);
    if (!info || info.action === 'ignore') return row;

    const chip = document.createElement('button');
    chip.className = `launcher-chip project${info.action === 'ask' ? ' unreviewed' : ''}`;
    chip.textContent = info.action === 'offer' ? 'Project layout' : 'Project layout (review)';
    chip.title = info.path;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#expanded = this.#expanded === dir.path ? null : dir.path;
      this.render();
    });
    row.insertBefore(chip, pin);

    if (this.#expanded !== dir.path) return row;

    const wrap = document.createElement('div');
    wrap.className = 'launcher-row-group';
    wrap.append(row, this.#projectPanel(dir, info));
    return wrap;
  }
}

// --- small DOM helpers -------------------------------------------------

function heading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'launcher-heading';
  h.textContent = text;
  return h;
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'launcher-section';
  wrap.append(heading(title), ...rows);
  return wrap;
}

function strong(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'launcher-strong';
  el.textContent = text;
  return el;
}

function dim(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'launcher-dim';
  el.textContent = text;
  return el;
}

/** Plain words for how long ago, because a timestamp in a launcher row helps nobody. */
function relativeAge(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

export function shorten(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * A usable path out of a drop, or nothing.
 *
 * `file://` URLs need decoding, since a dragged path with a space arrives percent encoded and
 * would otherwise open a directory that does not exist.
 */
export function pathFromDrop(data: DataTransfer | null): string {
  if (!data) return '';
  const uri = data.getData('text/uri-list').split('\n')[0]?.trim() ?? '';
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return '';
    }
  }
  const text = data.getData('text/plain').trim();
  // A path, not a sentence somebody happened to drag.
  if (text.startsWith('/') || text.startsWith('~/')) return text.split('\n')[0] ?? '';
  return '';
}
