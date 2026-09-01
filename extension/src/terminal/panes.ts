import type { ResolvedPath } from '@tabterm/shared';
import { XtermController, type PaneMenuAction } from './xterm-controller.js';
import { createPathLinkProvider, findCandidates } from './path-links.js';

/**
 * One terminal per pane.
 *
 * Panes come and go as a workspace is split and closed, so this owns the lifecycle: create a
 * renderer on demand, dispose it when its pane disappears, and never leave an orphan behind.
 */
export interface PaneHostOptions {
  onData: (paneId: string, data: string) => void;
  onResize: (paneId: string, cols: number, rows: number) => void;
  /** Clearing reaches the daemon, because the page holds only one copy of the output. */
  onClear?: (paneId: string) => void;
  resolvePaths: (paneId: string, candidates: string[]) => void;
  lookupPath: (candidate: string) => ResolvedPath | undefined;
  openPath: (paneId: string, resolved: ResolvedPath, event: MouseEvent) => void;
  openUrl: (url: string) => void;
  modifierHeld: () => boolean;
  /** Pane-level entries for the right-click menu, asked for at the moment of the click. */
  menuActions?: (paneId: string) => readonly PaneMenuAction[];
}

interface Pane {
  paneId: string;
  sessionId: string;
  streamId: number;
  element: HTMLElement;
  controller: XtermController;
}

export class PaneHost {
  readonly #opts: PaneHostOptions;
  readonly #panes = new Map<string, Pane>();
  readonly #byStream = new Map<number, string>();

  constructor(opts: PaneHostOptions) {
    this.#opts = opts;
  }

  get(paneId: string): Pane | undefined {
    return this.#panes.get(paneId);
  }

  paneForStream(streamId: number): Pane | undefined {
    const paneId = this.#byStream.get(streamId);
    return paneId ? this.#panes.get(paneId) : undefined;
  }

  get all(): Pane[] {
    return [...this.#panes.values()];
  }

  /** Element for a pane, created on first request and reused thereafter. */
  element(paneId: string, sessionId: string): HTMLElement {
    const existing = this.#panes.get(paneId);
    if (existing) return existing.element;

    const element = document.createElement('div');
    element.className = 'pane-terminal';

    const controller = new XtermController({
      container: element,
      onData: (data) => this.#opts.onData(paneId, data),
      onResize: (cols, rows) => this.#opts.onResize(paneId, cols, rows),
      onClear: () => this.#opts.onClear?.(paneId),
      menuActions: () => this.#opts.menuActions?.(paneId) ?? [],
    });

    /**
     * Ask about the paths on screen as they are printed, rather than when one is hovered.
     *
     * xterm caches what a link provider answered for a line and only asks again when the
     * pointer moves to a different line. The first hover therefore arrived before the daemon
     * had confirmed anything, was told there were no links, and that answer stuck: the path
     * stayed inert until the pointer left the line and came back. Resolving as output arrives
     * means the answer is already there by the time anybody hovers.
     *
     * Debounced and limited to the rows actually on screen, so a noisy build does not turn into
     * a request per line.
     */
    let scanTimer = 0;
    const scanVisible = (): void => {
      const buffer = controller.term.buffer.active;
      const first = buffer.viewportY;
      const last = Math.min(buffer.length, first + controller.term.rows);
      const found = new Set<string>();
      for (let y = first; y < last; y++) {
        const text = buffer.getLine(y)?.translateToString(true) ?? '';
        if (text === '') continue;
        for (const candidate of findCandidates(text)) found.add(candidate.text);
      }
      const unknown = [...found].filter((c) => this.#opts.lookupPath(c) === undefined);
      if (unknown.length > 0) this.#opts.resolvePaths(paneId, unknown);
    };
    controller.term.onRender(() => {
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scanVisible, 180);
    });

    controller.installMarkers(element);

    controller.registerLinkProvider(
      createPathLinkProvider(controller.term, {
        resolve: (candidates) => this.#opts.resolvePaths(paneId, candidates),
        lookup: this.#opts.lookupPath,
        activate: (resolved, event) => this.#opts.openPath(paneId, resolved, event),
        openUrl: this.#opts.openUrl,
        modifierHeld: this.#opts.modifierHeld,
      }),
    );

    this.#panes.set(paneId, { paneId, sessionId, streamId: 0, element, controller });
    return element;
  }

  bindStream(paneId: string, sessionId: string, streamId: number): void {
    const pane = this.#panes.get(paneId);
    if (!pane) return;
    this.#byStream.delete(pane.streamId);
    pane.streamId = streamId;
    pane.sessionId = sessionId;
    this.#byStream.set(streamId, paneId);
  }

  write(streamId: number, data: Uint8Array, ack: (bytes: number) => void): void {
    this.paneForStream(streamId)?.controller.write(data, ack);
  }

  /** Replace a pane's contents with a snapshot from the daemon. */
  restore(paneId: string, screen: string): void {
    const pane = this.#panes.get(paneId);
    if (!pane) return;
    pane.controller.reset();
    pane.controller.write(new TextEncoder().encode(screen), () => {
      /* a snapshot is not acked: it never came off the credit window */
    });
  }

  fit(paneId: string): { cols: number; rows: number } | null {
    return this.#panes.get(paneId)?.controller.fit() ?? null;
  }

  focus(paneId: string): void {
    this.#panes.get(paneId)?.controller.focus();
  }

  /** Stop every pane listening, for when another surface has taken the keyboard. */
  blurAll(): void {
    for (const pane of this.#panes.values()) pane.controller.blur();
  }

  refreshLinks(): void {
    for (const pane of this.#panes.values()) pane.controller.refreshLinks();
  }

  /** Release every renderer, for a tab that has been hidden long enough to stop paying for one. */
  releaseRenderers(): void {
    for (const pane of this.#panes.values()) pane.controller.releaseRenderer();
  }

  restoreRenderers(): void {
    for (const pane of this.#panes.values()) pane.controller.restoreRenderer();
  }

  get renderersAttached(): number {
    return [...this.#panes.values()].filter((p) => p.controller.rendererAttached).length;
  }

  setScrollback(lines: number): void {
    for (const pane of this.#panes.values()) pane.controller.setScrollback(lines);
  }

  /** Dispose panes that are no longer in the layout, so their renderers are released. */
  retain(paneIds: Iterable<string>): void {
    const keep = new Set(paneIds);
    for (const [paneId, pane] of this.#panes) {
      if (keep.has(paneId)) continue;
      this.#byStream.delete(pane.streamId);
      pane.controller.dispose();
      pane.element.remove();
      this.#panes.delete(paneId);
    }
  }

  disposeAll(): void {
    this.retain([]);
  }
}
