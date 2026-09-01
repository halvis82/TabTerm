import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { ILinkProvider } from '@xterm/xterm';
import { classifyKey, xtermShouldHandle } from './keymap.js';
import { placeMenu } from './menu-position.js';
import { MarkerRail } from './markers.js';

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
}

export interface PaneMenuAction {
  label: string;
  run: () => void;
  /** Shown greyed rather than hidden, so the menu keeps a stable shape. */
  enabled?: boolean;
  /** Draws a rule above this entry, to separate destructive actions from ordinary ones. */
  separated?: boolean;
  danger?: boolean;
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

  #undoText = '';
  /** Landmarks in the scrollback, and the rail beside the scrollbar that finds them. */
  #markers: MarkerRail | null = null;
  #markerTimer = 0;
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

    this.#fit = new FitAddon();
    this.term.loadAddon(this.#fit);

    this.term.open(opts.container);
    this.#tryWebgl();

    this.term.onData(opts.onData);
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
        case 'search':
          // Chrome's own find cannot see a WebGL-rendered buffer, so claiming the key without
          // offering a replacement would be worse than leaving it alone.
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
      e.preventDefault();
      this.#showMenu(e.clientX, e.clientY);
    });
  }

  /** What was selected when the right-click arrived, which is what the menu acts on. */
  #selectionAtRightClick = '';

  #showMenu(x: number, y: number): void {
    document.querySelector('.term-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'term-menu';

    const item = (label: string, enabled: boolean, run: () => void) => {
      const b = document.createElement('button');
      b.className = 'term-menu-item';
      b.textContent = label;
      b.disabled = !enabled;
      b.addEventListener('click', () => {
        menu.remove();
        run();
      });
      menu.append(b);
    };

    const selected = this.term.getSelection() || this.#selectionAtRightClick;
    item('Copy', selected.length > 0, () => void this.copySelection(selected));
    item('Paste', true, () => void this.pasteFromClipboard());
    item('Select all', true, () => {
      // Focus first. A selection made while the textarea does not have focus is held by xterm
      // but never painted, which looked exactly like the entry doing nothing.
      this.term.focus();
      this.term.selectAll();
    });
    // The real clear, not `term.clear()`. Wiping this buffer alone left the output in the daemon
    // and on disk, so it came back on the next reload. See docs/07-terminal-fidelity.md.
    item('Clear', true, () => this.clear());

    for (const action of this.#opts.menuActions?.() ?? []) {
      if (action.separated === true) {
        const rule = document.createElement('div');
        rule.className = 'term-menu-rule';
        menu.append(rule);
      }
      const before = menu.lastElementChild;
      item(action.label, action.enabled !== false, action.run);
      if (action.danger === true) {
        (before?.nextElementSibling ?? menu.lastElementChild)?.classList.add('is-danger');
      }
    }

    // Measured, then placed. The size depends on the entries, which depend on the pane, so
    // there is no useful constant to place it by.
    menu.style.visibility = 'hidden';
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    const at = placeMenu({
      x,
      y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    menu.style.left = `${String(at.left)}px`;
    menu.style.top = `${String(at.top)}px`;
    menu.style.visibility = 'visible';
    // Dismiss on the next interaction anywhere, including a second right-click.
    const close = () => {
      menu.remove();
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('contextmenu', close, true);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', close, true);
      document.addEventListener('contextmenu', close, true);
    }, 0);
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
    this.term.onRender(() => {
      clearTimeout(this.#markerTimer);
      this.#markerTimer = window.setTimeout(() => rail.sync(this.term), 220);
    });
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

  fit(): { cols: number; rows: number } {
    try {
      this.#fit.fit();
    } catch {
      /* container not laid out yet */
    }
    return { cols: this.term.cols, rows: this.term.rows };
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
  }

  /** Reattach the renderer when the pane is looked at again. */
  restoreRenderer(): void {
    if (this.#webgl) return;
    this.#tryWebgl();
    this.term.refresh(0, this.term.rows - 1);
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

  #allText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    // Trailing blank lines are noise when this is written back.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\r\n');
  }

  setScrollback(lines: number): void {
    this.term.options.scrollback = Math.max(0, Math.floor(lines));
  }

  dispose(): void {
    clearTimeout(this.#markerTimer);
    this.#markers?.dispose();
    this.#webgl?.dispose();
    this.term.dispose();
  }

  #tryWebgl(): void {
    try {
      const addon = new WebglAddon();
      // Losing a context degrades to canvas. It never breaks the pane.
      addon.onContextLoss(() => {
        addon.dispose();
        this.#webgl = null;
      });
      this.term.loadAddon(addon);
      this.#webgl = addon;
    } catch {
      /* No WebGL. xterm falls back on its own. */
    }
  }
}
