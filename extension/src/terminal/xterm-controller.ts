import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { installCurrentWidths } from '@tabterm/shared';
import type { ILinkProvider, IMarker } from '@xterm/xterm';
import { classifyKey, xtermShouldHandle } from './keymap.js';
import { placeAndArm } from './menu-shell.js';

/** Where this browser records that it has given a pane a WebGL context. See `rendererWorksHere`. */
const WEBGL_WORKS_KEY = 'tabterm.webgl-works';
import { MarkerRail } from './markers.js';
import { HighlightLayer } from './highlights.js';
import { closeColorPicker, openColorPicker } from './color-picker.js';
import { dragIsTakenByProgram, MOUSE_HINT } from './mouse-hint.js';
import { keysForClick } from './click-to-move.js';
import { WheelRows } from './wheel-rows.js';
import { encodeModifiedKey, modifyOtherKeysLevel } from './modified-keys.js';
import type { Highlight } from './highlight-anchor.js';
import { measurementIsTrustworthy } from './measured-size.js';
import { rowOfTyped, TypedLine } from './input-anchor.js';

export interface ControllerOptions {
  container: HTMLElement;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /**
   * Clearing, which is more than wiping this buffer.
   *
   * The page holds one of three copies of a session's output. Clearing only this one is what
   * the product used to do, and it made clear a lie: reloading the tab brought everything back
   * from the daemon. See docs/07-terminal-fidelity.md.
   */
  onClear?: () => void;
  /**
   * Extra menu entries, supplied by whoever owns the pane.
   *
   * The controller knows about one terminal and deliberately nothing else: it has no idea what
   * a workspace is, whether this pane has siblings, or what closing one would mean. Asking for
   * the entries at the moment of the right-click also means they reflect the pane as it is now,
   * rather than as it was when the pane was created.
   */
  menuActions?: () => readonly PaneMenuAction[];
  /**
   * The highlights somebody drew, whenever they change.
   *
   * The controller draws them and knows nothing about where they are kept. Which session they
   * belong to is the page's business, since a pane can be given a different session.
   */
  onHighlightsChanged?: (highlights: readonly Highlight[]) => void;
  /**
   * The browser took the accelerated renderer away.
   *
   * Worth recording rather than absorbing: it is the difference between a pane that scrolls
   * smoothly and one that does not, it happens for reasons outside this product, and until it
   * was written down it was invisible to everyone including the person feeling it.
   */
  onRendererLost?: () => void;
  /** The renderer that decides the cell has arrived, so this pane can be measured properly. */
  onRendererReady?: () => void;
  /** Somebody asked to find something here. The selection travels, so a word can be looked up. */
  onFind?: (selected: string) => void;
  /** Something worth saying to the person, briefly. Not an error and never a dialog. */
  onNotice?: (text: string) => void;
  /** How many matches were found, once the emulator has counted them. */
  onFindResults?: (results: { resultIndex: number; resultCount: number } | undefined) => void;
  /**
   * Whether this pane should answer a right click at all.
   *
   * It declines while the start screen is up. The terminal is still there, three rows tall under
   * the panel, and its menu offered to split it, name it, mark a place in it and kill it. None of
   * those mean anything in a tab where nothing has happened yet, and splitting rearranged the
   * layout under a start screen that is not laid out for two panes, which is what "split right
   * and split down work from the homescreen and they make the view all messed up" was.
   *
   * Declining rather than showing a shorter menu, so the gesture travels on and the page answers
   * it with the start screen's own menu. See `pageMenuItems`.
   */
  shouldOpenMenu?: () => boolean;
  /** The color a highlight gets when the entry is clicked rather than the swatch. */
  highlightColor?: () => string;
  /** The last few highlight colors, for the row of swatches under the map. */
  highlightRecents?: () => readonly string[];
  /** A color that was actually used, so it can be remembered for next time. */
  onColorUsed?: (color: string) => void;
}

export interface PaneMenuAction {
  label: string;
  run: () => void;
  /** Drawn with a tick when on, so the entry shows its state rather than only changing it. */
  checked?: boolean;
  /** Shown greyed rather than hidden, so the menu keeps a stable shape. */
  enabled?: boolean;
  /** Draws a rule above this entry, to separate destructive actions from ordinary ones. */
  separated?: boolean;
  danger?: boolean;
  /**
   * The keys that do the same thing, as a keyboard shows them.
   *
   * The same field `ShellItem` carries, because this menu and the one the rest of the product
   * draws are the same menu to the person using them, and an entry that shows its shortcut in
   * one place and not the other is worse than neither.
   */
  keys?: string;
}

/**
 * One xterm.js instance for one pane.
 *
 * Renderer choice: WebGL where available. Measured on Chrome 150, the cap is 16 contexts per
 * page and the 17th evicts the oldest, but the cap is per page rather than global: 20 separate
 * tabs each holding a context showed zero loss. Since a terminal tab holds one context, this
 * only matters for a workspace with 17 or more simultaneously rendering panes.
 * See docs/06-chrome-integration.md §8.
 */
export class XtermController {
  readonly term: Terminal;
  readonly #fit: FitAddon;
  #webgl: WebglAddon | null = null;
  /** Said once per pane. A program that keeps the mouse would otherwise say it on every click. */
  #saidMouseHint = false;

  /** The part of a row left over from the last scroll. See `wheel-rows.ts`. */
  readonly #wheel = new WheelRows();

  /**
   * Whether a program has asked to be told which modifier was held, and how much.
   *
   * Zero until one asks. `CSI > 4 ; 2 m` is the request and the bare form turns it off again, so
   * this follows the program rather than being a setting: a shell wants none of it and the prompt
   * that replaces the shell for a while wants all of it.
   */
  #modifyOtherKeys = 0;

  /**
   * How long a pane will wait for the renderer that decides its cell before trusting what it has.
   *
   * A grid is the room a pane has divided by the renderer's cell, and the two renderers disagree:
   * 7.83 against 7.5, which is 187 columns against 195 for the same 1468 pixels. Attaching is when
   * the WebGL one is most likely to be missing, because every tab re-attaches at once and they
   * contend for a capped number of GPU contexts.
   *
   * Waiting rather than refusing, because a pane that never gets a context must still be able to
   * follow the window. Generous, because while it waits the daemon's size rules and that is the
   * right answer: a session that already has a size does not need this pane's opinion, and by the
   * time the context arrives the two usually agree, so nothing is resized at all.
   */
  static readonly RENDERER_GRACE_MS = 10_000;
  /**
   * When this pane started waiting for a renderer, which is not the same as when it was built.
   *
   * It was `Date.now()` at construction and never moved again, so the grace covered starting up
   * and nothing else. A pane that gives its context back when its tab is hidden starts waiting
   * all over again, and that is exactly when it is measuring with a cell it is about to replace.
   */
  #waitingForRendererSince: number | null = Date.now();

  /** How many times this pane has handed its renderer back. See `releaseRenderer`. */
  rendererReleases = 0;

  #undoText = '';
  readonly #serializer = new SerializeAddon();
  /**
   * Finding text in this terminal, which the browser cannot do for us.
   *
   * Chrome's find reads the page, and this terminal is a canvas, so there is nothing there for it
   * to read. Even drawn as elements it would only ever see the rows in view: xterm renders the
   * viewport, and the scrollback is the part worth searching. So the search belongs to the
   * emulator, which is the only thing that has all of it.
   */
  readonly #search = new SearchAddon();
  /** Landmarks in the scrollback, and the rail beside the scrollbar that finds them. */
  #markers: MarkerRail | null = null;
  /** Lines somebody pressed Return on. See `markInputHere`. */
  readonly #inputMarks: IMarker[] = [];
  /** The line being typed, so a mark can be moved to wherever the program drew it. */
  readonly #typedLine = new TypedLine();
  /** The line just submitted, set only while the chunk that submitted it is being handled. */
  #submittedNow: string | null = null;
  /** Timers waiting for a program to redraw, so they can be dropped when the pane is. */
  readonly #anchorTimers = new Set<number>();
  #markerTimer = 0;
  #highlights: HighlightLayer | null = null;
  readonly #opts: ControllerOptions;

  constructor(opts: ControllerOptions) {
    this.#opts = opts;
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        'SF Mono, Menlo, Monaco, "Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      // Option sends Meta, which terminal users expect. The cost is losing accented character
      // entry via Option+letter. See docs/06-chrome-integration.md §6.
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      /*
       * Right-click must never change what is selected.
       *
       * xterm's default on macOS replaces the selection with the word under the pointer. Over
       * blank space that word is empty, so right-clicking anywhere to the right of a line
       * silently destroyed the selection and greyed out Copy in the menu that the same click
       * had just opened. Selecting a line worked; selecting text and right-clicking past the
       * end of it did not, which is exactly as arbitrary as it sounds from the outside.
       */
      rightClickSelectsWord: false,
      theme: {
        background: '#12131a',
        foreground: '#d5d8e2',
        cursor: '#8ab4f8',
        selectionBackground: '#31405e',
      },
    });
    // The same table the daemon uses, installed before a byte is written. An agent pads its box
    // drawing against a current width table, so a terminal on xterm's built-in Unicode 6 one draws
    // every row holding a check mark a column short. See docs/07-terminal-fidelity.md.
    installCurrentWidths(this.term, new Unicode11Addon());

    this.#fit = new FitAddon();
    this.term.loadAddon(this.#fit);
    // Only ever read, and only when a clear is undone. It holds no state of its own.
    this.term.loadAddon(this.#serializer);
    this.term.loadAddon(this.#search);
    // Counting is asynchronous, so the bar is told rather than asking.
    this.#search.onDidChangeResults((r) => this.#opts.onFindResults?.(r));

    /*
     * Say why the mouse stopped selecting, once, at the moment somebody tries.
     *
     * While a program holds the mouse a drag goes to it rather than selecting, which is what every
     * terminal does and what nobody is born knowing. Reported as text that could not be selected in
     * one tab while typing worked and Command+A worked, and it was an agent that had turned mouse
     * reporting on and left it on.
     *
     * On the way down and not preventing anything: the drag still belongs to the program. This only
     * answers the question it raises.
     */
    /*
     * Scrolling moves the content by the pixels the pointer moved, and nothing else.
     *
     * The emulator converts a pixel delta to rows and then damps anything under fifty pixels to
     * thirty percent of itself. A wheel mouse never notices, because one notch is more than that.
     * A trackpad is nothing but small deltas, so a slow drag barely moved and a flick moved
     * properly, which is what "scrolling is still really weird" was made of.
     *
     * Taken here, in the capture phase, and kept from the emulator entirely when it is taken. The
     * cases it is **not** taken in are the cases where a scroll is not a scroll:
     *
     * - a program that asked for the mouse is told about the wheel instead, and that is its business
     * - the alternate screen, where the emulator turns a wheel into arrow keys for a pager
     * - a wheel mouse reporting in lines or pages, where a notch is a notch and the emulator is right
     *
     * See `wheel-rows.ts` for the arithmetic, which is where the remainder is carried.
     */
    opts.container.addEventListener(
      'wheel',
      (e) => {
        if (e.deltaMode !== 0 || e.shiftKey || e.ctrlKey || e.altKey) return;
        if (this.term.modes.mouseTrackingMode !== 'none') return;
        if (this.term.buffer.active.type === 'alternate') return;

        const cell = this.cellSize();
        if (cell === null) return;

        /*
         * At the end of the scrollback, the scroll is let go rather than swallowed.
         *
         * A session that has printed less than a screenful has nothing above it, and a trackpad
         * keeps sending events for a second after the fingers leave. Consuming those silently is
         * what "scrolling in a session that hasn't had a lot printed is awkward" is: the gesture
         * goes nowhere and nothing says so. Released, the browser gives it the usual end-of-scroll
         * feel, and the remainder of a row is dropped so it cannot jump later.
         */
        const buffer = this.term.buffer.active;
        const lowest = Math.max(0, buffer.length - this.term.rows);
        const canGo = e.deltaY < 0 ? buffer.viewportY > 0 : buffer.viewportY < lowest;
        if (!canGo) {
          this.#wheel.reset();
          return;
        }

        const rows = this.#wheel.take(e.deltaY, cell.height);
        e.preventDefault();
        e.stopPropagation();
        if (rows !== 0) this.term.scrollLines(rows);
      },
      { capture: true, passive: false },
    );

    /*
     * A click puts the cursor where it was clicked, in a program that never asked for the mouse.
     *
     * On the way up, so a drag that selected something is already visible and is left alone, and
     * only when every one of the conditions in `click-to-move.ts` holds. What is sent is arrow
     * keys, which is what a person would press to get there.
     */
    opts.container.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      const keys = this.#keysForClickAt(e);
      if (keys !== '') opts.onData(keys);
    });

    opts.container.addEventListener(
      'mousedown',
      (e) => {
        if (this.#saidMouseHint) return;
        const mode = this.term.modes.mouseTrackingMode;
        if (!dragIsTakenByProgram(mode, { alt: e.altKey, shift: e.shiftKey })) return;
        this.#saidMouseHint = true;
        this.#opts.onNotice?.(MOUSE_HINT);
      },
      true,
    );

    /*
     * Listen for a program asking to be told about modifiers.
     *
     * xterm.js parses this and does nothing with it, which is why an agent's Shift and Return
     * arrived as a plain carriage return and was read as "send this". Returning false leaves the
     * sequence to xterm's own handling as well, so nothing is taken away by watching it.
     */
    this.term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
      const level = modifyOtherKeysLevel(params.map((p) => (Array.isArray(p) ? (p[0] ?? 0) : p)));
      if (level !== null) this.#modifyOtherKeys = level;
      return false;
    });

    this.term.open(opts.container);
    this.#tryWebgl();

    /*
     * What is typed passes through here on its way to the program, so this is where the line
     * being typed is kept. `#submittedNow` is set only for the chunk that submitted it, and
     * `markInputHere` runs inside that same chunk, so a mark can be moved to the line it is for
     * without any chance of picking up the line before it. See `input-anchor.ts`.
     */
    this.term.onData((data) => {
      this.#submittedNow = this.#typedLine.consume(data);
      try {
        opts.onData(data);
      } finally {
        this.#submittedNow = null;
      }
    });
    /**
     * The other half of what the terminal has to say back.
     *
     * xterm answers some queries through `onBinary` rather than `onData`: a reply that must go
     * as raw bytes rather than as text. Only `onData` was wired, so those answers were dropped,
     * and a program that asks the terminal something and waits for the answer waits forever.
     * From the outside that is a shell that has stopped responding for no visible reason.
     *
     * The bytes are already one per character here, which is what `binary` means in this one
     * direction: xterm has produced a string whose code units are the bytes it wants sent.
     */
    this.term.onBinary((data) => {
      let out = '';
      for (let i = 0; i < data.length; i++) out += String.fromCharCode(data.charCodeAt(i) & 0xff);
      opts.onData(out);
    });
    this.term.onResize(({ cols, rows }) => opts.onResize(cols, rows));
    this.#installKeyboard();
    this.#installContextMenu();
  }

  /**
   * Route keystrokes.
   *
   * xterm's handler runs before its own key processing and uses the convention that `false`
   * means "already dealt with". Everything not deliberately claimed returns true and reaches
   * the shell, because swallowing a key is worse than passing one through.
   */
  #installKeyboard(): void {
    this.term.attachCustomKeyEventHandler((e) => {
      const action = classifyKey({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        type: e.type,
        hasSelection: this.term.hasSelection(),
      });

      /*
       * A program that asked to be told about modifiers is told, before anything else decides.
       *
       * This is what makes Shift and Return mean a new line rather than "send this". The
       * terminal cannot say it in its own alphabet, so a program asks for `modifyOtherKeys`
       * and is then sent `CSI 27 ; modifier ; key ~`. Ahead of the table below because that
       * table answers for Command, and a program that asked wants Command too.
       */
      const reported = encodeModifiedKey(
        e.key,
        { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey },
        this.#modifyOtherKeys,
      );
      if (reported !== null) {
        e.preventDefault();
        this.#opts.onData(reported);
        return false;
      }
      switch (action.kind) {
        case 'copy':
          e.preventDefault();
          void this.copySelection();
          return false;
        case 'paste':
          e.preventDefault();
          void this.pasteFromClipboard();
          return false;
        case 'select-all':
          e.preventDefault();
          this.term.selectAll();
          return false;
        case 'clear':
          e.preventDefault();
          this.clear();
          return false;
        case 'newline':
          /*
           * `ESC CR`, written straight to the program.
           *
           * Not handed to xterm, because xterm sends a bare `CR` for Return whatever modifier is
           * held, and a bare `CR` is the thing being avoided: to a program taking more than one
           * line it means the input has finished.
           */
          e.preventDefault();
          this.#opts.onData('\u001b\r');
          return false;
        case 'search':
          /*
           * Chrome's own find cannot see a WebGL-rendered buffer, and would only ever see the
           * rows in view even if it could. So the key is claimed and answered here instead. The
           * page owns the bar, because one per pane would be four of them.
           */
          e.preventDefault();
          this.#opts.onFind?.(this.term.getSelection());
          return false;
        case 'browser':
          return false;
        case 'to-pty':
          return xtermShouldHandle(action);
      }
    });
  }

  /**
   * Right-click menu.
   *
   * Rendered in the page rather than left to Chrome's, because Chrome's menu has no idea a
   * canvas contains selected text and would offer nothing useful.
   */
  #installContextMenu(): void {
    // Recorded in the capture phase, before anything else can act on the click. Belt and
    // braces alongside `rightClickSelectsWord: false`: the menu then reports on the selection
    // the user actually had, whatever happens to the terminal's own state afterwards.
    this.term.element?.addEventListener(
      'mousedown',
      (e: MouseEvent) => {
        if (e.button === 2) this.#selectionAtRightClick = this.term.getSelection();
      },
      true,
    );

    this.term.element?.addEventListener('contextmenu', (e: MouseEvent) => {
      // Declined without `preventDefault`, so the page's own handler answers instead. See
      // `shouldOpenMenu`.
      if (this.#opts.shouldOpenMenu?.() === false) return;
      e.preventDefault();
      this.#showMenu(e.clientX, e.clientY);
    });
  }

  /**
   * Where a click landed, in cells, and what that means for the cursor.
   *
   * The geometry is read from the screen element rather than from xterm, which does not expose
   * where a pixel lands. Rounded down, so a click anywhere in a cell means that cell.
   */
  #keysForClickAt(e: MouseEvent): string {
    const screen = this.term.element?.querySelector('.xterm-screen');
    if (!screen) return '';
    const box = screen.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return '';

    const cellWidth = box.width / this.term.cols;
    const cellHeight = box.height / this.term.rows;
    if (cellWidth < 1 || cellHeight < 1) return '';

    const column = Math.floor((e.clientX - box.left) / cellWidth);
    const row = Math.floor((e.clientY - box.top) / cellHeight);
    if (column < 0 || row < 0 || column >= this.term.cols || row >= this.term.rows) return '';

    const buffer = this.term.buffer.active;
    return keysForClick({
      column,
      row,
      cursorColumn: buffer.cursorX,
      cursorRow: buffer.cursorY,
      mouseIsTaken: this.term.modes.mouseTrackingMode !== 'none',
      onAlternateScreen: buffer.type === 'alternate',
      selected: this.term.hasSelection(),
      applicationCursorKeys: this.term.modes.applicationCursorKeysMode,
    });
  }

  /** What was selected when the right-click arrived, which is what the menu acts on. */
  #selectionAtRightClick = '';

  /**
   * The same menu, for anything drawn on top of this pane.
   *
   * A pane that has just been split is covered by the chooser offering to put something in it,
   * and that overlay swallowed the right-click: the pane was plainly visible and had no menu at
   * all, which read as the menu working once and then never again. Anything covering a pane can
   * hand the gesture back rather than each overlay growing a menu of its own.
   */
  openMenuAt(x: number, y: number): void {
    if (this.#opts.shouldOpenMenu?.() === false) return;
    this.#showMenu(x, y);
  }

  #showMenu(x: number, y: number): void {
    document.querySelector('.term-menu')?.remove();

    /**
     * How an entry puts the menu away, filled in once the menu has been placed.
     *
     * The entries are built before the menu is on screen and each one closes it before acting, so
     * they close over this rather than over the closer itself. Taking the element away is not
     * enough on its own: the listeners that watch for a press elsewhere, for Escape, and for the
     * page being left have to come off with it.
     *
     * A named placeholder rather than nothing, because the name `close` on its own is `window
     * .close` in a browser. Deleting the local one and leaving the calls behind typechecked
     * perfectly and turned every entry in this menu into "close the tab", which is what the check
     * that caught it saw: a page that answered nothing afterwards because it was gone.
     */
    let dismiss = (): void => menu.remove();

    const menu = document.createElement('div');
    menu.className = 'term-menu';

    const item = (
      label: string,
      enabled: boolean,
      run: () => void,
      checked?: boolean,
      keys?: string,
    ) => {
      const b = document.createElement('button');
      b.className = 'term-menu-item';
      b.textContent = label;
      b.disabled = !enabled;
      /*
       * An attribute drawn by CSS rather than a child element.
       *
       * A child would land inside `textContent`, and the label is what everything matches an
       * entry by, including the checks that drive this menu with a real press. An entry whose
       * name silently became `Split right⇧⌘D` would be unfindable by every one of them, which
       * is a lot of breakage to accept for a visual hint.
       */
      if (keys !== undefined && keys !== '') b.dataset['keys'] = keys;
      if (checked !== undefined) {
        // A tick on the right, so a toggle reads as one rather than as an action that happens
        // to be reversible.
        const tick = document.createElement('span');
        tick.className = 'term-menu-tick';
        tick.textContent = checked ? '\u2713' : '';
        b.append(tick);
        b.classList.add('is-toggle');
      }
      b.addEventListener('click', () => {
        dismiss();
        run();
      });
      menu.append(b);
    };

    /**
     * Grouped by what the entries are for, with a rule between the groups.
     *
     * What is selected, then what to do with the selection, then what to do with the screen,
     * then what to call this terminal. An ungrouped list of nine entries reads as nine
     * unrelated things and every one of them has to be read to find the one you want.
     */
    const rule = () => {
      const line = document.createElement('div');
      line.className = 'term-menu-rule';
      menu.append(line);
    };

    const selected = this.term.getSelection() || this.#selectionAtRightClick;

    // The clipboard, in the order a hand reaches for them.
    item('Copy', selected.length > 0, () => void this.copySelection(selected));
    item('Select all', true, () => {
      // Focus first. A selection made while the textarea does not have focus is held by xterm
      // but never painted, which looked exactly like the entry doing nothing.
      this.term.focus();
      this.term.selectAll();
    });
    item('Paste', true, () => void this.pasteFromClipboard());
    // The real clear, not `term.clear()`. Wiping this buffer alone left the output in the daemon
    // and on disk, so it came back on the next reload. See docs/07-terminal-fidelity.md.
    item('Clear', true, () => this.clear());

    rule();

    /**
     * Highlight, which acts on a click, with the color beside it rather than behind a menu.
     *
     * The entry itself applies the last color used and closes, because that is the common case
     * and it should cost one click. The swatch on its right is the only part that opens
     * anything, and it opens the picker next to itself rather than replacing the menu, so the
     * thing being colored is still on screen while the color is chosen.
     */
    if (this.#highlights) {
      const row = document.createElement('div');
      row.className = 'term-menu-row';

      const label = document.createElement('button');
      label.className = 'term-menu-item';
      label.textContent = 'Highlight';
      label.disabled = selected.length === 0;
      label.addEventListener('click', () => {
        dismiss();
        this.highlightSelection(this.#opts.highlightColor?.() ?? '#ffd54a');
      });

      const swatch = document.createElement('button');
      swatch.className = 'term-menu-swatch';
      swatch.style.background = this.#opts.highlightColor?.() ?? '#ffd54a';
      swatch.title = 'Choose a color';
      swatch.disabled = selected.length === 0;
      swatch.addEventListener('mousedown', (e) => e.stopPropagation());
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        openColorPicker({
          anchor: swatch,
          recents: this.#opts.highlightRecents?.() ?? [],
          current: this.#opts.highlightColor?.() ?? '#ffd54a',
          onPreview: (color) => (swatch.style.background = color),
          onPick: (color) => {
            // The picker is its own element beside the menu, so closing the menu does not
            // take it with it. Both go, because the choice has been made.
            closeColorPicker();
            dismiss();
            this.highlightSelection(color);
          },
        });
      });

      row.append(label, swatch);
      menu.append(row);
    }

    /**
     * Directly under `Highlight`, because it is the same idea undone.
     *
     * Offered only when the click actually landed on one. It used to appear whenever the pane
     * had any highlight at all, so it was there over blank output and did nothing when pressed.
     */
    const under = this.#cellAt(x, y);
    if (under && this.#highlights?.covers(under.row, under.col) === true) {
      item('Remove highlight', true, () => {
        this.#highlights?.removeAt(under.row, under.col);
        this.#markers?.sync(this.term, this.#highlights?.places() ?? [], this.#inputRows());
      });
    }

    for (const action of this.#opts.menuActions?.() ?? []) {
      if (action.separated === true) {
        const rule = document.createElement('div');
        rule.className = 'term-menu-rule';
        menu.append(rule);
      }
      const before = menu.lastElementChild;
      item(action.label, action.enabled !== false, action.run, action.checked, action.keys);
      if (action.danger === true) {
        (before?.nextElementSibling ?? menu.lastElementChild)?.classList.add('is-danger');
      }
    }

    /**
     * Placed and armed by the one piece of code that does it. See `menu-shell.ts`.
     *
     * This was a second copy of that, and the two drifted: Escape closed the page's menus and not
     * this one, so pressing it over a pane put the menu away in some places and sent an interrupt
     * to the program in others. The copy measured, placed and dismissed exactly as the original
     * did, which is why it survived as a copy for so long.
     */
    dismiss = placeAndArm(menu, x, y);
  }

  async copySelection(override?: string): Promise<void> {
    const text = override ?? this.term.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard denied. Nothing useful to do, and failing loudly would be worse. */
    }
  }

  /**
   * Paste through xterm rather than as raw input.
   *
   * `paste()` applies bracketed paste when the application has asked for it, which is what
   * stops a multi-line paste from being run line by line in a shell that supports it.
   */
  async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.term.paste(text);
    } catch {
      /* denied or empty */
    }
  }

  /** Write PTY bytes, and report back only once xterm has actually parsed them. */
  write(data: Uint8Array, onParsed: (bytes: number) => void): void {
    this.term.write(data, () => onParsed(data.byteLength));
  }

  /**
   * Keep the rail of landmarks in step with the buffer.
   *
   * Debounced on render rather than run per frame: output arrives in bursts and the answer only
   * has to be right once the burst settles. A landmark whose lines have fallen off the end of
   * the scrollback stops being found, which is exactly when it stops being reachable.
   */
  installMarkers(container: HTMLElement): void {
    const rail = new MarkerRail(container, (row) => this.term.scrollToLine(row));
    this.#markers = rail;
    this.#highlights = new HighlightLayer(this.term, (h) => this.#opts.onHighlightsChanged?.(h));
    this.term.onRender(() => {
      clearTimeout(this.#markerTimer);
      this.#markerTimer = window.setTimeout(() => {
        // Both on the same tick, and both for the same reason: a decoration is anchored
        // relative to the cursor line, so anything that scrolled has moved it.
        this.#highlights?.draw();
        rail.sync(this.term, this.#highlights?.places() ?? [], this.#inputRows());
      }, 220);
    });
  }

  /**
   * Mark the line somebody pressed Return on, so the rail says where the input is.
   *
   * Asked for as "i want to differentiate in the scrollbar what is output and what is input". The
   * moment Return is pressed is the one point that answers it for both kinds of session: in a
   * shell it is the command, and in a pane running an agent it is the prompt, and neither needs
   * the line to be recognised by how it looks.
   *
   * `registerMarker` rather than a row number, because the buffer moves underneath: a row is only
   * true until the next line scrolls off, and a marker follows its line and reports itself gone
   * when that line falls out of the scrollback, which is exactly when it stops being reachable.
   */
  markInputHere(): void {
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    this.#inputMarks.push(marker);
    /*
     * Bounded, and the oldest goes first.
     *
     * A session running all day is thousands of commands, and a rail with a pip for every one of
     * them is a solid stripe that says nothing. The recent ones are the ones somebody is looking
     * for, which is the same reasoning the scrollback itself is bounded on.
     */
    while (this.#inputMarks.length > XtermController.MAX_INPUT_MARKS) {
      this.#inputMarks.shift()?.dispose();
    }
    this.#markers?.sync(this.term, this.#highlights?.places() ?? [], this.#inputRows());

    /*
     * The cursor is not always where the line ends up.
     *
     * In a shell it is: the command is on the line the cursor is on, and the search below finds
     * it there and changes nothing. In a pane running an agent the cursor is inside an input box
     * at the bottom of the screen, and the prompt is printed further up once the agent redraws.
     * See `input-anchor.ts`.
     */
    const typed = this.#submittedNow;
    if (typed !== null) this.#followTheTypedLine(marker, typed);
  }

  /**
   * How long a program is given to redraw, before and then after the answer starts arriving.
   *
   * Twice rather than once because the two cases have different timing: an agent redraws its box
   * within a frame or two of the submit, while one that was busy may not repaint until it comes
   * back. The second try is skipped once the first has found the line.
   */
  static readonly REDRAW_TRIES = [500, 1600];

  /** How far above the cursor to look. An input box is a few rows tall, not a screenful. */
  static readonly LOOK_BACK = 80;

  #followTheTypedLine(mark: IMarker, typed: string): void {
    let found = false;
    for (const delay of XtermController.REDRAW_TRIES) {
      const timer = window.setTimeout(() => {
        this.#anchorTimers.delete(timer);
        if (!found) found = this.#moveMarkToItsLine(mark, typed);
      }, delay);
      this.#anchorTimers.add(timer);
    }
  }

  /**
   * Put the mark on the line the typed text was drawn on. True once there is nothing left to do.
   *
   * A marker cannot be told to move, so the move is a new marker in the old one's place in the
   * list. The mark is a place in the buffer either way, and which object holds it is nobody's
   * business outside here.
   */
  #moveMarkToItsLine(mark: IMarker, typed: string): boolean {
    if (mark.isDisposed || mark.line < 0) return true;
    const buffer = this.term.buffer.active;
    // The alternate screen is not scrollback. Nothing on it can be scrolled back to, so there is
    // nothing there for a mark to point at.
    if (buffer.type === 'alternate') return true;

    const at = mark.line;
    const from = Math.max(0, at - XtermController.LOOK_BACK);
    const lines: string[] = [];
    for (let row = from; row < buffer.length; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    }

    const row = rowOfTyped({ from, lines }, typed, at);
    if (row === null) return false;
    if (row === at) return true;

    const moved = this.term.registerMarker(row - (buffer.baseY + buffer.cursorY));
    if (!moved) return false;
    const index = this.#inputMarks.indexOf(mark);
    if (index < 0) {
      // The mark has already aged out of the list while the program was redrawing.
      moved.dispose();
      return true;
    }
    this.#inputMarks[index] = moved;
    mark.dispose();
    this.#markers?.sync(this.term, this.#highlights?.places() ?? [], this.#inputRows());
    return true;
  }

  /** How many places the rail will point at before it stops being a rail. */
  static readonly MAX_INPUT_MARKS = 60;

  /** The rail's own colour for a line somebody typed, which is not a landmark and not a highlight. */
  static readonly INPUT_MARK_COLOR = 0x5f7bb0;

  /** Lines somebody typed on, which the rail draws in its own lane. */
  #inputRows(): { row: number; color: number }[] {
    return this.#inputMarks
      .filter((m) => !m.isDisposed && m.line >= 0)
      .map((m) => ({ row: m.line, color: XtermController.INPUT_MARK_COLOR }));
  }

  /** Rebuild the rail now. For measuring what a full-buffer scan costs. */
  syncMarkersForTest(): void {
    this.#markers?.sync(this.term, this.#highlights?.places() ?? [], this.#inputRows());
  }

  /** Highlight what is selected. Returns how many lines it covered, zero when nothing was. */
  highlightSelection(color: string): number {
    const lines = this.#highlights?.add(color) ?? 0;
    if (lines > 0) {
      this.#opts.onColorUsed?.(color);
      this.#markers?.sync(this.term, this.#highlights?.places() ?? [], this.#inputRows());
      // The selection has been acted on, and leaving it drawn over its own highlight hides it.
      this.term.clearSelection();
    }
    return lines;
  }

  /** Restore the highlights this session had, without counting it as a change. */
  restoreHighlights(highlights: readonly Highlight[]): void {
    this.#highlights?.restore(highlights);
    this.#markers?.sync(this.term, this.#highlights?.places() ?? [], this.#inputRows());
  }

  get highlights(): readonly Highlight[] {
    return this.#highlights?.highlights ?? [];
  }

  /**
   * Which cell a point in the page is over.
   *
   * xterm exposes no way to ask this, so it is measured: the screen element's box divided by the
   * grid it is showing. Rounded down, and offset by the scroll position, because a highlight is
   * anchored to a buffer row rather than to a row on screen.
   */
  #cellAt(clientX: number, clientY: number): { row: number; col: number } | null {
    const screen = this.term.element?.querySelector('.xterm-screen');
    if (!(screen instanceof HTMLElement)) return null;
    const box = screen.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const col = Math.floor(((clientX - box.left) / box.width) * this.term.cols);
    const line = Math.floor(((clientY - box.top) / box.height) * this.term.rows);
    if (col < 0 || col >= this.term.cols || line < 0 || line >= this.term.rows) return null;
    return { row: this.term.buffer.active.viewportY + line, col };
  }

  /** The landmarks this pane can see, which is what the markers beside the scrollbar show. */
  get markers(): readonly { row: number; color: number }[] {
    return this.#markers?.markers ?? [];
  }

  registerLinkProvider(provider: ILinkProvider): void {
    this.term.registerLinkProvider(provider);
  }

  /** Force xterm to re-run link providers, after the daemon confirms new paths. */
  refreshLinks(): void {
    this.term.refresh(0, this.term.rows - 1);
  }

  reset(): void {
    this.term.reset();
  }

  /** Put a buffer row at the top of the view, clamped so a row near the start still lands. */
  scrollTo(row: number): void {
    this.term.scrollToLine(Math.max(0, row));
  }

  /**
   * Repaint the terminal itself.
   *
   * The renderer draws onto a canvas, so no stylesheet can reach these colors; they have to be
   * handed to xterm. With WebGL attached the change needs a refresh to appear, since the
   * existing frame was already uploaded.
   */
  applyTheme(theme: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  }): void {
    this.term.options.theme = { ...this.term.options.theme, ...theme };
    this.term.refresh(0, this.term.rows - 1);
  }

  /**
   * The size of one character cell, as this terminal has measured it.
   *
   * Read from the rendered screen rather than from the font settings, because what matters is
   * what the browser actually drew. Used to estimate a size before any pane has been laid out,
   * where the alternative is a number chosen in 1978.
   */
  /**
   * What a size decision was actually made from.
   *
   * `cellSize` divides the screen box by the current grid, so it can only ever agree with itself.
   * The numbers that decide a grid are the room the parent has and the cell the **renderer**
   * believes in, and neither is visible from outside xterm. A size that moves without the window
   * moving cannot be explained without them, so they are read here and reported.
   */
  metrics(): {
    availWidth: number;
    availHeight: number;
    cellWidth: number;
    cellHeight: number;
    webgl: boolean;
  } | null {
    const parent = this.term.element?.parentElement;
    if (!parent) return null;
    const style = window.getComputedStyle(parent);
    const px = (value: string): number => Number.parseFloat(value) || 0;
    let cellWidth = 0;
    let cellHeight = 0;
    try {
      const cell = (
        this.term as unknown as {
          _core?: {
            _renderService?: {
              dimensions?: { css?: { cell?: { width: number; height: number } } };
            };
          };
        }
      )._core?._renderService?.dimensions?.css?.cell;
      cellWidth = cell?.width ?? 0;
      cellHeight = cell?.height ?? 0;
    } catch {
      // Internals moved. The rest of the reading is still worth having.
    }
    return {
      availWidth: Math.round(parent.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
      availHeight: Math.round(parent.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
      cellWidth: Math.round(cellWidth * 1000) / 1000,
      cellHeight: Math.round(cellHeight * 1000) / 1000,
      webgl: this.rendererAttached,
    };
  }

  cellSize(): { width: number; height: number } | null {
    const screen = this.term.element?.querySelector('.xterm-screen');
    if (!screen) return null;
    const box = screen.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return { width: box.width / this.term.cols, height: box.height / this.term.rows };
  }

  /**
   * Measure the pane, or say that it could not be measured.
   *
   * Null rather than a guess. This used to return the terminal's current size whenever the
   * measurement failed, and a terminal that has never been fitted is **80 by 24**, xterm's
   * default. So a pane whose element was not laid out yet reported 80 by 24 as though it had
   * measured it, the daemon believed it, every view was told, and the pane spent the next second
   * flickering between that and its real size. Thousands of size changes, four tabs at once.
   *
   * `proposeDimensions` is the addon's own answer to "can this be measured", and it returns
   * nothing when the element has no box. Asking it is the difference between a measurement and
   * a default that looks like one.
   */
  fit(): { cols: number; rows: number } | null {
    /**
     * A measurement that is not worth believing moves nothing at all. Not even this pane.
     *
     * Stated at the call sites first, one at a time, and it never held: `fit` applies what it
     * measures, applying changes the grid, xterm reports that change, and the page forwards it as
     * an ordinary resize. So a guarded call site still let the guess out under another name. The
     * audit log says it plainly: `attach` at 91 columns, then `terminal-said-so` at 91, for a
     * session running at 101.
     *
     * Here it is one rule in one place. The pane keeps the size the daemon gave it, which is the
     * size the program is actually running at, and asks again the moment its renderer arrives.
     */
    if (!this.sizeIsTrustworthy()) return null;
    if (!this.propose()) return null;
    try {
      this.#fit.fit();
    } catch {
      // Not laid out yet. A size cannot be invented for it.
      return null;
    }
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /**
   * Measure without moving anything.
   *
   * `fit` applies what it measures, and applying is a resize: xterm reports it, the page forwards
   * it, and a program redraws. That is right when the measurement is worth believing and wrong
   * when it is not, and the difference cannot be expressed while measuring and applying are the
   * same call. So this is the half that only reads, and `fit` is that half plus the moving.
   */
  propose(): { cols: number; rows: number } | null {
    try {
      const proposed = this.#fit.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
        return null;
      }
      if (proposed.cols < 2 || proposed.rows < 2) return null;
      return { cols: proposed.cols, rows: proposed.rows };
    } catch {
      return null;
    }
  }

  /**
   * Look for something, and light up every place it appears.
   *
   * `decorations` is what makes a result readable: the match under the cursor is one colour and
   * the others another, so the answer to "how many of these are there" is the screen rather than a
   * count nobody can place. The colours are the theme's own selection and highlight, so a match
   * looks like something selected rather than like an error.
   */
  find(term: string, opts: { back?: boolean; caseSensitive?: boolean } = {}): boolean {
    if (term === '') {
      this.#search.clearDecorations();
      return false;
    }
    const options = {
      caseSensitive: opts.caseSensitive === true,
      decorations: {
        matchBackground: '#3a4a6b',
        matchBorder: '#5f7bb0',
        matchOverviewRuler: '#5f7bb0',
        activeMatchBackground: '#7a6a2f',
        activeMatchBorder: '#c2a94a',
        activeMatchColorOverviewRuler: '#c2a94a',
      },
    };
    return opts.back === true
      ? this.#search.findPrevious(term, options)
      : this.#search.findNext(term, options);
  }

  /** Put the terminal back the way it looked before anybody searched it. */
  clearFind(): void {
    this.#search.clearDecorations();
    this.term.clearSelection();
  }

  /** How many matches there are and which one is current, when the addon has counted them. */
  onFindResults(
    fn: (results: { resultIndex: number; resultCount: number } | undefined) => void,
  ): void {
    this.#search.onDidChangeResults(fn);
  }

  focus(): void {
    this.term.focus();
  }

  blur(): void {
    this.term.blur();
  }

  /**
   * Release the WebGL context while nobody is looking at the pane.
   *
   * The buffer is untouched, so reattaching redraws from state that never went anywhere. This
   * matters because contexts are capped per page and are the expensive part of a terminal that
   * is only sitting there. See docs/11-performance.md.
   */
  releaseRenderer(): void {
    if (!this.#webgl) return;
    this.#webgl.dispose();
    this.#webgl = null;
    /*
     * Counted, because a check cannot ask this by sampling.
     *
     * Whether a pane has a renderer right now is a state, and this is an event: a tab can hand a
     * context back and be given another one between two polls, so a check looking at the state
     * reports that nothing happened. Counting is the difference between asking "did this happen"
     * and "is this happening at the exact moment I looked".
     */
    this.rendererReleases += 1;
    // Waiting again, and measuring with a cell that is about to be replaced. See
    // `measurementIsTrustworthy`.
    this.#waitingForRendererSince = Date.now();
  }

  /** Reattach the renderer when the pane is looked at again. */
  restoreRenderer(): void {
    if (this.#webgl) return;
    this.#tryWebgl();
    this.term.refresh(0, this.term.rows - 1);
  }

  /**
   * Whether a size measured now is worth moving a terminal for.
   *
   * False while the cell still comes from a renderer this pane is about to replace. Nothing is
   * broken while this is false: the pane draws, and the daemon's size is the one that counts.
   */
  sizeIsTrustworthy(): boolean {
    return measurementIsTrustworthy({
      rendererAttached: this.rendererAttached,
      waitingSince: this.#waitingForRendererSince,
      graceMs: XtermController.RENDERER_GRACE_MS,
      now: Date.now(),
      rendererExpected: XtermController.rendererWorksHere,
    });
  }

  /**
   * Whether a WebGL renderer has ever attached in this browser.
   *
   * Remembered across reloads, because the moment it matters most is the first measurement after
   * one: every tab reattaches at once, they contend for a capped number of contexts, and a page
   * that has just started has no evidence of its own yet. A browser that produced one yesterday
   * will produce one in a moment, and a measurement taken before it arrives is four percent out.
   */
  static rendererWorksHere = ((): boolean => {
    try {
      return localStorage.getItem(WEBGL_WORKS_KEY) === '1';
    } catch {
      return false;
    }
  })();

  static rememberRendererWorks(): void {
    if (XtermController.rendererWorksHere) return;
    XtermController.rendererWorksHere = true;
    try {
      localStorage.setItem(WEBGL_WORKS_KEY, '1');
    } catch {
      /* storage can be refused, and this page still knows for itself */
    }
  }

  get rendererAttached(): boolean {
    return this.#webgl !== null;
  }

  /** Change how much scrollback the renderer keeps, without disturbing what is on screen. */
  /**
   * Clear, keeping this tab's own copy briefly so it can be undone.
   *
   * The durable copies are dropped immediately by the daemon, so an undo restores only what was
   * already in this browser process. That way the undo cannot resurrect something the user
   * cleared in order to get rid of it.
   */
  clear(): void {
    this.#undoText = this.#allText();
    this.term.clear();
    this.#opts.onClear?.();
  }

  /** What was on screen before the last clear, or empty once the window has passed. */
  takeUndo(): string {
    const text = this.#undoText;
    this.#undoText = '';
    return text;
  }

  forgetUndo(): void {
    this.#undoText = '';
  }

  /**
   * The screen as escape sequences, colors and all.
   *
   * This was `translateToString`, which is the text and nothing else, so undoing a clear brought
   * back an hour of build output in a uniform gray: every error that had been red, every path
   * that had been blue, flattened. The point of undoing is to get back what was there.
   *
   * The same addon the daemon uses to hand its VT state to a restarting process, which is the
   * same problem stated differently: turn a buffer back into the stream that would produce it.
   */
  #allText(): string {
    const serialized = this.#serializer.serialize();
    /**
     * Trailing blank lines are noise when this is written back.
     *
     * They are also not always blank: a line that was cleared still carries the attributes it
     * was cleared with, so the serializer emits escape sequences for lines that show nothing.
     * A line counts as empty when it has no visible characters, whatever it is wearing.
     */
    const lines = serialized.split('\r\n');
    const blank = (line: string): boolean =>
      // eslint-disable-next-line no-control-regex
      line.replace(/\u001b\[[0-9;:]*[a-zA-Z]/g, '').trim() === '';
    while (lines.length > 0 && blank(lines[lines.length - 1] ?? '')) lines.pop();
    return lines.join('\r\n');
  }

  setScrollback(lines: number): void {
    this.term.options.scrollback = Math.max(0, Math.floor(lines));
  }

  dispose(): void {
    clearTimeout(this.#markerTimer);
    clearTimeout(this.#retryTimer);
    for (const timer of this.#anchorTimers) clearTimeout(timer);
    this.#anchorTimers.clear();
    this.#markers?.dispose();
    this.#webgl?.dispose();
    this.term.dispose();
  }

  #retryTimer: number | undefined;

  /**
   * Get the accelerated renderer back after the browser takes it away.
   *
   * A browser keeps a limited number of WebGL contexts and drops the oldest when something else
   * wants one, which for this product means a person with a dozen terminal tabs open. Losing it
   * used to be permanent for the life of the page: the pane fell back to drawing with DOM nodes
   * and stayed there, which is fine for a shell showing a prompt and slow for a tab holding
   * thousands of lines of an agent's output. That is one tab feeling worse than the next for no
   * reason anybody could see.
   *
   * Retried with a widening gap, a few times, and only while the tab is being looked at: a
   * hidden tab does not need a context and asking for one takes it from a tab that does.
   */
  #scheduleRendererRetry(attempt: number): void {
    if (attempt > 4) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = window.setTimeout(
      () => {
        if (this.#webgl) return;
        if (document.visibilityState !== 'visible') return; // the wake path will ask instead
        this.#tryWebgl(attempt + 1);
        if (!this.#webgl) this.#scheduleRendererRetry(attempt + 1);
      },
      Math.min(8000, 500 * 2 ** attempt),
    );
  }

  /**
   * A browser that will not give this pane a context, on purpose.
   *
   * Contexts are capped per page and the cap is real: every tab re-attaching at once is exactly
   * when one is refused, which is the moment the sizing rules were written for. A check cannot
   * make a browser run out of them, so it says so instead. Off unless a check turns it on.
   */
  static blockRenderer = false;

  #tryWebgl(attempt = 0): void {
    if (XtermController.blockRenderer) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        this.#webgl = null;
        // Taken away rather than given back, and the same thing is true either way: this pane is
        // measuring with a cell it is about to replace.
        this.#waitingForRendererSince = Date.now();
        this.#opts.onRendererLost?.();
        this.#scheduleRendererRetry(0);
      });
      this.term.loadAddon(addon);
      this.#webgl = addon;
      // The cell is now the one this pane will keep, so a size measured from here is worth having.
      this.#waitingForRendererSince = null;
      // And this browser has proved it gives out contexts, which is what tells the next page that
      // a missing renderer means "not yet" rather than "never". See `rendererWorksHere`.
      XtermController.rememberRendererWorks();
      this.#opts.onRendererReady?.();
    } catch {
      // No WebGL to be had right now. xterm draws without it, and this asks again shortly.
      this.#scheduleRendererRetry(attempt);
    }
  }
}
