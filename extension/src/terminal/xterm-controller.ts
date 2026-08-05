import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { ILinkProvider } from '@xterm/xterm';
import { classifyKey, xtermShouldHandle } from './keymap.js';

export interface ControllerOptions {
  container: HTMLElement;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
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

  constructor(opts: ControllerOptions) {
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
          this.term.clear();
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
    this.term.element?.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.#showMenu(e.clientX, e.clientY);
    });
  }

  #showMenu(x: number, y: number): void {
    document.querySelector('.term-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'term-menu';
    menu.style.left = `${String(x)}px`;
    menu.style.top = `${String(y)}px`;

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

    const selected = this.term.hasSelection();
    item('Copy', selected, () => void this.copySelection());
    item('Paste', true, () => void this.pasteFromClipboard());
    item('Select all', true, () => this.term.selectAll());
    item('Clear', true, () => this.term.clear());

    document.body.append(menu);
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

  async copySelection(): Promise<void> {
    const text = this.term.getSelection();
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
  setScrollback(lines: number): void {
    this.term.options.scrollback = Math.max(0, Math.floor(lines));
  }

  dispose(): void {
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
