import { buildSessions } from './sessions-view.js';
import { resolveTypedPath, unresolveTypedPath } from './typed-path.js';
import { panesFor, type LayoutTemplate } from './templates.js';
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
  onSaveTemplate: (template: LayoutTemplate) => void;
  onRunTemplate: (template: LayoutTemplate) => void;
  onDeleteTemplate: (id: string) => void;
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
  /** Ask whether a folder is there, as it is typed. The answer arrives via folderChecked(). */
  onCheckFolder: (path: string) => void;
  onCreateFolder: (path: string) => void;
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
/**
 * Four, not three.
 *
 * The daemon takes turns between the agents, so three rows showed two of one and one of the
 * other. Four gives each of them a pair, which is what makes "resume the one before last"
 * possible without a picker.
 */
const MAX_RESUME = 4;

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
    // Anything bound outside this element goes with it. Control and a number is not ours once
    // the start screen is gone, and a listener left on the document would still be claiming it.
    for (const undo of this.#teardown.splice(0)) undo();
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
  /** What the daemon last said about the folder in the box. */
  #folderState: { path: string; exists: boolean; isFile?: boolean; error?: string } | null = null;
  #checkTimer = 0;
  #templateFormEl: HTMLElement | null = null;
  #templates: LayoutTemplate[] = [];

  /** Templates the daemon-independent store gave us. Rendered as chips of their own. */
  setTemplates(templates: readonly LayoutTemplate[]): void {
    this.#templates = [...templates];
    if (!this.#dismissed) this.render();
  }

  /**
   * The answer to a Tab press.
   *
   * The completion is filled in, and the alternatives are shown only when Tab could not decide,
   * which is what a shell does and what stops the list being permanent furniture.
   */
  /**
   * Whether the folder in the box is there.
   *
   * Answered against the text that was asked about, so a reply to a keystroke that has since
   * been replaced is discarded rather than shown against something else.
   */
  folderChecked(reply: { path: string; exists: boolean; isFile?: boolean; error?: string }): void {
    if (this.#dirInput === null) return;
    // Compared against what was asked, which is the resolved form: the box may say `Documents`
    // while the question was about `~/Documents`.
    if (this.#resolved(this.#dirInput.value) !== reply.path) return;
    this.#folderState = reply;
    this.#renderFolderState();
  }

  /** Drawn in place rather than through a full render, which would take the cursor with it. */
  #renderFolderState(): void {
    const slot = this.#el.querySelector('.launcher-folder-state');
    if (!(slot instanceof HTMLElement)) return;
    slot.replaceChildren();

    const state = this.#folderState;
    const typed = this.#dirInput?.value.trim() ?? '';
    /**
     * Compared against the **resolved** path, which is what was asked about.
     *
     * The box may say `Documents` while the question was about `~/Documents`, so comparing the
     * answer to the raw text meant a bare path never matched and the state stayed blank: the
     * check ran, the daemon answered, and nothing was ever shown.
     */
    if (!state || typed === '' || state.path !== this.#resolved(typed)) return;

    if (state.exists) {
      slot.className = 'launcher-folder-state is-good';
      slot.textContent = 'folder exists';
      return;
    }
    if (state.isFile === true) {
      slot.className = 'launcher-folder-state is-bad';
      slot.textContent = 'that is a file, not a folder';
      return;
    }

    slot.className = 'launcher-folder-state is-missing';
    const label = document.createElement('span');
    label.textContent = state.error ?? 'no folder there yet';
    const make = document.createElement('button');
    make.className = 'launcher-create-folder';
    make.textContent = 'Create folder';
    make.addEventListener('click', () => this.#opts.onCreateFolder(typed));
    slot.append(label, make);
  }

  pathCompletion(reply: { partial: string; completed: string; matches: readonly string[] }): void {
    // While browsing, a reply is a directory listing rather than a suggestion for the box.
    if (this.#browsing && reply.partial === this.#browsePath) {
      this.#renderBrowser(reply.matches);
      return;
    }
    const input = this.#dirInput;
    // A reply to a keystroke that has since been replaced is not an answer to anything.
    if (!input || this.#resolved(input.value) !== reply.partial) return;

    // Put back the way it was asked: they typed `Doc`, so they see `Documents` rather than a
    // tilde appearing under their cursor.
    if (reply.completed !== reply.partial) {
      input.value = unresolveTypedPath(reply.completed, input.value);
    }
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
  /**
   * What is in the box, as a path.
   *
   * One place, so opening, completing, checking and browsing cannot disagree about what
   * `Documents` means. See `typed-path.ts`.
   */
  #resolved(typed: string): string {
    return resolveTypedPath(typed, this.#state?.home ?? '~');
  }

  /**
   * Control and a number runs a layout.
   *
   * Bound on the box **and** on the document, because the shortcut is about the start screen
   * rather than about the text field: pressing it after clicking a chip, or a folder, or
   * nothing at all did nothing, which reads as the shortcut being broken rather than as it
   * belonging to a control that happens not to have focus.
   *
   * Tab belongs to path completion in this box and cannot also cycle these. Command is Chrome's,
   * which takes Command and a number for switching tabs and never delivers it to a page. Option
   * types a character on macOS, so it only behaves if every handler remembers to suppress it.
   * Control is claimed by nothing here and produces nothing on its own.
   */
  #runShortcut(
    e: KeyboardEvent,
    actions: readonly { run: (path: string) => void }[],
    input: HTMLInputElement,
  ): boolean {
    if (!e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return false;
    const index = Number(e.key) - 1;
    const action = actions[index];
    if (!action) return false;
    e.preventDefault();
    this.#selectChip?.(index);
    action.run(this.#resolved(input.value));
    return true;
  }

  /** Set while the layout row exists, so the shortcut can move the outline with it. */
  #selectChip: ((index: number) => void) | undefined;

  /** Listeners on things this class does not own, removed when the start screen goes. */
  readonly #teardown: (() => void)[] = [];

  #openBrowser(): void {
    const input = this.#dirInput;
    if (!input) return;
    const at = this.#resolved(input.value);
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

  /**
   * Saving a template: a name, and a command for each pane the shape will make.
   *
   * Inline rather than a dialog, because everything it needs is already on this screen and the
   * folder it is about is in the box above it.
   */
  #showTemplateForm(path: string, shape: LayoutShape = 'single'): void {
    this.#templateFormEl?.remove();
    const panes = panesFor(shape);

    const form = document.createElement('div');
    form.className = 'launcher-template-form';

    const name = document.createElement('input');
    name.className = 'launcher-input';
    name.placeholder = `Name this layout (${String(panes)} pane${panes === 1 ? '' : 's'} in ${path})`;
    name.spellcheck = false;
    name.addEventListener('keydown', (e) => e.stopPropagation());
    form.append(name);

    const commandInputs: HTMLInputElement[] = [];
    for (let i = 0; i < panes; i++) {
      const command = document.createElement('input');
      command.className = 'launcher-input launcher-template-command';
      command.placeholder = `Pane ${String(i + 1)} command, staged not run`;
      command.spellcheck = false;
      command.addEventListener('keydown', (e) => e.stopPropagation());
      commandInputs.push(command);
      form.append(command);
    }

    const row = document.createElement('div');
    row.className = 'launcher-buttons';

    const save = document.createElement('button');
    save.className = 'launcher-chip is-selected';
    save.textContent = 'Save template';
    save.addEventListener('click', () => {
      const label = name.value.trim();
      if (!label) {
        name.focus();
        return;
      }
      void this.#opts.onSaveTemplate({
        id: `t-${String(Date.now())}`,
        name: label,
        path,
        shape,
        panes,
        commands: commandInputs.map((c) => c.value.trim()),
      });
      form.remove();
      this.#templateFormEl = null;
    });

    const cancel = document.createElement('button');
    cancel.className = 'launcher-chip';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      form.remove();
      this.#templateFormEl = null;
    });

    row.append(save, cancel);
    form.append(row);
    this.#dirInput?.parentElement?.append(form);
    this.#templateFormEl = form;
    name.focus();
  }

  #clearCompletion(): void {
    this.#completionList?.remove();
    this.#completionList = null;
  }

  render(): void {
    if (this.#dismissed || !this.#state) return;
    /**
     * Keep what was typed.
     *
     * This rebuilds the whole panel, and it runs whenever the daemon reports anything, including
     * the session list refreshing on its own. Somebody halfway through typing a path would watch
     * it vanish for no reason they could see.
     */
    const typed = this.#dirInput?.value ?? '';
    const hadFocus = document.activeElement === this.#dirInput;
    const state = this.#state;

    const sections: HTMLElement[] = [];

    /**
     * The folder box first, because it is what this screen is for.
     *
     * Running sessions used to come first, on the argument that a session with no tab is
     * invisible everywhere else. That was right until the cards grew previews: with a handful
     * of sessions the layout buttons were pushed **below the fold entirely**, so the primary
     * action on the page could not be reached without scrolling for it. What is already running
     * is still worth seeing, and it is worth seeing second.
     */
    sections.push(this.#layoutSection(state));

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

    if (typed && this.#dirInput) {
      this.#dirInput.value = typed;
      if (hadFocus) this.#dirInput.focus();
    }
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

    /**
     * Typing a path here must not reach the shell underneath.
     *
     * Return is deliberately **not** handled here. A second listener further down runs whichever
     * layout is selected, and `Open` is the one selected from the outset, so acting on Return in
     * both places sent `cd` twice. `stopPropagation` does not prevent that: it stops the event
     * bubbling to an ancestor, and says nothing about another listener on the same element.
     */
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
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
        this.#opts.onCompletePath(this.#resolved(input.value));
      }
    });
    // A new keystroke makes any pending suggestion stale.
    input.addEventListener('input', () => {
      this.#clearCompletion();
      /**
       * Ask whether the folder is there, once typing settles.
       *
       * Debounced, because this is a filesystem call per keystroke otherwise, and the answer
       * for a half-typed path is never the interesting one.
       */
      this.#folderState = null;
      this.#renderFolderState();
      clearTimeout(this.#checkTimer);
      const typed = input.value.trim();
      if (typed === '') return;
      const asked = this.#resolved(typed);
      this.#checkTimer = window.setTimeout(() => this.#opts.onCheckFolder(asked), 260);
    });

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
      shape?: LayoutShape;
    }[] = [
      {
        label: 'Open',
        title: 'One terminal in this folder',
        shape: 'single',
        run: (path) => this.#opts.onChooseDir(path),
      },
      {
        label: 'Split in 2',
        title: 'Two side by side',
        shape: 'columns',
        run: (path) => this.#opts.onCreateLayout(path, 2, 'horizontal', 'columns'),
      },
      {
        label: '1 + 2',
        title: 'One on the left, two stacked on the right',
        shape: 'one-plus-two',
        run: (path) => this.#opts.onCreateLayout(path, 3, 'horizontal', 'one-plus-two'),
      },
      {
        label: '4 panes',
        title: 'One in each corner',
        shape: 'quad',
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
    this.#selectChip = select;

    /**
     * The same shortcut, from anywhere on the start screen.
     *
     * Removed when the start screen goes, so it cannot fire over a terminal: Control and a
     * number is not ours once this is dismissed.
     */
    const onDocumentKey = (e: KeyboardEvent): void => {
      if (this.#dismissed) return;
      // Only when the box does not have it: there it is handled on the box itself.
      if (document.activeElement === input) return;
      this.#runShortcut(e, actions, input);
    };
    document.addEventListener('keydown', onDocumentKey, true);
    this.#teardown.push(() => document.removeEventListener('keydown', onDocumentKey, true));

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
      /**
       * The modifier as well as the number.
       *
       * A bare `1` reads as a label or a count. The shortcut is Control and a number, so the
       * badge says that, using the same glyph the key has on the keyboard.
       */
      key.textContent = `\u2303${String(index + 1)}`;
      chip.append(key);
      chip.title = `${action.title}  (Control ${String(index + 1)})`;
      chip.addEventListener('click', () => {
        select(index);
        action.run(this.#resolved(input.value));
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
      this.#showTemplateForm(this.#resolved(input.value), actions[this.#selectedAction]?.shape);
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

    if (this.#templates.length > 0) {
      const saved = document.createElement('div');
      saved.className = 'launcher-buttons launcher-templates';
      for (const template of this.#templates) {
        const chip = document.createElement('button');
        chip.className = 'launcher-chip launcher-template';
        chip.textContent = template.name;
        chip.title = `${String(template.panes)} panes in ${template.path}`;
        chip.addEventListener('click', () => this.#opts.onRunTemplate(template));
        const remove = document.createElement('span');
        remove.className = 'launcher-template-remove';
        remove.textContent = '×';
        remove.title = 'Forget this template';
        remove.addEventListener('click', (e) => {
          // Without this the click also runs the template it just removed.
          e.stopPropagation();
          this.#opts.onDeleteTemplate(template.id);
        });
        chip.append(remove);
        saved.append(chip);
      }
      form.append(saved);
    }

    const note = document.createElement('div');
    note.className = 'launcher-note';
    note.textContent = 'The folder is created if it does not exist.';

    // Between the box and the buttons: it is about what was typed, and it must not move the
    // buttons around as it appears and goes.
    const folderState = document.createElement('div');
    folderState.className = 'launcher-folder-state';
    /**
     * Browse sits **beside** the box, not above it.
     *
     * As a full-width block over the input it read as the primary way to choose a folder, which
     * it is not: typing is. It is a small button on the left of the thing it helps with.
     */
    const pathRow = document.createElement('div');
    pathRow.className = 'launcher-path-row';
    pathRow.append(browse, input);
    form.append(pathRow, folderState, buttons);
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
      // Both agents are listed together, so each row says which one it is. Without that, two
      // conversations about the same folder are indistinguishable.
      row.append(
        strong(session.summary ?? `Session ${session.sessionId.slice(0, 8)}`),
        dim(`${session.agent} · ${shorten(session.cwd, home)}`),
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
