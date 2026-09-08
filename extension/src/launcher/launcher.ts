import { buildSessions } from './sessions-view.js';
import { resolveTypedPath, unresolveTypedPath } from './typed-path.js';
import { checkShape, previewPanes } from '@tabterm/shared';

/** The fixed shapes, as the syntax would write them, so the dialog opens on what was chosen. */
const SHAPE_AS_TEXT: Record<string, string> = {
  single: '1',
  columns: '1+2',
  rows: '1/2',
  'one-plus-two': '1+(2/3)',
  quad: '(1+2)/(3+4)',
};
import { type LayoutTemplate } from './templates.js';
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
  onChooseDir: (path: string) => void;
  onCreateLayout: (
    path: string,
    panes: number,
    direction: 'horizontal' | 'vertical',
    shape?: LayoutShape,
  ) => void;
  onSaveTemplate: (template: LayoutTemplate) => void;
  onRunTemplate: (template: LayoutTemplate, path: string) => void;
  /** The whole list, in the order it should be shown and numbered. */
  onReorderTemplates: (ids: readonly string[]) => void;
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
  /** Remembered, so a conversation dismissed once does not come back next time. */
  onHideResume: (sessionId: string) => void;
  /** Read a stored conversation, so a row can be told from the two beside it. */
  onReadAgentSession?: (sessionId: string) => void;
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
  /** A click that was not about the path: the shell should take the keyboard. */
  onWantsTerminal?: () => void;
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
  #renderQueued: number | undefined;

  /**
   * One redraw for one change, however many answers that change arrives in.
   *
   * The start screen draws three things the daemon owns, and it asks for all three when it hears
   * that any of them changed. Each answer arrives in its own message and each used to redraw the
   * whole screen: measured, a single command finishing in another tab cost **nine** rebuilds of
   * a list of cards.
   *
   * A short timer rather than a frame, because a tab nobody is looking at still has to keep its
   * screen right, and `requestAnimationFrame` does not run in one. Sixteen milliseconds is long
   * enough to gather answers that were sent together and short enough that nobody sees a delay.
   */
  /**
   * Answers this screen is waiting for before it is worth drawing again.
   *
   * The start screen is made of four things the daemon owns, and it asks for all of them at once
   * on load and whenever it hears any of them changed. Each answer arrives in its own message,
   * a round trip apart, and each used to redraw the whole screen: a refresh drew four different
   * versions of the same page on its way to the right one, which is what "skipping between
   * pages" is.
   *
   * Waiting on a clock cannot fix that, because the answers are not close together in time. So
   * the screen is told what it asked for and draws once, when it has it.
   */
  readonly #awaited = new Set<string>();
  #awaitedUntil = 0;

  /**
   * Called when a batch of requests goes out, naming what will come back.
   *
   * The deadline is the whole safety of it: an answer that never arrives must not leave the
   * screen holding a skeleton, so the wait is bounded and what has arrived is drawn.
   */
  expecting(keys: readonly string[]): void {
    if (this.#dismissed) return;
    for (const key of keys) this.#awaited.add(key);
    /**
     * Short, because this is how long the screen is allowed to be wrong for.
     *
     * The answers arrive together, tens of milliseconds apart, so this is never reached in the
     * ordinary case. It exists for the one that does not come at all, and a long deadline turns
     * that into a visibly late screen: an answer that was never sent held the first drawing for
     * a second and a half, which is worse than drawing without it.
     */
    this.#awaitedUntil = Date.now() + 250;
  }

  /** The answers each drawing was prompted by, so a redraw can say what caused it. */
  readonly #renderLog: { at: number; since: string[] }[] = [];
  readonly #answeredSince = new Set<string>();

  /** What each drawing was prompted by. For checks that count drawings. */
  renderLog(): readonly { at: number; since: string[] }[] {
    return this.#renderLog;
  }

  /** One of them came back. */
  #answered(key: string): void {
    this.#answeredSince.add(key);
    this.#awaited.delete(key);
    this.#scheduleRender();
  }

  /** Whether the batch is still worth waiting for. */
  #stillWaiting(): boolean {
    if (this.#awaited.size === 0) return false;
    if (Date.now() >= this.#awaitedUntil) {
      // Long enough. Draw what there is rather than nothing at all.
      this.#awaited.clear();
      return false;
    }
    return true;
  }

  #renderDueBy = 0;
  #scheduleRender(): void {
    if (this.#dismissed) return;
    const now = Date.now();
    /**
     * Waits for the answers to stop arriving, but never for long.
     *
     * A fixed window only merges answers that arrive inside it, and on a busy machine the three
     * replies to one change can be tens of milliseconds apart: measured under a full test run,
     * eleven redraws for one change rather than one. So each new answer restarts the wait, and a
     * ceiling stops a steady trickle from holding the screen back indefinitely.
     */
    if (this.#renderQueued !== undefined) {
      if (now >= this.#renderDueBy) return;
      clearTimeout(this.#renderQueued);
    } else {
      this.#renderDueBy = now + 120;
    }
    const wait = Math.max(0, Math.min(30, this.#renderDueBy - now));
    this.#renderQueued = window.setTimeout(() => {
      this.#renderQueued = undefined;
      if (this.#dismissed) return;
      if (this.#stillWaiting()) {
        // The rest of the batch is still coming. Look again shortly rather than drawing half.
        this.#scheduleRender();
        return;
      }
      this.#renderLog.push({ at: Math.round(performance.now()), since: [...this.#answeredSince] });
      if (this.#renderLog.length > 20) this.#renderLog.shift();
      this.#answeredSince.clear();
      this.render();
    }, wait);
  }
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
  /** Which conversation is open, if any. One at a time, so the list stays a list. */
  #expandedResume: string | null = null;
  /** Set for the one render after opening one, so it is scrolled to once rather than every time. */
  #justExpanded = false;
  /** Conversations that have been read, by session. Absent means "asked, not back yet". */
  readonly #transcripts = new Map<string, readonly { role: 'you' | 'agent'; text: string }[]>();
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

    /**
     * One box or the other always has the keyboard.
     *
     * Two places on this screen take typing: the path box at the top and the shell at the bottom.
     * Clicking a folder keeps the path box, because the next thing somebody does is type more of
     * a path. Clicking anywhere that is not about the path hands the keyboard to the shell,
     * because that is the only other thing typing can mean here.
     *
     * Neither having it is the state to avoid: the caret disappears, the keystrokes go nowhere
     * anybody can see, and the screen looks frozen.
     *
     * On `mouseup` rather than `mousedown`, so it runs after whatever the click was for, and
     * only for a click that landed on nothing interactive: a button knows what focus it wants.
     */
    this.#el.addEventListener('mouseup', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest('input, textarea, select, button, a, [contenteditable]')) return;
      if (target.closest('.launcher-path-row, .launcher-completions')) {
        this.#dirInput?.focus();
        return;
      }
      this.#opts.onWantsTerminal?.();
    });
  }

  /** Put the keyboard back in the path box, which is what a folder click means. */
  focusPathBox(): void {
    this.#dirInput?.focus();
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
    this.#answered('live');
  }

  setState(state: LauncherState): void {
    this.#state = state;
    this.#answered('state');
  }

  /**
   * Called as soon as anything is sent to the shell.
   *
   * The panel never comes back on its own: once you have started working, having a panel
   * reappear over your terminal would be worse than never having shown it.
   */
  /**
   * Draw it after all, for a tab that turned out to be empty.
   *
   * A reattaching tab holds its start screen back until its screen has arrived, because until
   * then every tab looks empty. When it really is empty, this is what puts it up.
   */
  show(): void {
    if (this.#dismissed) return;
    this.#el.hidden = false;
    this.render();
  }

  dismiss(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    // The template card lives on the page rather than in this element, so it has to be told.
    clearTimeout(this.#cardHideTimer);
    this.#cardPinned = false;
    this.#templateCard?.remove();
    this.#templateCard = null;
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
  #completionList: HTMLElement | null = null;
  /** What the daemon last said about the folder in the box. */
  #folderState: { path: string; exists: boolean; isFile?: boolean; error?: string } | null = null;
  #checkTimer = 0;
  #templateFormEl: HTMLElement | null = null;
  #templates: LayoutTemplate[] = [];

  /** Templates the daemon-independent store gave us. Rendered as chips of their own. */
  setTemplates(templates: readonly LayoutTemplate[]): void {
    this.#templates = [...templates];
    // Named like the rest, because it arrives on its own schedule: templates come from extension
    // storage rather than the daemon, so they land beside the answers and drew a second screen.
    this.#answered('templates');
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
    if (this.#resolved(this.#dirInput.value) !== reply.path) {
      /**
       * Ask again about where we actually are.
       *
       * Discarding an answer to a question nobody is asking any more is right. Discarding it and
       * then waiting is not: the question about the current path may have been the one that was
       * superseded, and then nothing is in flight and the line stays blank for good. The same
       * shape as the folder listing race, in the other half of the same reply.
       */
      this.#askFolderState();
      return;
    }
    this.#awaitingFolderState = null;
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
    /**
     * The resolved path, not the raw text.
     *
     * The box may say `Downloads/deleteme1`, which is a path relative to nothing in particular
     * once it leaves this page: the daemon resolved it against its own working directory and
     * made the folder somewhere nobody was looking, or failed silently. Every other question
     * asked about this box is resolved first, and this one was the exception.
     */
    make.addEventListener('click', () => this.#opts.onCreateFolder(this.#resolved(typed)));
    slot.append(label, make);
  }

  pathCompletion(reply: { partial: string; completed: string; matches: readonly string[] }): void {
    /**
     * A reply about a directory is the list; a reply about a fragment is a completion.
     *
     * Both come from the same `complete-path`, which is what keeps "what folders are in here"
     * a single answer rather than two that can disagree.
     */
    if (reply.partial.endsWith('/')) {
      this.#listing = { dir: reply.partial, entries: reply.matches };
      this.#renderFolders();
      /**
       * Ask again if this answer is about somewhere we have already left.
       *
       * Two requests can be in flight at once, one from a keystroke and one from clicking a
       * folder, and they can come back in either order. When the older one came back last it
       * became the stored listing, `#drawFolders` found it was for the wrong directory and drew
       * nothing, and nothing ever asked again: the list stayed empty until the next keystroke.
       * It only happened when the daemon was busy enough for the replies to overtake each other,
       * which is why it looked like a slow test rather than a race.
       */
      this.#ensureListing();
      return;
    }

    const input = this.#dirInput;
    // A reply to a keystroke that has since been replaced is not an answer to anything.
    if (!input || this.#resolved(input.value) !== reply.partial) return;

    // Put back the way it was asked: they typed `Doc`, so they see `Documents` rather than a
    // tilde appearing under their cursor.
    if (reply.completed !== reply.partial) {
      input.value = unresolveTypedPath(reply.completed, input.value);
      this.#ensureListing();
    }
    this.#renderFolders();
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
    /**
     * Control 1 is the first template, which is the second entry in the row.
     *
     * `Open` is entry zero and has no number: Return in the path box already does it, and a
     * second way to do the same thing is a number that teaches you nothing.
     */
    const index = Number(e.key);
    const action = actions[index];
    if (!action) return false;
    e.preventDefault();
    action.run(this.#resolved(input.value));
    return true;
  }

  /** Listeners on things this class does not own, removed when the start screen goes. */
  readonly #teardown: (() => void)[] = [];

  /**
   * The folders inside wherever the box currently points, always shown.
   *
   * There used to be two ways to find a folder: a `Browse` button that opened a panel beside
   * the box, and a completion list that appeared under it after pressing Tab. They answered the
   * same question with different code, they looked nothing alike, and the panel resized the row
   * it was in, so opening it moved the very box you were typing into.
   *
   * One list now, under the box, filtered by what has been typed. Clicking a folder puts it in
   * the box with a trailing slash and leaves the cursor there, so a path is built by clicking,
   * typing, or Tab, in any mixture, without ever changing tool.
   */
  #listing: { dir: string; entries: readonly string[] } | null = null;

  /** How many to draw. A home directory can hold hundreds and the list is a means, not a view. */
  static readonly #MAX_FOLDERS = 40;

  /**
   * The directory part of what is typed, always ending in a slash.
   *
   * Taken from the typed text and resolved afterwards, not the other way round. Resolving first
   * turns an empty box into the home directory **without** a trailing slash, and cutting at the
   * last slash then listed its parent: an empty box showed the contents of `/Users`.
   */
  #currentDir(): string {
    const typed = this.#dirInput?.value ?? '';
    const cut = typed.lastIndexOf('/');
    const dir = cut === -1 ? '' : typed.slice(0, cut + 1);
    const resolved = this.#resolved(dir);
    return resolved.endsWith('/') ? resolved : `${resolved}/`;
  }

  /** The part after the last slash, which is what filters the list. */
  #currentFragment(): string {
    const typed = this.#dirInput?.value ?? '';
    const cut = typed.lastIndexOf('/');
    return cut === -1 ? typed.trim() : typed.slice(cut + 1).trim();
  }

  /**
   * Ask for a listing, but only when the directory has actually changed.
   *
   * Typing inside one directory filters what is already here, so a keystroke costs nothing.
   * Moving into another asks the daemon once.
   */
  #ensureListing(): void {
    const dir = this.#currentDir();
    if (this.#listing?.dir === dir) return;
    this.#opts.onCompletePath(dir);
  }

  /**
   * Ask whether what is in the box is a folder.
   *
   * Debounced, because otherwise this is a filesystem call per keystroke and the answer for a
   * half-typed path is never the interesting one. Called from clicking as well as typing:
   * setting a value from code fires no `input` event, so choosing a folder used to leave the
   * validity line blank as though nothing had been asked.
   */
  #askFolderState(): void {
    clearTimeout(this.#checkTimer);
    const typed = this.#dirInput?.value.trim() ?? '';
    if (typed === '') return;
    const asked = this.#resolved(typed);
    this.#checkTimer = window.setTimeout(() => {
      this.#awaitingFolderState = asked;
      this.#opts.onCheckFolder(asked);
    }, 260);
  }

  /**
   * The question this is still waiting on an answer to, if any.
   *
   * A question is sent once and then waited on forever. Nothing here ever asks twice, so a reply
   * that never arrives leaves the line under the box blank for good, and the offer to create a
   * folder that is not there never appears. That is not hypothetical: the answer travels on the
   * socket, and a socket that drops takes every question in flight with it.
   */
  #awaitingFolderState: string | null = null;

  /**
   * The connection came back. Ask again about anything nobody answered.
   *
   * A degraded state that never retries is permanent, which is the whole of this. The folder
   * listing recovers on its own because typing asks again, and the state line does not, because
   * the box has not changed: it is still showing the path whose answer went missing.
   */
  /**
   * What the line under the path box knows, for when it is blank and should not be.
   *
   * It is drawn from three things that have to agree, and when they do not the line simply says
   * nothing, which is indistinguishable from nothing having been asked. This says which.
   */
  folderStateDebug(): Record<string, unknown> {
    const typed = this.#dirInput?.value.trim() ?? '';
    return {
      typed,
      resolved: typed === '' ? '' : this.#resolved(typed),
      home: this.#state?.home ?? null,
      answer: this.#folderState,
      awaiting: this.#awaitingFolderState,
    };
  }

  connectionReady(): void {
    if (this.#dismissed) return;
    if (this.#awaitingFolderState === null) return;
    this.#askFolderState();
  }

  #renderFolders(): void {
    try {
      this.#drawFolders();
    } catch {
      // A list that could not be drawn is a missing convenience. It must never take out the
      // handler it was called from, which also asks whether the folder exists.
    }
  }

  #drawFolders(): void {
    const input = this.#dirInput;
    if (!input) return;
    this.#completionList?.remove();
    this.#completionList = null;

    const dir = this.#currentDir();
    if (this.#listing?.dir !== dir) return;
    const fragment = this.#currentFragment().toLowerCase();
    const matching = this.#listing.entries.filter((name) =>
      name.toLowerCase().startsWith(fragment),
    );

    const list = document.createElement('div');
    list.className = 'launcher-completions';

    /** What has been typed, up to and including the last slash. Empty when there is none. */
    const typedDir = (): string => {
      const typed = input.value;
      const cut = typed.lastIndexOf('/');
      return cut === -1 ? '' : typed.slice(0, cut + 1);
    };

    const go = (name: string): void => {
      /**
       * Built from what was typed, not from the resolved path.
       *
       * Resolving turns `Documents` into an absolute path, and putting that back in the box
       * replaced what somebody had written with `/Users/them/Documents/`. The box keeps the
       * form they chose; only the questions asked of the daemon are resolved.
       *
       * The trailing slash is the point: it says "and now the next one", and it is what moves
       * the list into the folder just chosen.
       */
      input.value = `${typedDir()}${name}/`;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      this.#folderState = null;
      this.#ensureListing();
      this.#renderFolders();
      this.#renderFolderState();
      this.#askFolderState();
    };

    // Up, when there is anywhere to go. Always first, so it never moves.
    if (dir !== '/' && dir !== '~/') {
      const up = document.createElement('button');
      up.className = 'launcher-completion is-up';
      up.textContent = '..';
      up.addEventListener('click', () => {
        // One segment off what is typed. An empty box means home, which is where `..` from the
        // first level lands anyway.
        const trimmed = typedDir().replace(/\/$/, '');
        input.value = trimmed === '' ? '' : `${trimmed.slice(0, trimmed.lastIndexOf('/') + 1)}`;
        input.focus();
        this.#folderState = null;
        this.#ensureListing();
        this.#renderFolders();
        this.#renderFolderState();
        this.#askFolderState();
      });
      list.append(up);
    }

    for (const name of matching.slice(0, Launcher.#MAX_FOLDERS)) {
      const item = document.createElement('button');
      item.className = 'launcher-completion';
      item.textContent = name;
      item.addEventListener('click', () => go(name));
      list.append(item);
    }

    if (matching.length > Launcher.#MAX_FOLDERS) {
      const more = document.createElement('div');
      more.className = 'launcher-completion-more';
      more.textContent = `and ${String(matching.length - Launcher.#MAX_FOLDERS)} more, keep typing`;
      list.append(more);
    }
    if (matching.length === 0) {
      const none = document.createElement('div');
      none.className = 'launcher-completion-more';
      none.textContent = fragment === '' ? 'no folders in here' : 'nothing matching';
      list.append(none);
    }

    /**
     * Directly under the box, not at the end of the form.
     *
     * Appending to the form put it after the layout chips and the hint, where it drew over
     * them and over the terminal below. The list belongs to the box, so it goes immediately
     * after the row holding it.
     */
    input.parentElement?.insertAdjacentElement('afterend', list);
    this.#completionList = list;
    this.#trimFolderRows(list);
  }

  /**
   * Three rows of folders, then a `...`.
   *
   * The list used to be a fixed 132px box with a scrollbar: a home directory with six folders
   * left a band of empty space between it and the buttons, and one with sixty hid the rest
   * behind a scrollbar nobody goes looking for. Three rows is enough to recognise where you
   * are, and past that typing is faster than hunting anyway.
   *
   * Measured rather than counted, because how many chips fit on a row depends on how long the
   * folder names are. Done after the list is in the document, which is the only time offsets
   * mean anything.
   */
  #trimFolderRows(list: HTMLElement): void {
    const children = [...list.children] as HTMLElement[];
    if (children.length === 0) return;
    const rows: number[] = [];
    for (const child of children) {
      if (!rows.includes(child.offsetTop)) rows.push(child.offsetTop);
    }
    if (rows.length <= 3) return;

    const cutoff = rows[3] as number;
    let hidden = 0;
    for (const child of children) {
      if (child.offsetTop < cutoff) continue;
      child.remove();
      hidden++;
    }
    const more = document.createElement('span');
    more.className = 'launcher-completion is-more';
    more.textContent = '...';
    more.title = `${String(hidden)} more. Type to narrow the list.`;
    list.append(more);
    // Adding it can itself push a chip onto a fourth row, so one more is taken off if so.
    if (more.offsetTop >= cutoff) {
      const last = list.children[list.children.length - 2];
      last?.remove();
    }
  }

  /**
   * Saving a template: a shape, a command per session, and a name.
   *
   * A dialog, not the strip of boxes this used to be. The old form asked for a name and one
   * command per pane of a shape chosen elsewhere, which meant the only layouts a template could
   * describe were the five on the buttons, and nothing showed what it would build.
   *
   * The shape is written down instead, `(1+2)/3` and the like, drawn as it is typed. The numbers
   * are session names rather than counts, so using one twice puts the same session in two places
   * and gives it one command box rather than two to keep in step.
   */
  /**
   * What a template chip does beyond running: show what it is, and move.
   *
   * The chip used to carry only a name and a delete cross, so the description somebody had
   * written was never visible anywhere and the only thing you could do to a saved template was
   * destroy it.
   */
  #wireTemplateChip(chip: HTMLElement, template: LayoutTemplate, input: HTMLInputElement): void {
    /**
     * An `i` on the right, because a card that only appears on hover is a card nobody finds.
     *
     * Hovering anywhere on the chip shows the same thing. The dot exists so there is something
     * to look at that says the card is there at all.
     */
    const info = document.createElement('span');
    info.className = 'launcher-template-info';
    info.textContent = 'i';
    info.title = 'What this template does';
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      /**
       * Clicking again does not redraw it.
       *
       * The card was rebuilt on every click, so pressing the dot twice made it disappear and
       * animate back in, which reads as a glitch rather than as nothing happening. Already
       * showing this template, pinned, is a no-op.
       */
      if (this.#templateCard?.dataset['template'] === template.id && this.#cardPinned) return;
      this.#showTemplateCard(chip, template, input, true);
    });
    chip.append(info);

    /**
     * A right click anywhere on the chip does what the dot does.
     *
     * Asked for directly: "i wanna make it so you can right click the templates. it should be
     * the same as the (i) button on each". The dot is four pixels wide at the end of a chip, and
     * the whole chip is the thing somebody is pointing at.
     *
     * `preventDefault` rather than only `stopPropagation`, because the page's own right-click
     * menu is on `document` and declines only what has already been answered. Stopping the event
     * from bubbling would leave Chrome's menu to open instead, which is the thing that menu
     * exists to replace.
     */
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.#templateCard?.dataset['template'] === template.id && this.#cardPinned) return;
      this.#showTemplateCard(chip, template, input, true);
    });

    let hoverTimer = 0;
    chip.addEventListener('mouseenter', () => {
      // A short delay, so moving the pointer across the row does not flash a card per chip.
      hoverTimer = window.setTimeout(() => this.#showTemplateCard(chip, template, input), 320);
    });
    chip.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      this.#hideTemplateCard();
    });

    /**
     * Dragged to reorder, which is also what renumbers the shortcut.
     *
     * The number on a chip is its position, so moving it moves the shortcut with it and there
     * is nothing to keep in step.
     */
    chip.draggable = true;
    chip.dataset['templateId'] = template.id;
    chip.addEventListener('dragstart', (e) => {
      chip.classList.add('is-dragging');
      e.dataTransfer?.setData('text/plain', template.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragend', () => chip.classList.remove('is-dragging'));
    chip.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/plain')) return;
      e.preventDefault();
      chip.classList.add('is-drop-target');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('is-drop-target'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      chip.classList.remove('is-drop-target');
      const moved = e.dataTransfer?.getData('text/plain');
      if (!moved || moved === template.id) return;
      const order = this.#templates.map((t) => t.id).filter((id) => id !== moved);
      const at = order.indexOf(template.id);
      order.splice(at < 0 ? order.length : at, 0, moved);
      this.#opts.onReorderTemplates(order);
    });
  }

  /** The card itself, drawn one at a time, so there is never more than one on screen. */
  #showTemplateCard(
    chip: HTMLElement,
    template: LayoutTemplate,
    input: HTMLInputElement,
    pinned = false,
  ): void {
    // A pinned card stays until it is dismissed: hovering another chip does not replace it.
    if (this.#cardPinned && !pinned) return;
    this.#templateCard?.remove();
    clearTimeout(this.#cardHideTimer);
    const card = document.createElement('div');
    card.className = pinned ? 'template-card is-pinned' : 'template-card';
    card.dataset['template'] = template.id;
    this.#cardPinned = pinned;

    const title = document.createElement('div');
    title.className = 'template-card-name';
    title.textContent = template.name;

    const description = document.createElement('div');
    description.className = 'template-card-desc';
    description.textContent =
      template.description ?? 'No description. Edit this template to add one.';

    // The shape drawn as boxes, which is the one thing a name cannot tell you.
    const preview = document.createElement('div');
    preview.className = 'template-card-preview';
    const parsed = checkShape(template.layout ?? '1');
    if (!('error' in parsed)) {
      for (const pane of previewPanes(parsed.shape.shape)) {
        const box = document.createElement('div');
        box.className = 'template-card-pane';
        box.style.left = `${String(pane.x * 100)}%`;
        box.style.top = `${String(pane.y * 100)}%`;
        box.style.width = `${String(pane.width * 100)}%`;
        box.style.height = `${String(pane.height * 100)}%`;
        box.textContent = template.sessionCommands?.[String(pane.id)] ?? '';
        preview.append(box);
      }
    }

    const shape = document.createElement('div');
    shape.className = 'template-card-shape';
    shape.textContent = `Shape ${template.layout ?? '1'}`;

    const actions = document.createElement('div');
    actions.className = 'template-card-actions';
    const edit = document.createElement('button');
    edit.className = 'launcher-chip';
    edit.textContent = 'Edit';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#templateCard?.remove();
      this.#templateCard = null;
      this.#showTemplateForm(this.#resolved(input.value), template.shape, template);
    });
    const remove = document.createElement('button');
    remove.className = 'launcher-chip';
    remove.textContent = 'Delete';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#templateCard?.remove();
      this.#templateCard = null;
      this.#opts.onDeleteTemplate(template.id);
    });
    actions.append(edit, remove);

    card.append(title, description, preview, shape, actions);
    /**
     * On the page rather than inside the row, positioned against the chip.
     *
     * The row is rebuilt whenever the start screen redraws, which it does every time the daemon
     * reports what is running, so a card living inside it lasted until the next update and no
     * longer. It is also a horizontally scrolling box, which clips anything hanging out of it.
     */
    const at = chip.getBoundingClientRect();
    card.style.left = `${String(Math.max(8, Math.min(at.left, window.innerWidth - 276)))}px`;
    card.style.top = `${String(at.bottom + 6)}px`;
    document.body.append(card);
    this.#templateCard = card;
    // The pointer can travel from the chip onto the card without it going.
    card.addEventListener('mouseenter', () => clearTimeout(this.#cardHideTimer));
    card.addEventListener('mouseleave', () => {
      // A pinned card is not dismissed by the pointer leaving. That is the whole difference
      // between pressing the dot and hovering: one is a question, the other is a decision.
      if (!this.#cardPinned) this.#hideTemplateCard();
    });

    if (pinned) {
      /**
       * Dismissed by clicking anywhere else, which is what a pinned thing means.
       *
       * Registered on the next turn so the click that opened it does not immediately close it.
       */
      const away = (e: MouseEvent): void => {
        if (card.contains(e.target as Node)) return;
        document.removeEventListener('mousedown', away, true);
        this.#cardPinned = false;
        this.#templateCard?.remove();
        this.#templateCard = null;
      };
      setTimeout(() => document.addEventListener('mousedown', away, true), 0);
      this.#teardown.push(() => document.removeEventListener('mousedown', away, true));
    }
  }

  #templateCard: HTMLElement | null = null;
  /** A card opened by the dot stays until something else is clicked; a hovered one does not. */
  #cardPinned = false;
  #cardHideTimer = 0;

  /** Also on dismiss, so a card never outlives the start screen it belongs to. */
  #hideTemplateCard(): void {
    if (this.#cardPinned) return;
    clearTimeout(this.#cardHideTimer);
    this.#cardHideTimer = window.setTimeout(() => {
      this.#templateCard?.remove();
      this.#templateCard = null;
    }, 140);
  }

  /**
   * The form, for a new template or for one being edited.
   *
   * The same form both ways, because "what a template is" is one idea and having two dialogs
   * that drift apart is how a field ends up editable in one and not the other.
   */
  #showTemplateForm(path: string, shape: LayoutShape = 'single', existing?: LayoutTemplate): void {
    this.#templateFormEl?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'template-backdrop';
    const form = document.createElement('div');
    form.className = 'template-dialog';
    backdrop.append(form);

    const title = document.createElement('div');
    title.className = 'template-title';
    title.textContent = 'New layout template';
    const where = document.createElement('div');
    where.className = 'template-where';
    where.textContent = path;
    form.append(title, where);

    const name = document.createElement('input');
    name.className = 'launcher-input';
    name.placeholder = 'Name, such as "review" or "server and logs"';
    name.spellcheck = false;

    const description = document.createElement('input');
    description.className = 'launcher-input';
    description.placeholder = 'What it is for (optional)';
    description.spellcheck = false;

    const layout = document.createElement('input');
    layout.className = 'launcher-input template-layout';
    layout.placeholder = '1+2';
    layout.value = existing?.layout ?? SHAPE_AS_TEXT[shape] ?? '1';
    layout.spellcheck = false;

    if (existing) {
      name.value = existing.name;
      description.value = existing.description ?? '';
    }

    const help = document.createElement('div');
    help.className = 'template-help';
    help.textContent =
      '+ side by side, / stacked, ( ) to group. (1+2)/3 is two above one. ' +
      'The numbers name the sessions, so 1+1 is one session in both halves.';

    const preview = document.createElement('div');
    preview.className = 'template-preview';
    const problem = document.createElement('div');
    problem.className = 'template-problem';
    const commands = document.createElement('div');
    commands.className = 'template-commands';

    form.append(name, description, layout, help, preview, problem, commands);

    /** Kept across redraws, so editing the shape does not throw away what has been typed. */
    const typed = new Map<number, string>();
    // Prefilled when editing, so the commands somebody wrote are there to change rather than
    // to type again from a blank form.
    for (const [id, command] of Object.entries(existing?.sessionCommands ?? {})) {
      typed.set(Number(id), command);
    }
    let sessions: number[] = [];

    const redraw = (): void => {
      const result = checkShape(layout.value);
      preview.replaceChildren();
      commands.replaceChildren();

      if ('error' in result) {
        problem.textContent = result.error;
        preview.classList.add('is-bad');
        sessions = [];
        return;
      }
      problem.textContent = '';
      preview.classList.remove('is-bad');
      sessions = result.shape.sessions;

      // Drawn from the same fractions the layout will be built from, so what is shown is what
      // will happen rather than an artist's impression of it.
      for (const pane of previewPanes(result.shape.shape)) {
        const box = document.createElement('div');
        box.className = 'template-pane';
        box.style.left = `${String(pane.x * 100)}%`;
        box.style.top = `${String(pane.y * 100)}%`;
        box.style.width = `${String(pane.width * 100)}%`;
        box.style.height = `${String(pane.height * 100)}%`;
        box.textContent = String(pane.id);
        preview.append(box);
      }

      // One box per session, not per pane: the same number twice is one session.
      for (const id of sessions) {
        const line = document.createElement('label');
        line.className = 'template-command';
        const tag = document.createElement('span');
        tag.className = 'template-command-tag';
        tag.textContent = String(id);
        const input = document.createElement('input');
        input.className = 'launcher-input';
        input.placeholder = `Command for session ${String(id)}, staged not run`;
        input.spellcheck = false;
        input.value = typed.get(id) ?? '';
        input.addEventListener('input', () => typed.set(id, input.value));
        input.addEventListener('keydown', (e) => e.stopPropagation());
        line.append(tag, input);
        commands.append(line);
      }
    };

    layout.addEventListener('input', redraw);
    for (const box of [name, description, layout]) {
      box.addEventListener('keydown', (e) => e.stopPropagation());
    }
    redraw();

    const row = document.createElement('div');
    row.className = 'launcher-buttons';

    const close = (): void => {
      backdrop.remove();
      this.#templateFormEl = null;
    };

    const save = document.createElement('button');
    save.className = 'launcher-chip is-selected';
    save.textContent = existing ? 'Save changes' : 'Save template';
    save.addEventListener('click', () => {
      const label = name.value.trim();
      if (label === '') {
        name.focus();
        return;
      }
      const result = checkShape(layout.value);
      if ('error' in result) {
        layout.focus();
        return;
      }
      const panes = previewPanes(result.shape.shape);
      void this.#opts.onSaveTemplate({
        // The same id when editing, so it keeps its place in the row and its shortcut number.
        id: existing?.id ?? `t-${String(Date.now())}`,
        name: label,
        path,
        shape,
        panes: panes.length,
        // In pane order, which is what opening a template walks. A session used twice
        // contributes its command to both of its panes.
        commands: panes.map((pane) => typed.get(pane.id) ?? ''),
        layout: layout.value.trim(),
        sessionCommands: Object.fromEntries(
          sessions.map((id) => [String(id), typed.get(id) ?? '']),
        ),
        ...(description.value.trim() === '' ? {} : { description: description.value.trim() }),
      });
      close();
    });

    const cancel = document.createElement('button');
    cancel.className = 'launcher-chip';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);

    row.append(save, cancel);
    form.append(row);

    // Clicking away, or Escape, is "not now", the same as everywhere else in this product.
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      close();
      document.removeEventListener('keydown', onKey, true);
    };
    document.addEventListener('keydown', onKey, true);

    this.#el.append(backdrop);
    this.#templateFormEl = backdrop;
    name.focus();
  }

  #clearCompletion(): void {
    this.#completionList?.remove();
    this.#completionList = null;
  }

  /**
   * Draw the shape of the screen before the daemon has said anything.
   *
   * A new tab spent about a third of a second on an empty page and then everything appeared at
   * once, which reads as a stall and then a jolt. The headings and the boxes are the same every
   * time, so they can be there immediately and fill in.
   *
   * **Only for a tab that has no session.** A tab reattaching to work must never show a flash of
   * this, so the caller passes that judgement in rather than this guessing: the URL says whether
   * there is a workspace, and that is known before anything is asked of anybody.
   */
  renderPlaceholder(): void {
    if (this.#dismissed || this.#state) return;

    const skeleton = (heading: string, rows: number): HTMLElement => {
      const section = document.createElement('div');
      section.className = 'launcher-section is-placeholder';
      const title = document.createElement('p');
      title.className = 'launcher-heading';
      title.textContent = heading;
      section.append(title);
      for (let i = 0; i < rows; i++) {
        const row = document.createElement('div');
        row.className = 'launcher-skeleton-row';
        section.append(row);
      }
      return section;
    };

    const body = document.createElement('div');
    body.className = 'launcher-body';
    body.append(skeleton('Open a folder', 2), skeleton('Resume an agent session', 2));

    const hint = document.createElement('div');
    hint.className = 'launcher-hint';
    hint.textContent = 'Start typing to use the shell. Command+K for history and saved commands.';

    this.#el.replaceChildren(body, hint);
    /**
     * Drawn, not shown. Whether it is on screen is `show`'s business and nobody else's.
     *
     * Unhiding here meant that merely being handed data put the start screen up, and the daemon
     * hands a tab its launcher state as soon as it connects. So a tab reopened on a session it
     * already had flashed the start screen for the fraction of a second before its own screen
     * arrived, and then swapped. Held back for a reattaching tab in one place and given away in
     * another, which is why the guard that existed did not work.
     */
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
    /**
     * And what was selected in it, which is part of what somebody is in the middle of.
     *
     * The value and the focus were carried across a redraw and the selection was not, so a
     * selection made in the path box disappeared the next time this screen redrew for any
     * reason: a session starting somewhere, a folder being recorded. Selecting the whole path
     * and typing over it is the ordinary way to replace it, and it stopped working at random.
     */
    const selection =
      hadFocus && this.#dirInput
        ? { start: this.#dirInput.selectionStart, end: this.#dirInput.selectionEnd }
        : null;
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
    /**
     * Where the list was scrolled to, kept across the redraw.
     *
     * Every render replaces this element, so the scroll position went back to the top: opening a
     * conversation halfway down the list threw the list back to the beginning, which is the one
     * thing that must not happen when the point is to look at the row you clicked.
     */
    const wasScrolled = this.#el.querySelector('.launcher-body')?.scrollTop ?? 0;

    const body = document.createElement('div');
    body.className = 'launcher-body';
    body.replaceChildren(...sections);

    this.#el.replaceChildren(body, hint);
    /**
     * Put back **after** the element is in the document, and not before.
     *
     * Setting it on the element while it was still detached read like the careful thing to do
     * and did nothing at all: an element outside the document has no scrollable box, so the
     * assignment is dropped without complaint. The list still went back to the top, which is
     * what was reported, and the code that was supposed to prevent it looked correct.
     *
     * Nothing is seen at the top first. This runs in the same task as the replacement, and the
     * browser paints at the end of the task, so the only frame ever drawn is the right one.
     */
    if (wasScrolled > 0) body.scrollTop = wasScrolled;
    /**
     * Drawn, not shown. Whether it is on screen is `show`'s business and nobody else's.
     *
     * Unhiding here meant that merely being handed data put the start screen up, and the daemon
     * hands a tab its launcher state as soon as it connects. A tab reopened on a session it
     * already had drew the start screen about a sixth of a second in and swapped to the terminal
     * when the snapshot arrived. The guard that was supposed to hold it back was in the page,
     * which never got the chance: this element had already shown itself.
     */
    /**
     * And the row that was just opened is brought fully into view, if it is not already.
     *
     * Only when something has just been expanded, and only far enough: `nearest` scrolls by the
     * least it can, so a row already on screen does not move at all.
     */
    if (this.#expandedResume && this.#justExpanded) {
      this.#justExpanded = false;
      const opened = body.querySelector('.launcher-row-holder');
      opened?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    /**
     * The text, and then the keyboard, and the keyboard whether or not there was any text.
     *
     * These were one condition: put the typed path back **and** put the cursor back, only when
     * something had been typed. An empty box that had the keyboard therefore lost it on every
     * redraw, and the start screen redraws whenever anything happens anywhere in TabTerm.
     *
     * What made that expensive rather than merely untidy is what happens next. A page with the
     * keyboard nowhere gives it to the terminal, by design, so the characters typed after a
     * redraw went to a shell instead of into the box: not lost, run.
     */
    if (typed && this.#dirInput) this.#dirInput.value = typed;
    if (hadFocus && this.#dirInput) {
      this.#dirInput.focus();
      // Put back after the focus, because focusing a box moves the caret to the end of it.
      if (selection && selection.start !== null && selection.end !== null) {
        this.#dirInput.setSelectionRange(selection.start, selection.end);
      }
    }

    /**
     * And what was known about the folder in the box, which a redraw rebuilt empty.
     *
     * The answer is kept in `#folderState` and drawn into a slot in place, so a full redraw made
     * the slot again and left it blank: the line saying a folder does not exist, and the offer to
     * create it, disappeared. That only mattered when something else caused a redraw, and until
     * the start screen followed what other tabs were doing, almost nothing did.
     *
     * **After the box has its text back**, which is the whole of the second half of this. It ran
     * before, when the input in the document was the new empty one, and this compares the answer
     * to what is typed: an empty box matches no answer, so it drew nothing and left the line
     * blank for good. Correct code in the wrong order, and it read fine both times.
     */
    this.#renderFolderState();
  }

  #layoutSection(state: LauncherState): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'launcher-section';
    wrap.append(heading('Open a folder'));

    const form = document.createElement('div');
    form.className = 'launcher-form';

    /**
     * There is no Browse button.
     *
     * The folders are simply shown, under the box, for wherever the box points. A button that
     * opens a list is a step between wanting a folder and seeing one, and this list is useful
     * often enough that it should not have to be asked for.
     *
     * Not a native dialog either: a Chrome extension cannot learn an absolute path from one,
     * since `webkitdirectory` reports paths relative to whatever was chosen and the File System
     * Access API returns an opaque handle. The daemon reads the filesystem instead, through the
     * same `complete-path` the box uses for Tab.
     */
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
    input.addEventListener('input', () => {
      /**
       * Typing filters the list, and moving into another folder fetches it.
       *
       * Both on every keystroke, because the filtering is local and the fetch only happens when
       * the directory part has actually changed. Typing and clicking and Tab are the same
       * feature from here on: they all end as a value in this box with a list under it.
       */
      /**
       * The question first, the drawing second.
       *
       * Both used to be in this handler with the drawing first, and anything that threw while
       * rendering the folder list took the rest of the handler with it: the check was never
       * scheduled, the daemon was never asked, and the validity line stayed blank as though
       * the feature had been removed. What the page asks for must not depend on what it manages
       * to draw.
       */
      this.#folderState = null;
      this.#renderFolderState();
      this.#askFolderState();

      this.#ensureListing();
      this.#renderFolders();
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
     * One entry that is not a template, then every template.
     *
     * `Open` stays a built-in: it is the plainest possible thing this screen does, it is what
     * Return in the path box means, and there is nothing about it to edit. Everything else that
     * used to sit beside it, the three arrangements and the two agents, is now an ordinary
     * template that ships as a default. They can be renamed, edited, reordered and deleted, and
     * put back from settings if they are.
     */
    const actions: {
      label: string;
      run: (path: string) => void;
      title: string;
      shape?: LayoutShape;
      /** Present when this entry is a saved template rather than the built-in Open. */
      template?: LayoutTemplate;
    }[] = [
      {
        label: 'Open',
        title: 'One terminal in this folder. Return, from the box above',
        shape: 'single',
        run: (path) => this.#opts.onChooseDir(path),
      },
    ];

    for (const template of this.#templates) {
      actions.push({
        label: template.name,
        title: template.description ?? `${String(template.panes)} panes`,
        template,
        run: (path) => this.#opts.onRunTemplate(template, path),
      });
    }

    /**
     * No selection, and no outline that moves.
     *
     * These used to be cycled with Tab and run with Return, so one of them was always outlined
     * as "the one Return will take". Nothing cycles them now: they are clicked, or reached by
     * Control and a number, and Return in the box means `Open`. An outline that follows a
     * selection nobody can move is an outline that says something untrue.
     */
    const chips: HTMLButtonElement[] = [];

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
      chip.className = action.template ? 'launcher-chip launcher-template' : 'launcher-chip';
      chip.textContent = action.label;

      /**
       * `Open` has no number; the templates are numbered from one.
       *
       * Return in the path box is what opens a folder, so a shortcut for it would be a second
       * way to do the thing the box already does. Control and a number then belongs entirely to
       * the templates, and Control 1 is the first of them rather than the second entry in a row.
       */
      if (action.template) {
        const key = document.createElement('kbd');
        // The modifier as well as the number: a bare `1` reads as a label or a count.
        key.textContent = `\u2303${String(index)}`;
        chip.append(key);
        chip.title = `${action.title}  (Control ${String(index)})`;
        this.#wireTemplateChip(chip, action.template, input);
      } else {
        chip.classList.add('is-open-action');
        chip.title = action.title;
      }

      chip.addEventListener('click', () => action.run(this.#resolved(input.value)));
      chips.push(chip);
      buttons.append(chip);
    }

    const addTemplate = document.createElement('button');
    addTemplate.className = 'launcher-chip launcher-add-template';
    addTemplate.textContent = '+';
    addTemplate.title = 'Save this layout as a template that runs a command in each pane';
    addTemplate.addEventListener('click', () => {
      this.#showTemplateForm(this.#resolved(input.value));
    });
    buttons.append(addTemplate);

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
      // Control and a number runs a template. One is the first template, which is the entry
      // after `Open`, because `Open` is what Return already does.
      if (e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const index = Number(e.key);
        if (index < actions.length) {
          e.preventDefault();
          actions[index]?.run(input.value.trim() || state.home);
        }
        return;
      }
      /**
       * Return opens the folder, and only that.
       *
       * It used to run whichever chip was outlined, which meant Return did different things
       * depending on a selection you could move with Tab and could not see if you had scrolled.
       * Opening a folder is what somebody typing a path into a path box means.
       */
      if (e.key === 'Enter') {
        e.preventDefault();
        actions[0]?.run(input.value.trim() || state.home);
      }
    });

    // Between the box and the buttons: it is about what was typed, and it must not move the
    // buttons around as it appears and goes.
    const folderState = document.createElement('div');
    folderState.className = 'launcher-folder-state';
    // The row holds only the box now. The folder list is inserted after it, and there is no
    // Browse button: see the comment on the picker itself for why both went.
    const pathRow = document.createElement('div');
    pathRow.className = 'launcher-path-row';
    pathRow.append(input);
    form.append(pathRow, folderState, buttons);
    // Drawn straight away, so the folders are there before anything is typed.
    this.#ensureListing();
    setTimeout(() => this.#renderFolders(), 0);
    /**
     * No note under the buttons.
     *
     * It said the folder would be created if it did not exist, which stopped being the whole
     * truth once the validity line under the box started saying so itself, with a button to do
     * it. Two answers to the same question, one of them a sentence that is always there whether
     * it applies or not.
     */
    wrap.append(form);
    return wrap;
  }

  /** Workspaces that could be brought back after a restart. */
  setRestorable(workspaces: readonly RestorableSummary[]): void {
    this.#restorable = workspaces;
    this.#answered('restorable');
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
    this.#answered('servers');
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
    this.#answered('resumable');
  }

  /** Conversations dismissed from this list, which stay dismissed. */
  #hiddenResumes = new Set<string>();

  setHiddenResumes(ids: readonly string[]): void {
    this.#hiddenResumes = new Set(ids);
    // Named, so it joins the batch it arrives with: which resume rows were dismissed, read from extension storage.
    this.#answered('hidden-resumes');
  }

  #resumeSection(home: string): HTMLElement | null {
    const offered = this.#resumable.filter((r) => !this.#hiddenResumes.has(r.sessionId));
    if (offered.length === 0) return null;

    const rows = offered.slice(0, MAX_RESUME).map((session) => {
      /**
       * Which agent, when, what was said, and where. In that order.
       *
       * The agent comes first because it decides everything else about the row: what resuming
       * it will do, and which of two conversations about the same folder this is. The time is
       * next because a list of conversations is read as a history. The text is what identifies
       * it to a person, and the folder is the detail you check last.
       */
      const wrap = document.createElement('div');
      wrap.className = 'launcher-row-wrap';

      const row = document.createElement('button');
      row.className = 'launcher-row is-resume';
      const when = new Date(session.modifiedAt);
      row.append(
        badge(session.agent),
        dim(
          `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        ),
        strong(session.summary ?? `Session ${session.sessionId.slice(0, 8)}`),
        dim(shorten(session.cwd, home)),
      );
      row.title = session.sessionId;
      row.addEventListener('click', () => this.#opts.onResumeAgent(session));

      /**
       * A way to read the conversation before deciding to resume it.
       *
       * One line of the first prompt does not tell three sessions apart when all three begin
       * "help me with". The alternative that suggests itself, starting the agent to look, is not
       * one: it changes the thing being inspected.
       *
       * Expanding rather than opening something. What is below is pushed down, which is what a
       * list does when one of its rows has more to say, and nothing is covered up.
       */
      /**
       * Said in words rather than drawn as a chevron.
       *
       * A chevron at the end of a row is a thing people find by accident. This is the control
       * that makes the list usable when three conversations start the same way, so it says what
       * it does.
       */
      const expand = document.createElement('button');
      expand.className = 'launcher-row-action is-expand';
      const open = this.#expandedResume === session.sessionId;
      expand.title = open ? 'Hide the conversation' : 'Read the conversation';
      expand.textContent = open ? 'Collapse' : 'Expand';
      expand.setAttribute('aria-expanded', open ? 'true' : 'false');
      expand.addEventListener('click', (e) => {
        e.stopPropagation();
        // A second click on the open one closes it: one open at a time, so the list stays a list.
        this.#expandedResume = open ? null : session.sessionId;
        this.#justExpanded = !open;
        if (!open) this.#opts.onReadAgentSession?.(session.sessionId);
        this.render();
      });

      // A cross, not a star: a conversation is either worth offering back or it is not, and
      // there is nothing to keep.
      const hide = document.createElement('button');
      hide.className = 'launcher-row-action';
      hide.title = 'Leave this conversation out of the list';
      hide.textContent = '\u00d7';
      hide.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#hiddenResumes.add(session.sessionId);
        this.#opts.onHideResume(session.sessionId);
        this.render();
      });

      wrap.append(row, expand, hide);
      if (!open) return wrap;

      const holder = document.createElement('div');
      holder.className = 'launcher-row-holder';
      holder.append(wrap, this.#transcriptPanel(session.sessionId));
      return holder;
    });
    return section('Resume an agent session', rows);
  }

  /**
   * The conversation under an expanded row.
   *
   * Scrolled to the bottom, because the end of a conversation is what says what it was about by
   * the time it stopped. Bounded in height so that expanding one pushes the rest down by a
   * predictable amount rather than by however long somebody's last message was.
   */
  #transcriptPanel(sessionId: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'launcher-transcript';

    const turns = this.#transcripts.get(sessionId);
    if (!turns) {
      box.textContent = 'Reading...';
      box.classList.add('is-waiting');
      return box;
    }
    if (turns.length === 0) {
      box.textContent = 'Nothing readable in this one.';
      box.classList.add('is-waiting');
      return box;
    }

    for (const turn of turns) {
      const line = document.createElement('div');
      line.className = `launcher-turn is-${turn.role}`;
      const who = document.createElement('span');
      who.className = 'launcher-turn-who';
      who.textContent = turn.role === 'you' ? 'you' : 'agent';
      const text = document.createElement('span');
      text.className = 'launcher-turn-text';
      text.textContent = turn.text;
      line.append(who, text);
      box.append(line);
    }
    // Drawn already scrolled to the end, which is where the useful part is.
    queueMicrotask(() => {
      box.scrollTop = box.scrollHeight;
    });
    return box;
  }

  /** A conversation that was asked for has arrived. */
  setTranscript(
    sessionId: string,
    turns: readonly { role: 'you' | 'agent'; text: string }[],
  ): void {
    this.#transcripts.set(sessionId, turns);
    if (!this.#dismissed && this.#expandedResume === sessionId) this.render();
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
    // Named, so it joins the batch it arrives with: a project file the daemon was asked to read for a folder in the list.
    this.#answered('project');
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

/** Which agent a conversation belongs to, said first because it decides what resuming does. */
function badge(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'launcher-agent';
  el.textContent = text;
  return el;
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
