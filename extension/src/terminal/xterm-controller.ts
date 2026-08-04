import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { ILinkProvider } from '@xterm/xterm';

export interface ControllerOptions {
  container: HTMLElement;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onLinkClick: (url: string) => void;
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

    // Scheme allowlist happens in the handler. Never javascript:, data:, or file:.
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        opts.onLinkClick(uri);
      }),
    );

    this.term.open(opts.container);
    this.#tryWebgl();

    this.term.onData(opts.onData);
    this.term.onResize(({ cols, rows }) => opts.onResize(cols, rows));
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
